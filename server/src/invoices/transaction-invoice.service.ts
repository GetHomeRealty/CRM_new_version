import { Injectable } from '@nestjs/common';
import type { invoices, Prisma } from '@prisma/client';
import { CommissionService } from '../transactions/commission.service';
import { commissionInclude, normalizeCommissionTxn } from '../transactions/commission.loader';
import { AuditService, type ActingUser } from '../audit/audit.service';
import { isInvoiceableType } from '../reference/transaction.constants';
import { round2 } from '../common/serialize';
import { InvoiceCalculator } from './invoice.calculator';
import { InvoiceNumberService } from './invoice.numbers';

type Tx = Prisma.TransactionClient;

/** Generates commission invoice(s) from a transaction (port of TransactionInvoiceService). */
@Injectable()
export class TransactionInvoiceService {
  constructor(
    private readonly numbers: InvoiceNumberService,
    private readonly calc: InvoiceCalculator,
    private readonly commission: CommissionService,
    private readonly audit: AuditService,
  ) {}

  /** Generate within an existing tx. Returns created invoices. */
  async generate(db: Tx, transactionId: number, actor: ActingUser | null, skipIfExists = false): Promise<invoices[]> {
    const t = await db.transactions.findUnique({
      where: { id: transactionId },
      include: { ...commissionInclude, brokerages: { include: { brokerage_agents: { orderBy: { position: 'asc' } } } } },
    });
    if (!t || !isInvoiceableType(t.type)) return [];
    if (skipIfExists && (await db.invoices.count({ where: { transaction_id: transactionId } })) > 0) return [];

    const settings = await db.company_settings.findUnique({ where: { id: 1 } });
    const defaultTerms = settings?.default_terms ?? 'Due on Receipt';
    const defaultTaxRate = Number(settings?.default_tax_rate ?? 13);
    // TD-117 — the configured prefix, read once here with the other settings and passed down,
    // so the Invoice Prefix field in Company Settings describes the invoices it claims to.
    const invoicePrefix = settings?.invoice_prefix ?? undefined;
    const breakdown = await this.commission.breakdown(normalizeCommissionTxn(t));
    const brok = t.brokerages;
    const brokAgents = brok ? brok.brokerage_agents.map((a) => a.name).filter(Boolean).join(', ') : '';

    const created: invoices[] = [];
    if (t.type === 'Preconstruction') {
      const terms = Array.isArray(breakdown.terms) ? (breakdown.terms as Record<string, unknown>[]) : [];
      if (terms.length === 0) {
        const master = breakdown.master as { commission?: number } | undefined;
        created.push(await this.make(db, t, brok, defaultTerms, defaultTaxRate, brokAgents, actor, null, Number(master?.commission ?? 0), invoicePrefix));
      } else {
        for (const term of terms) {
          created.push(await this.make(db, t, brok, defaultTerms, defaultTaxRate, brokAgents, actor, Number(term.term_no), Number(term.commission), invoicePrefix));
        }
      }
    } else {
      created.push(await this.make(db, t, brok, defaultTerms, defaultTaxRate, brokAgents, actor, null, Number((breakdown as { commission?: number }).commission ?? 0), invoicePrefix));
    }

    for (const inv of created) {
      await this.audit.record(transactionId, actor, {
        section: 'Quick Actions — Invoice', field: inv.invoice_no,
        action: 'Invoice generated', source: 'System', new: inv.invoice_no,
      });
    }
    return created;
  }

