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
