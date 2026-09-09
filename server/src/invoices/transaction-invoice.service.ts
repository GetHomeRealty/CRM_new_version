import { UnprocessableEntityException } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import type { invoices, Prisma } from '@prisma/client';
import { CommissionService } from '../transactions/commission.service';
import { commissionInclude, normalizeCommissionTxn } from '../transactions/commission.loader';
import { AuditService, type ActingUser } from '../audit/audit.service';
import { isInvoiceableType } from '../reference/transaction.constants';
import { round2 } from '../common/serialize';
import { InvoiceCalculator } from './invoice.calculator';
import { InvoiceNumberService } from './invoice.numbers';
import { invoiceCommissionFrom } from './invoice-commission';

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
      /*
       * TD-157 - A PRECONSTRUCTION DEAL WITH NO TERMS IS BILLED BY NOBODY, SO BILL NOTHING.
       *
       * What stood here raised ONE whole-deal invoice at master.commission, which is 0.00 when
       * the deal has no commission yet - and that invoice then locked the deal out of the only
       * billing route it has, because generateForTransaction refuses to generate while any
       * invoice exists. So a single press of Create Term Invoices, made before the terms were
       * entered, permanently prevented the per-term invoices that press was asking for.
       * ZZ-TEST deal 82 and its GHR-200837 are exactly that, and it is the fixture TD-151 came
       * from.
       *
       * Returning nothing REFUSES rather than guesses, and leaves open the question the
       * fallback was quietly answering: whether a preconstruction deal may ever be invoiced as
       * one whole-deal invoice rather than per term. TD-130 settled that the brokerage bills
       * per term; nobody has been asked about a deal with no terms BY DESIGN. If that case is
       * real, it is an additive change made deliberately rather than a fallback nobody chose.
       */
      /*
       * SECOND PASS, the same day. The guard above caught a deal with NO terms and let through a
       * deal whose terms carry NO MONEY - two rows with a closing date and neither a percentage
       * nor an amount produced two invoices of 0.00 on ZZ-TEST 300009, which is the same
       * worthless-invoice-that-locks-the-deal all over again, one level down.
       *
       * ALL OR NOTHING, and that is not fastidiousness. Billing only the terms that carry a
       * figure would leave the empty ones permanently unbillable, because
       * generateForTransaction refuses while ANY invoice exists. A partial run would trap the
       * remainder exactly as the 0.00 invoice used to trap the whole deal.
       */
      if (terms.length === 0) return [];
      if (!terms.every((t) => Number(t.commission) > 0)) return [];
      for (const term of terms) {
        created.push(await this.make(db, t, brok, defaultTerms, defaultTaxRate, brokAgents, actor, Number(term.term_no), Number(term.commission), invoicePrefix));
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

    /**
     * What this invoice should now be asking for.
     *
     * TD-151 - THE WHOLE-DEAL FIGURE DOES NOT LIVE IN THE SAME PLACE ON EVERY VARIANT, and this was
     * the one reader in the system that never asked which variant it had. breakdownStandard returns
     * a top-level `commission`; breakdownPrecon puts it on `master`, breakdownListing on `totals`.
     * So on a preconstruction or listing deal this evaluated Number(undefined ?? 0) - and zero is
     * not an absent value, it is a number. The line was rewritten to 0.00 by an ordinary save and
     * recalculate() then moved sub_total, tax_total and total down to match: a billing document
     * destroyed by an edit that had nothing to do with it.
     *
     * IT NOW CALLS THE FUNCTION THAT ALREADY ANSWERS THIS, rather than becoming a fourth copy of the
     * same three-line decision. totalCommission() is documented as authoritative per variant; the
     * reports and the payment cache reach the figure through it, the dashboard branches on
     * `variant` itself, and generate() - fifty lines above this - branches too.
     *
     * NOTHING IS GUESSED AND NOTHING IS SILENTLY ZEROED. A term that no longer exists, or one whose
     * commission is not a number, returns null and the invoice is left exactly as it is - an
     * unanswered question is not a figure. The write itself then refuses to take a live line down to
     * zero, which is the guard that covers the whole CLASS rather than this one variant: a figure
     * read from the wrong place, an absent field coerced by `?? 0`, or a variant a later build
     * introduces that this function has never heard of.
     */
    const commissionFor = (termNo: number | null): number | null => invoiceCommissionFrom(breakdown, termNo);

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
      const was = round2(Number(line.amount ?? 0));
      const next = round2(want);
      if (next === was) continue;

      /*
       * TD-151 - AN ORDINARY SAVE DOES NOT WIPE A LIVE BILLING LINE.
       *
       * This is the guard that would have prevented the defect that created it, and it does not
       * depend on anybody having thought of the particular way the figure went missing. On
       * 2026-09-07 at 12:10:59 GHR-200837 went from 26,548.67 to 0.00 on a deal save, because the
       * whole-deal figure was read from a field that does not exist on a preconstruction breakdown
       * and `?? 0` turned that absence into a number. A commission that is honestly zero over a line
       * that is already zero never reaches here - the equality above returns first - so this costs
       * nothing in the honest case and refuses the entire class in the dishonest one.
       *
       * The invoice keeps what it had, and the refusal is recorded where somebody will find it
       * rather than in a log nobody reads.
       */
      if (next === 0 && was !== 0) {
        await this.audit.record(transactionId, actor, {
          section: 'Quick Actions — Invoice',
          field: inv.invoice_no,
          action: 'Invoice commission left unchanged',
          source: 'System',
          old: was.toFixed(2),
          new: was.toFixed(2),
          details: 'The deal produced a commission of 0.00 for this invoice, so it was left at its existing figure rather than zeroed. Check the deal.',
        });
        continue;
      }

      const now = new Date();
      await db.invoice_line_items.update({
        where: { id: line.id },
        data: { rate: next, amount: next, updated_at: now },
      });
      await this.calc.recalculate(db, inv.id, Number(inv.tax_rate ?? defaultTaxRate));
      updated += 1;

      await this.audit.record(transactionId, actor, {
        section: 'Quick Actions — Invoice',
        field: inv.invoice_no,
        action: 'Invoice commission updated',
        source: 'System',
        old: was.toFixed(2),
          new: next.toFixed(2),
        details: 'The deal’s commission changed and this invoice had not been sent.',
      });
    }
    return updated;
  }

  /**
   * TD-146 - what this invoice WOULD be asked to charge if it were rewritten from its deal now.
   *
   * Reads nothing but the deal and writes nothing at all, so it can be called from a presenter. It
   * exists because refreshFromDeal correctly DECLINES to touch a sent, paid or hand-built invoice
   * and, until now, declined silently: the figure it had just computed was thrown away at the
   * moment it was most worth reporting. A sent invoice must not move - that is TD-083 - but the
   * brokerage has to be told when its deal has moved away from it.
   */
  async expectedFor(db: Tx, transactionId: number, termNo: number | null): Promise<number | null> {
    const t = await db.transactions.findUnique({ where: { id: transactionId }, include: commissionInclude });
    if (!t || !isInvoiceableType(t.type)) return null;
    const breakdown = await this.commission.breakdown(normalizeCommissionTxn(t));
    return invoiceCommissionFrom(breakdown, termNo);
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

    const invoiceNo = this.numbers.forTransaction(t.trade_no, termNo, invoicePrefix) ?? (await this.numbers.next(db));
    const holder = await db.invoices.findFirst({ where: { invoice_no: invoiceNo } });
    if (holder) {
      const held = await db.invoice_payments.count({ where: { invoice_id: holder.id } });
      if (holder.deleted_at === null || holder.transaction_id !== t.id
          || holder.sent_at !== null || Number(holder.amount_paid) > 0 || held > 0) {
        const m = 'Invoice ' + invoiceNo + ' is already in use and cannot be reissued for this deal.';
        throw new UnprocessableEntityException({ message: m, errors: { id: [m] } });
      }
      await db.invoice_line_items.deleteMany({ where: { invoice_id: holder.id } });
    }
    const data = {
        invoice_no: invoiceNo,
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
    };
    /*
     * TD-161 - REISSUE THE NUMBER SAFELY INSTEAD OF THROWING A 500.
     *
     * invoice_no is @unique across the whole table INCLUDING soft-deleted rows, and the number
     * is deterministic, so deleting an invoice used to burn its number for ever: regenerating
     * threw an unhandled Unique constraint failure straight through to the user as Internal
     * server error.
     *
     * THE CHECK LIVES HERE, NOT IN THE CALLER. generate() is reached from deal creation as well
     * as from Create Term Invoices, and only one of those callers could be guarded. It also
     * matches on invoice_no, which is the column the constraint is on - matching on
     * transaction_id would miss an orphaned invoice, and one such row exists carrying 22,600.00
     * of recorded payment.
     *
     * THE UPDATE IS A COMPARE-AND-SWAP because the unique index used to be what serialised two
     * simultaneous presses: one won, one got a 500. An update by id raises no unique violation,
     * so without `deleted_at: { not: null }` in the WHERE both writers would resurrect the same
     * row and both add a line item - one invoice, two Co-op Commission rows, double the money.
     * The second writer now matches zero rows and is told to try again.
     */
    let invoice: invoices;
    if (holder) {
      const { created_at: _ignored, ...rest } = data;
      const swap = await db.invoices.updateMany({
        where: { id: holder.id, deleted_at: { not: null } },
        data: { ...rest, deleted_at: null, delete_reason: null, amount_paid: 0, sent_at: null },
      });
      if (swap.count === 0) {
        const m = 'Invoice ' + invoiceNo + ' is being generated by another request. Refresh and try again.';
        throw new UnprocessableEntityException({ message: m, errors: { id: [m] } });
      }
      invoice = await db.invoices.findUniqueOrThrow({ where: { id: holder.id } });
      await this.audit.record(t.id, actor, {
        section: 'Quick Actions - Invoice', field: invoiceNo, action: 'Invoice reissued', source: 'System',
        details: 'Reissued over a deleted invoice of the same number. Its deletion reason was: ' + (holder.delete_reason ?? 'not given'),
      });
    } else {
      invoice = await db.invoices.create({ data });
    }

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