  /**
   * TD-083 — an invoice that has never been sent follows the deal it bills for.
   *
   * THE INVOICE CONTRADICTED ITSELF, which is worse than being merely stale. `purchase_price` is
   * derived at READ time from the joined deal, so it always shows the current price, while the
   * commission lines are stored columns written once at generation. A deal repriced from 800,000 to
   * 900,000 therefore produced a document stating a purchase price of 900,000 and charging
   * commission worked out on 800,000 — a bill that disproves itself, and anyone can check the
   * arithmetic. Every roll-up built on invoices inherited the error, so the Dashboard's billed and
   * outstanding figures reconciled perfectly to the invoices and were wrong by the same amount.
   *
   * WHY UPDATE RATHER THAN LOCK-AND-CREDIT-NOTE. The entry offers both and says either is
   * defensible; what is not is diverging silently. This is the one that matches what the document
   * already does — the price half is travelling and only the commission half was left behind — and
   * it costs the brokerage nothing, because these invoices have not left the building.
   *
   * WHAT IT WILL NOT TOUCH, and each guard is the difference between a correction and a forgery:
   *   · an invoice that has been SENT keeps its figures. Once it is out, a change is a credit note
   *     and a conversation, not a quiet edit.
   *   · an invoice carrying ANY money — part-paid, Paid, or with reminders already chased — is left
   *     alone for the same reason.
   *   · a Void invoice is not revived.
   *   · only invoices this system generated (`source: 'transaction'`), and within them only the
   *     commission line it wrote. A line somebody added by hand is theirs, and rewriting the whole
   *     invoice from the deal would delete it.
   */
  async refreshFromDeal(db: Tx, transactionId: number, actor: ActingUser | null): Promise<number> {
    const t = await db.transactions.findUnique({
      where: { id: transactionId },
      include: commissionInclude,
    });
    if (!t || !isInvoiceableType(t.type)) return 0;

    const open = await db.invoices.findMany({
      where: {
        transaction_id: transactionId,
        source: 'transaction',
        deleted_at: null,
        sent_at: null,
        status: { notIn: ['Paid', 'Void', 'Partially Paid'] },
      },
      select: { id: true, invoice_no: true, term_no: true, amount_paid: true, tax_rate: true, sub_total: true },
    });
    if (open.length === 0) return 0;

    const settings = await db.company_settings.findUnique({ where: { id: 1 } });
    const defaultTaxRate = Number(settings?.default_tax_rate ?? 13);
    const breakdown = await this.commission.breakdown(normalizeCommissionTxn(t));
    const terms = Array.isArray(breakdown.terms) ? (breakdown.terms as Record<string, unknown>[]) : [];

    /** What this invoice should now be asking for. */
    const commissionFor = (termNo: number | null): number | null => {
      if (termNo === null) return Number((breakdown as { commission?: number }).commission ?? 0);
      const term = terms.find((x) => Number(x.term_no) === termNo);
      // A term that no longer exists is not a figure to guess at — the invoice is left as it is and
      // the divergence stays visible rather than being papered over with a wrong number.
      return term ? Number(term.commission ?? 0) : null;
    };

    let updated = 0;
    for (const inv of open) {
      // Belt and braces beside the `status` filter: a part-payment recorded without moving the
      // status must still stop this.
      if (Number(inv.amount_paid ?? 0) > 0) continue;

      const want = commissionFor(inv.term_no);
      if (want === null) continue;

      const line = await db.invoice_line_items.findFirst({
        where: { invoice_id: inv.id, description: { startsWith: 'Co-op Commission' } },
        orderBy: { row_no: 'asc' },
      });
      if (!line) continue;                                   // hand-built invoice: not ours to rewrite
      if (round2(Number(line.amount ?? 0)) === round2(want)) continue;

      const was = round2(Number(line.amount ?? 0));
      const now = new Date();
      await db.invoice_line_items.update({
        where: { id: line.id },
        data: { rate: round2(want), amount: round2(want), updated_at: now },
      });
      await this.calc.recalculate(db, inv.id, Number(inv.tax_rate ?? defaultTaxRate));
      updated += 1;

      await this.audit.record(transactionId, actor, {
        section: 'Quick Actions — Invoice',
        field: inv.invoice_no,
        action: 'Invoice commission updated',
        source: 'System',
        old: was.toFixed(2),
        new: round2(want).toFixed(2),
        details: 'The deal’s commission changed and this invoice had not been sent.',
      });
    }
    return updated;
  }

  private async make(
    db: Tx,
    t: { id: number; type: string; trade_no: string; property: string | null; agent: string | null; closing_date: Date | null },
    brok: { name: string | null; phone: string | null; invoice_email: string | null; address: string | null } | null,
    defaultTerms: string,
    defaultTaxRate: number,
    brokAgents: string,
    actor: ActingUser | null,
    termNo: number | null,
    commission: number,
    invoicePrefix?: string,
  ): Promise<invoices> {
    const now = new Date();
    const invoiceDate = new Date(now.toISOString().slice(0, 10) + 'T00:00:00.000Z');
    const suffix = termNo ? ` — Term ${termNo}` : '';
    const dueDate = this.dueDate(invoiceDate, defaultTerms, t.closing_date ?? null);

    const invoice = await db.invoices.create({
      data: {
        invoice_no: this.numbers.forTransaction(t.trade_no, termNo, invoicePrefix) ?? (await this.numbers.next(db)),
        transaction_id: t.id,
        source: 'transaction',
        transaction_type: t.type,
        term_no: termNo,
        created_by: actor?.id ?? null,
        property_reference: t.property,
        customer_name: brok?.name ?? null,
        customer_phone: brok?.phone ?? null,
        customer_email: brok?.invoice_email ?? null,
        customer_address: brok?.address ?? null,
        customer_country: 'Canada',
        invoice_date: invoiceDate,
        terms: defaultTerms,
        due_date: dueDate,
        trade_number: t.trade_no,
        listing_agent: brokAgents || null,
        coop_salesperson: t.agent,
        subject: 'Co-op Commission for ' + (t.property ?? '') + suffix,
        status: 'Unpaid',
        created_at: now,
        updated_at: now,
      },
    });

    await db.invoice_line_items.create({
      data: {
        invoice_id: invoice.id,
        row_no: 1,
        description: 'Co-op Commission' + suffix,
        qty: 1,
        rate: round2(commission),
        amount: round2(commission),
        is_taxable: true,
        created_at: now,
        updated_at: now,
      },
    });

    await this.calc.recalculate(db, invoice.id, defaultTaxRate);
    return (await db.invoices.findUnique({ where: { id: invoice.id } })) as invoices;
  }

  private dueDate(invoiceDate: Date, terms: string | null, closing?: Date | null): Date | null {
    // TD-034 - a commission invoice is payable on closing, not on receipt.
    if (terms === 'Due on Closing') return closing ?? null;
    if (!terms || terms === 'Custom') return null;
    const days = InvoiceCalculator.TERM_DAYS[terms];
    if (days === undefined) return null;
    const d = new Date(invoiceDate);
    d.setUTCDate(d.getUTCDate() + days);
    return d;
  }
}
