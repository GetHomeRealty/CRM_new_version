import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CompanySettingsService } from '../settings/company-settings.service';
import { MailerService, type MailAttachment } from '../email/mailer.service';
import { AuditService, type ActingUser } from '../audit/audit.service';
import { throwValidation } from '../common/laravel-exceptions';
import { jsonField, phpJsonNormalize, round2, toDateString, toDateTimeString, toIso8601String } from '../common/serialize';
import { INVOICEABLE_TYPES, isInvoiceableType } from '../reference/transaction.constants';
import {
  INVOICE_STATUSES, INVOICE_TERMS, MAX_TAX_RATE, SETTABLE_STATUSES,
  invoiceDisplayStatus, isDerivedStatus, isInvoiceStatus, isInvoiceTerm,
} from '../reference/invoice.constants';
import { InvoiceCalculator } from './invoice.calculator';
import { InvoiceNumberService } from './invoice.numbers';
import { TransactionInvoiceService } from './transaction-invoice.service';

const num = (d: Prisma.Decimal | number | null): number => (d === null ? 0 : Number(d));

/** Invoices per page. The screen asks for 25; 200 is the ceiling a caller may raise it to. */
const PER_PAGE_DEFAULT = 25;
const PER_PAGE_MAX = 200;

/**
 * The columns a LIST ROW needs from the linked deal — which is one date.
 *
 * `include: { transactions: true }` pulled every column of the transaction onto every invoice row:
 * the adjustments and admin-activities blobs, all the lawyer and builder fields, the whole
 * commission configuration. `summary()` reads `closing_date` and `deleted_at` from it and nothing
 * else. At 22,857 invoices that was most of a nine-megabyte response.
 */
const TXN_FOR_SUMMARY = { select: { closing_date: true, deleted_at: true } } as const;

/** What `summary()` reads: the invoice row plus the two transaction columns above (or none). */
type InvoiceSummaryRow = Prisma.invoicesGetPayload<object> & {
  transactions: { closing_date: Date | null; deleted_at: Date | null } | null;
};

/** One page of invoices, with the ledger-wide figures the tiles show. */
export interface InvoiceListPage {
  data: Record<string, unknown>[];
  meta: { current_page: number; per_page: number; last_page: number; total: number };
  /**
   * COMPUTED OVER THE WHOLE LEDGER, not the page and not the filter — the three tiles above the
   * table have always described every invoice, and paging the table must not quietly redefine them.
   */
  totals: { count: number; outstanding: number; paid_count: number };
}

/** Query accepted by the paginated list. */
export interface InvoiceListQuery {
  page?: number;
  per_page?: number;
  /** One of the DISPLAY statuses, including the derived `Overdue`. */
  status?: string;
}
type InvoiceDetailRow = Prisma.invoicesGetPayload<{
  include: {
    customers: true;
    invoice_line_items: true;
    invoice_payments: true;
    transactions: { include: { brokerages: { include: { brokerage_agents: true } } } };
  };
}>;

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: CompanySettingsService,
    private readonly calc: InvoiceCalculator,
    private readonly numbers: InvoiceNumberService,
    private readonly audit: AuditService,
    private readonly txnInvoices: TransactionInvoiceService,
    private readonly mailer: MailerService,
  ) {}

  /**
   * One page of the invoice ledger, plus the three ledger-wide figures the tiles show.
   *
   * WHAT THIS REPLACES. Every invoice, in one array, with `customers` and the ENTIRE linked
   * transaction attached to each. Measured at 22,857 invoices: 9.0 MB in one response, 2.8 s single
   * user, 8.3 s median under a hundred concurrent — the largest payload in the Transaction Desk. The
   * screen then filtered and rendered it in the browser, so every byte past the first twenty-five
   * rows was parsed and discarded.
   *
   * Three things were wrong and all three are fixed here:
   *
   *   · IT RETURNED EVERYTHING. It now returns the requested page.
   *   · IT LOADED `customers` FOR NOTHING. `summary()` does not read that relation — not one field.
   *   · IT LOADED THE WHOLE TRANSACTION for one date. `TXN_FOR_SUMMARY` selects the two columns
   *     actually read.
   *
   * THE TILES DO NOT CHANGE MEANING. Invoice count, outstanding balance and paid count have always
   * described the whole ledger rather than the visible rows, so they are computed by three
   * aggregates over the whole ledger rather than by summing an array that happens to hold all of it.
   * The status filter narrows the TABLE, exactly as the client-side filter did, and never the tiles.
   */
  async index(query: InvoiceListQuery = {}): Promise<InvoiceListPage> {
    const page = Math.max(1, Number(query.page ?? 1) || 1);
    const perPage = Math.min(PER_PAGE_MAX, Math.max(1, Number(query.per_page ?? PER_PAGE_DEFAULT) || PER_PAGE_DEFAULT));

    const where: Prisma.invoicesWhereInput = { deleted_at: null, ...this.displayStatusWhere(query.status) };

    const [total, rows, ledger, paidCount] = await Promise.all([
      this.prisma.invoices.count({ where }),
      this.prisma.invoices.findMany({
        where,
        orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * perPage,
        take: perPage,
        include: { transactions: TXN_FOR_SUMMARY },
      }),
      this.prisma.invoices.aggregate({
        where: { deleted_at: null },
        _count: { _all: true },
        _sum: { balance_due: true },
      }),
      this.prisma.invoices.count({ where: { deleted_at: null, status: 'Paid' } }),
    ]);

    return {
      data: rows.map((i) => this.summary(i)),
      meta: { current_page: page, per_page: perPage, last_page: Math.max(1, Math.ceil(total / perPage)), total },
      totals: {
        count: ledger._count._all,
        outstanding: round2(num(ledger._sum.balance_due)),
        paid_count: paidCount,
      },
    };
  }

  /**
   * A DISPLAY status as a query predicate — including `Overdue`, which is derived and not stored.
   *
   * `displayStatus()` below reports Overdue for an Unpaid or Partially Paid invoice past its due
   * date with a balance outstanding. Filtering used to happen in the browser against that derived
   * value, so moving the filter into the database means spelling the same rule as SQL — and, just as
   * importantly, spelling its INVERSE: asking for "Unpaid" must not return the unpaid invoices that
   * the screen is displaying as Overdue, which is exactly what a bare `status = 'Unpaid'` would do.
   */
  private displayStatusWhere(status: string | undefined): Prisma.invoicesWhereInput {
    const want = (status ?? '').trim();
    if (want === '') return {};

    const overdue: Prisma.invoicesWhereInput = {
      status: { in: ['Unpaid', 'Partially Paid'] },
      due_date: { lt: new Date() },
      balance_due: { gt: 0 },
    };
    if (want === 'Overdue') return overdue;
    // The two statuses that can be displayed as something else must exclude that case.
    if (want === 'Unpaid' || want === 'Partially Paid') return { status: want, NOT: overdue };
    return { status: want };
  }

  async show(id: number): Promise<Record<string, unknown>> {
    const inv = await this.prisma.invoices.findFirst({
      where: { id, deleted_at: null },
      include: {
        customers: true,
        invoice_line_items: { orderBy: { row_no: 'asc' } },
        invoice_payments: { orderBy: { paid_on: 'asc' } },
        transactions: { include: { brokerages: { include: { brokerage_agents: { orderBy: { position: 'asc' } } } } } },
      },
    });
    if (!inv) throw new NotFoundException({ message: `No query results for model [App\\Models\\Invoice] ${id}.` });
    return this.detail(inv);
  }

  /*
   * TD-048 — the derivation moved to `reference/invoice.constants`, unchanged.
   *
   * It lived here as a private method, so the transaction's Admin Activities panel — which reads
   * the invoice through `transaction.resource.ts` — could not use it and answered the question its
   * own way. Two derivations, two answers, one invoice. There is now one, and both call it.
   */
  private displayStatus(i: { status: string; due_date: Date | null; balance_due: Prisma.Decimal | number }): string {
    return invoiceDisplayStatus(i);
  }

  // Laravel's belongsTo auto-excludes soft-deleted models, so a trashed linked
  // transaction resolves to null (Prisma's include returns it regardless).
  private activeTxn<T extends { deleted_at: Date | null }>(txn: T | null): T | null {
    return txn && txn.deleted_at === null ? txn : null;
  }

  private summary(i: InvoiceSummaryRow): Record<string, unknown> {
    const txn = this.activeTxn(i.transactions);
    return {
      id: i.id,
      invoice_no: i.invoice_no,
      customer_name: i.customer_name,
      property_reference: i.property_reference,
      invoice_date: toDateString(i.invoice_date),
      due_date: toDateString(i.due_date),
      total: num(i.total),
      amount_paid: num(i.amount_paid),
      balance_due: num(i.balance_due),
      status: i.status,
      display_status: this.displayStatus(i),
      sent_at: toIso8601String(i.sent_at),
      source: i.source ?? 'manual',
      transaction_id: i.transaction_id,
      transaction_type: i.transaction_type,
      trade_number: i.trade_number,
      listing_agent: i.listing_agent,
      closing_date: toDateString(txn?.closing_date ?? null),
    };
  }

  private async detail(i: InvoiceDetailRow): Promise<Record<string, unknown>> {
    const s = await this.settings.current();
    const txn = this.activeTxn(i.transactions);
    const brok = txn?.brokerages ?? null;
    const brokAgents = brok ? brok.brokerage_agents.map((a) => a.name).filter(Boolean).join(', ') : null;

    return {
      ...this.summary(i),
      transaction_id: i.transaction_id,
      purchase_price: i.transaction_id ? num(txn?.price ?? 0) : null,
      customer_id: i.customer_id,
      customer_name: i.customer_name || (brok?.name ?? null),
      customer_phone: i.customer_phone || (brok?.phone ?? null),
      customer_email: i.customer_email || (brok?.invoice_email ?? null),
      customer_address: i.customer_address || (brok?.address ?? null),
      coop_salesperson: (txn?.agent ?? null) || i.coop_salesperson,
      listing_agent: txn ? brokAgents || null : i.listing_agent,
      customer_city: i.customer_city,
      customer_province: i.customer_province,
      customer_postal_code: i.customer_postal_code,
      customer_country: i.customer_country,
      discount: num(i.discount),
      tax_rate: i.tax_rate !== null ? num(i.tax_rate) : null,
      customer_notes: i.customer_notes,
      terms_conditions: i.terms_conditions,
      signature_path: i.signature_path,
      broker_name: i.broker_name,
      commission_received_date: toDateString(i.commission_received_date),
      commission_received_via: i.commission_received_via,
      reminders: jsonField(i.reminders) ?? [],
      auto_reminder: jsonField(i.auto_reminder),
      terms: i.terms,
      trade_number: i.trade_number,
      subject: i.subject,
      sub_total: num(i.sub_total),
      tax_total: num(i.tax_total),
      line_items: i.invoice_line_items.map((l) => ({
        id: l.id,
        row_no: l.row_no,
        description: l.description,
        qty: num(l.qty),
        rate: num(l.rate),
        amount: num(l.amount),
        is_taxable: l.is_taxable,
      })),
      payments: i.invoice_payments.map((p) => ({
        id: p.id,
        paid_on: toDateString(p.paid_on),
        amount: num(p.amount),
        method: p.method,
        reference: p.reference,
      })),
      company: {
        name: s.name,
        address: s.address,
        phone: s.phone,
        email: s.email,
        hst_number: s.hst_number,
        bank_beneficiary: s.bank_beneficiary,
        bank_name: s.bank_name,
        transit_no: s.transit_no,
        account_no: s.account_no,
        institution_no: s.institution_no,
        currency: s.currency,
        tax_rate: num(s.default_tax_rate),
        thank_you_note: s.thank_you_note,
        deposit_heading: s.deposit_heading,
      },
    };
  }

  // ---- writes -------------------------------------------------------------
  async store(actor: ActingUser | null, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    // TD-004 — replaces the two presence checks that were the whole of this endpoint's validation.
    // The required-field messages they produced are still emitted, now alongside the rest.
    this.validateInvoiceInput(body, this.lineSubTotal(this.asArray(body.line_items)));
    const settings = await this.settings.current();
    const now = new Date();

    const inv = await this.prisma.$transaction(async (tx) => {
      const created = await tx.invoices.create({
        data: {
          ...(this.mapFields(body, settings, 'create') as Prisma.invoicesCreateInput),
          invoice_no: await this.numbers.next(tx),
          source: 'manual',
          created_by: actor?.id ?? null,
          created_at: now,
          updated_at: now,
        },
      });
      await this.syncLines(tx, created.id, this.asArray(body.line_items));
      await this.calc.recalculate(tx, created.id, this.rate(created.tax_rate, settings.default_tax_rate));
      return created;
    });

    await this.auditInvoice(inv.id, inv.transaction_id, actor, { field: inv.invoice_no, action: 'Invoice created', new: inv.invoice_no });
    return this.show(inv.id);
  }

  async update(actor: ActingUser | null, id: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const invoice = await this.prisma.invoices.findFirst({ where: { id, deleted_at: null } });
    if (!invoice) throw new NotFoundException({ message: `No query results for model [App\\Models\\Invoice] ${id}.` });
    /*
     * TD-004 — the sub-total a discount is judged against comes from whichever lines this save will
     * leave on the invoice: the submitted ones when `line_items` is present, the stored ones when it
     * is not. `mapFields` writes the discount either way, so validating only the submitted case
     * would leave an edit that changes the discount alone — the smallest possible request — as the
     * one that could still drive the total negative.
     */
    const subTotal = Object.prototype.hasOwnProperty.call(body, 'line_items')
      ? this.lineSubTotal(this.asArray(body.line_items))
      : num(invoice.sub_total);
    this.validateInvoiceInput(body, subTotal, invoice);
    const settings = await this.settings.current();
    const oldStatus = invoice.status;

    await this.prisma.$transaction(async (tx) => {
      await tx.invoices.update({ where: { id }, data: { ...(this.mapFields(body, settings, 'update') as Prisma.invoicesUpdateInput), updated_at: new Date() } });
      if (Object.prototype.hasOwnProperty.call(body, 'line_items')) await this.syncLines(tx, id, this.asArray(body.line_items));
      const cur = await tx.invoices.findUnique({ where: { id }, select: { tax_rate: true } });
      await this.calc.recalculate(tx, id, this.rate(cur?.tax_rate ?? null, settings.default_tax_rate));
    });

    const updated = await this.prisma.invoices.findUniqueOrThrow({ where: { id } });
    const no = updated.invoice_no;
    if (oldStatus !== updated.status) {
      await this.auditInvoice(id, updated.transaction_id, actor, { field: `Invoice ${no} — Status`, action: 'Status changed', old: oldStatus, new: updated.status });
    } else {
      await this.auditInvoice(id, updated.transaction_id, actor, { field: `Invoice ${no}`, action: 'Invoice updated' });
    }
    return this.show(id);
  }

  async destroy(actor: ActingUser | null, id: number, reason: string | null): Promise<{ message: string }> {
    const invoice = await this.prisma.invoices.findFirst({ where: { id, deleted_at: null } });
    if (!invoice) throw new NotFoundException({ message: `No query results for model [App\\Models\\Invoice] ${id}.` });
    const r = (reason ?? '').trim() || null;
    await this.auditInvoice(id, invoice.transaction_id, actor, { field: invoice.invoice_no, action: 'Invoice deleted', old: invoice.invoice_no, details: r });
    await this.prisma.invoices.update({ where: { id }, data: { delete_reason: r, deleted_at: new Date() } });
    return { message: 'Invoice deleted' };
  }

  async recordPayment(actor: ActingUser | null, id: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const invoice = await this.prisma.invoices.findFirst({ where: { id, deleted_at: null } });
    if (!invoice) throw new NotFoundException({ message: `No query results for model [App\\Models\\Invoice] ${id}.` });
    this.requireField(body, 'paid_on');
    const amount = Number(body.amount);
    const method = (body.method ?? null) as string | null;
    const now = new Date();
    await this.prisma.invoice_payments.create({
      data: { invoice_id: id, paid_on: this.toDate(body.paid_on)!, amount, method, reference: (body.reference ?? null) as string | null, created_at: now, updated_at: now },
    });
    const settings = await this.settings.current();
    await this.calc.recalculate(this.prisma, id, this.rate(invoice.tax_rate, settings.default_tax_rate));
    let updated = await this.prisma.invoices.findUniqueOrThrow({ where: { id } });

    /*
     * TD-106 - a payment that settles the invoice records WHEN the commission arrived and HOW.
     *
     * recordPayment moved the money (status, amount_paid, balance) and left commission_received_date
     * and commission_received_via null, so the deal's Admin block - which derives them from this
     * invoice and is read-only by design - had nothing to show, and the agent-payout block read the
     * empty date as 'nothing collected' (TD-107). The manual route (the full invoice save) exists
     * but demands the whole form; nothing wrote them on payment, which is when they are actually
     * known. Set only when the invoice is now fully Paid, and only if not already recorded, so a
     * later part-payment or a manual value is never overwritten. The date is the payment's own
     * paid_on and the method its own method.
     */
    if (updated.status === 'Paid' && !updated.commission_received_date) {
      updated = await this.prisma.invoices.update({
        where: { id },
        data: { commission_received_date: this.toDate(body.paid_on), commission_received_via: method, updated_at: new Date() },
      });
    }

    await this.auditInvoice(id, updated.transaction_id, actor, {
      field: `Invoice ${updated.invoice_no} — Payment`, action: 'Payment recorded',
      new: this.numberFormat(amount) + (method ? ` (${method})` : ''),
    });
    return this.show(id);
  }

  async deletePayment(actor: ActingUser | null, id: number, paymentId: number): Promise<Record<string, unknown>> {
    const invoice = await this.prisma.invoices.findFirst({ where: { id, deleted_at: null } });
    if (!invoice) throw new NotFoundException({ message: `No query results for model [App\\Models\\Invoice] ${id}.` });
    await this.prisma.invoice_payments.deleteMany({ where: { id: paymentId, invoice_id: id } });
    const settings = await this.settings.current();
    await this.calc.recalculate(this.prisma, id, this.rate(invoice.tax_rate, settings.default_tax_rate));
    const updated = await this.prisma.invoices.findUniqueOrThrow({ where: { id } });
    await this.auditInvoice(id, updated.transaction_id, actor, { field: `Invoice ${updated.invoice_no} — Payment`, action: 'Payment removed' });
    return this.show(id);
  }

  /**
   * Chase payment on an invoice — the email FIRST, the record of it second.
   *
   * Same ordering rule as `send` below and for the same reason: "Reminder sent" is a claim about
   * the outside world. The reminder log is what the office reads when deciding whether to telephone
   * somebody, so an entry recording a message nobody received is worse than no entry at all.
   */
  async recordReminder(actor: ActingUser | null, id: number, pdf: MailAttachment | null = null, at: Date = new Date()): Promise<Record<string, unknown>> {
    const invoice = await this.prisma.invoices.findFirst({ where: { id, deleted_at: null } });
    if (!invoice) throw new NotFoundException({ message: `No query results for model [App\\Models\\Invoice] ${id}.` });

    const to = await this.deliver('invoice.reminder', invoice, 'reminder', pdf);

    /*
     * `at` DEFAULTS TO NOW AND IS PASSED BY THE AUTO-REMINDER SWEEP.
     *
     * The sweep decides an invoice is due by comparing today against this history, then calls here
     * to record the send. If the two read the clock separately they can disagree: a pass that starts
     * at 23:59:59 and records at 00:00:01 writes a history entry for a different day than the one it
     * evaluated, and the next pass — seeing nothing for "today" — sends again. One timestamp, chosen
     * by the caller, closes that window. A person pressing Send gets `new Date()` exactly as before.
     */
    const reminders = ((jsonField(invoice.reminders) as unknown[]) ?? []) as Record<string, unknown>[];
    reminders.push({ date: toDateTimeString(at), by: actor?.name ?? null, to });
    await this.prisma.invoices.update({ where: { id }, data: { reminders: JSON.stringify(phpJsonNormalize(reminders)), updated_at: new Date() } });
    const updated = await this.prisma.invoices.findUniqueOrThrow({ where: { id } });
    await this.auditInvoice(id, updated.transaction_id, actor, { field: `Invoice ${updated.invoice_no} — Reminder`, action: 'Reminder sent', new: `Reminder #${reminders.length}`, details: `Emailed to ${to}` });
    return this.show(id);
  }

  /**
   * Issue the invoice to the customer.
   *
   * THE EMAIL IS SENT BEFORE ANYTHING IS RECORDED, and that ordering is the whole fix. This method
   * used to stamp `sent_at`, write "Invoice sent" to the audit trail, answer 200 — and then call
   * `emailInvoice()`, a method with an empty body. Nothing was ever sent. The screen said "Sent",
   * the deal said "Sent", the audit trail said an administrator sent it on a date, and the
   * Transaction Desk Triggers page listed `invoice.send` as a live trigger. The customer had never
   * heard of it. Every one of those was a record of something that did not happen.
   *
   * `MailerService.send` throws unless the message was accepted by the SMTP server, so the writes
   * below are only reached on success. On failure nothing is stamped, nothing is audited, the
   * invoice is untouched, and the caller gets a message naming the reason — so pressing Send again
   * is a safe and obvious thing to do.
   *
   * RESENDING IS ALLOWED and deliberately does not move `sent_at`: the date on the record is when
   * the invoice was first issued, which is what the customer's copy is dated and what the payment
   * terms run from. Each later send is its own audit entry instead.
   */
  async send(actor: ActingUser | null, id: number, pdf: MailAttachment | null = null): Promise<Record<string, unknown>> {
    const invoice = await this.prisma.invoices.findFirst({ where: { id, deleted_at: null } });
    if (!invoice) throw new NotFoundException({ message: `No query results for model [App\\Models\\Invoice] ${id}.` });

    const to = await this.deliver('invoice.send', invoice, 'invoice', pdf);

    const resend = !!invoice.sent_at;
    if (!resend) await this.prisma.invoices.update({ where: { id }, data: { sent_at: new Date(), updated_at: new Date() } });
    const updated = await this.prisma.invoices.findUniqueOrThrow({ where: { id } });
    await this.auditInvoice(id, updated.transaction_id, actor, {
      field: updated.invoice_no,
      action: resend ? 'Invoice resent' : 'Invoice sent',
      new: toDateString(updated.sent_at),
      details: `Emailed to ${to}`,
    });
    return this.show(id);
  }

  async generateForTransaction(actor: ActingUser | null, txnId: number): Promise<Record<string, unknown>> {
    const t = await this.prisma.transactions.findFirst({ where: { id: txnId, deleted_at: null } });
    if (!t) throw new NotFoundException({ message: `No query results for model [App\\Models\\Transaction] ${txnId}.` });
    if (!isInvoiceableType(t.type)) {
      throw new UnprocessableEntityException({ message: 'Invoices can only be generated for: ' + INVOICEABLE_TYPES.join(', ') + '.' });
    }
    const existing = await this.prisma.invoices.findMany({ where: { transaction_id: txnId, deleted_at: null }, include: { transactions: TXN_FOR_SUMMARY } });
    if (existing.length > 0) {
      return { count: 0, existing: true, invoices: existing.map((i) => this.summary(i)) };
    }
    const created = await this.prisma.$transaction((tx) => this.txnInvoices.generate(tx, txnId, actor, false));
    const withTxn = await this.prisma.invoices.findMany({ where: { id: { in: created.map((c) => c.id) } }, orderBy: { id: 'asc' }, include: { transactions: TXN_FOR_SUMMARY } });
    return { count: created.length, existing: false, invoices: withTxn.map((i) => this.summary(i)) };
  }

  // ---- write helpers ------------------------------------------------------
  private async auditInvoice(invoiceId: number, transactionId: number | null, actor: ActingUser | null, a: { field?: string | null; action?: string; old?: unknown; new?: unknown; details?: string | null; source?: string }): Promise<void> {
    void invoiceId;
    const entry = { ...a, section: 'Quick Actions — Invoice', source: a.source ?? 'Quick Action' };
    await this.audit.logModule(actor, 'Invoice', entry);
    if (transactionId) {
      const txn = await this.prisma.transactions.findFirst({ where: { id: transactionId, deleted_at: null }, select: { id: true } });
      if (txn) await this.audit.record(transactionId, actor, entry);
    }
  }

  /**
   * Send one of the invoice emails, and refuse the operation if it cannot be sent.
   *
   * NOT BEST-EFFORT, unlike most mail in this application. A document reminder or a review
   * notification is a courtesy: losing one is a nuisance and the underlying record is true either
   * way. An invoice email IS the act — "sent" is a fact about the customer, it starts the payment
   * terms, and it is what the office points at when chasing. So a failure fails the request rather
   * than being swallowed, and the caller is told which of the three things went wrong: no
   * recipient, no active template or sender, or the send itself.
   *
   * `MAIL_REDIRECT_TO` diverts the message exactly as the reminder sweeps and the review ladder
   * honour it, so a staging environment cannot mail a real client. The address the invoice WOULD
   * have gone to is still what gets audited.
   */
  private async deliver(
    event: 'invoice.send' | 'invoice.reminder',
    invoice: { invoice_no: string; total: Prisma.Decimal | number; due_date: Date | null; customer_name: string | null; customer_email: string | null; trade_number: string | null; transaction_id: number | null },
    what: 'invoice' | 'reminder',
    pdf: MailAttachment | null,
  ): Promise<string> {
    const to = await this.recipientFor(invoice);
    if (!to) {
      throw new UnprocessableEntityException({
        message: `There is no email address on invoice ${invoice.invoice_no} to send the ${what} to. `
          + 'Add a customer email, or set the co-operating brokerage\'s invoice email on the transaction.',
        errors: { customer_email: ['An email address is required to send.'] },
      });
    }

    const settings = await this.settings.current();
    const vars = {
      invoice_number: invoice.invoice_no,
      invoice_total: this.numberFormat(num(invoice.total)),
      due_date: toDateString(invoice.due_date) ?? '-',
      customer_name: invoice.customer_name ?? 'there',
      transaction_number: invoice.trade_number ?? '-',
      company_name: settings.name,
    };

    const redirect = (process.env.MAIL_REDIRECT_TO ?? '').trim();
    try {
      await this.mailer.send(event, vars, redirect || to, [], pdf ? [pdf] : []);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new UnprocessableEntityException({
        message: `Invoice ${invoice.invoice_no} was NOT sent: ${reason}`,
        errors: { send: [reason] },
      });
    }
    return to;
  }

  /**
   * Who the invoice goes to: its own customer email, or the co-operating brokerage's invoice email
   * from the transaction it was generated from.
   *
   * The fallback matters because a transaction-generated invoice copies the brokerage's details at
   * the moment it is created — so if the brokerage was filled in afterwards, the invoice's own copy
   * is blank while the deal has the address. Reading through to the deal means nobody has to retype
   * something the system already knows.
   */
  private async recipientFor(invoice: { customer_email: string | null; transaction_id: number | null }): Promise<string | null> {
    const own = (invoice.customer_email ?? '').trim();
    if (own) return own;
    if (!invoice.transaction_id) return null;
    const brokerage = await this.prisma.brokerages.findUnique({
      where: { transaction_id: invoice.transaction_id },
      select: { invoice_email: true, email: true },
    });
    return (brokerage?.invoice_email ?? '').trim() || (brokerage?.email ?? '').trim() || null;
  }

  /**
   * TD-006 — a field the caller did not mention is LEFT ALONE on update, not blanked.
   *
   * Every column here was written unconditionally, with `?? null` / `?? 'Canada'` / `?? 'Draft'`
   * supplying a value whenever the body did not. On a create that is right — the row is being
   * established and an unmentioned column genuinely has no value. On an UPDATE it meant a PUT
   * carrying `invoice_date`, `terms` and `line_items` — the three the endpoint demands — wiped
   * `customer_name`, `customer_email`, `subject`, `trade_number` and `listing_agent` to NULL, reset
   * the discount to 0, forced the country back to 'Canada', and forced `status` to 'Draft', which
   * silently UN-VOIDS a voided invoice.
   *
   * `mode` is what separates the two. On 'update' a key absent from the body is omitted from the
   * result, so Prisma does not name that column in the UPDATE at all. An explicitly sent `null`
   * still clears — "absent" and "sent as empty" are different requests and now read differently.
   *
   * TD-093 ALREADY FOUND THIS, for one column. Its comment observes that "every other field here
   * follows that same absent-means-clear rule" and carves `tax_rate` out of it. That carve-out is
   * now the rule and the note below is kept for the reasoning specific to the rate.
   *
   * Latent through the UI, which spreads the whole form on every save, so this was only ever
   * reachable by an API consumer, an integration, or a future partial-save on the screen.
   * `TransactionsWriteService.update` has always done it this way; invoices now match.
   */
  private mapFields(
    data: Record<string, unknown>,
    settings: { default_tax_rate: Prisma.Decimal | number },
    mode: 'create' | 'update',
  ): Record<string, unknown> {
    void settings;
    const sent = (k: string): boolean => Object.prototype.hasOwnProperty.call(data, k);
    /** Write this column when creating, or when the caller actually mentioned it. */
    const writing = (k: string): boolean => mode === 'create' || sent(k);

    const out: Record<string, unknown> = {};
    const put = (k: string, value: unknown): void => { if (writing(k)) out[k] = value; };

    // Both are required by `validateInvoiceInput` on either path, so they are always present.
    const invoiceDate = this.toDate(data.invoice_date)!;
    const terms = String(data.terms);
    out.invoice_date = invoiceDate;
    out.terms = terms;

    /*
     * The due date follows the terms, EXCEPT for the two that cannot compute one.
     *
     * 'Net 30' and friends derive it from the invoice date, so a save that sets the terms has
     * necessarily decided the due date too and it is recomputed. 'Custom' and 'Due on Closing'
     * take it from the body — so if the body did not carry one, there is nothing to recompute
     * FROM, and writing the null `dueDate()` returns would erase a date that is still correct.
     */
    const computesDueDate = InvoiceCalculator.TERM_DAYS[terms] !== undefined;
    if (mode === 'create' || computesDueDate || sent('due_date')) {
      out.due_date = this.dueDate(invoiceDate, terms, (data.due_date ?? null) as string | null);
    }

    for (const k of [
      'transaction_id', 'property_reference', 'customer_id', 'customer_name', 'customer_address',
      'customer_city', 'customer_province', 'customer_postal_code', 'trade_number', 'listing_agent',
      'coop_salesperson', 'subject', 'customer_phone', 'customer_email', 'customer_notes',
      'terms_conditions', 'signature_path', 'broker_name', 'commission_received_via',
    ]) {
      put(k, data[k] ?? null);
    }

    // The three defaults that belong to a NEW invoice and must not be re-imposed on an old one.
    put('customer_country', data.customer_country ?? 'Canada');
    put('discount', data.discount ?? 0);
    put('status', data.status ?? 'Draft');

    put('commission_received_date', this.toDate(data.commission_received_date));
    put('auto_reminder', data.auto_reminder !== undefined && data.auto_reminder !== null
      ? JSON.stringify(phpJsonNormalize(data.auto_reminder))
      : null);

    /*
     * TD-093 — `undefined` when the caller sends nothing, so Prisma leaves the column alone.
     *
     * The rate needs more than the absent-means-leave-alone rule above, because an EXPLICIT null is
     * not a request to clear it either: `this.rate(null, default)` below would fall back to whatever
     * the CURRENT company default is, and the invoice would be silently restated at a rate it was
     * never raised at. Changing `default_tax_rate` and then touching an old invoice would have
     * rewritten its tax.
     *
     * Clearing it is not offered because it is no longer a field anyone fills in: `recalculate`
     * always records the rate it applied. An explicit value still wins, so a deliberate override
     * works as before.
     */
    if (data.tax_rate !== undefined && data.tax_rate !== null && data.tax_rate !== '') {
      out.tax_rate = Number(data.tax_rate);
    }

    return out;
  }

  private dueDate(invoiceDate: Date, terms: string, custom: string | null): Date | null {
    if (terms === 'Custom' || terms === 'Due on Closing') return custom ? this.toDate(custom) : null;
    const days = InvoiceCalculator.TERM_DAYS[terms];
    if (days !== undefined) {
      const d = new Date(invoiceDate);
      d.setUTCDate(d.getUTCDate() + days);
      return d;
    }
    return custom ? this.toDate(custom) : null;
  }

  private async syncLines(tx: Prisma.TransactionClient, invoiceId: number, items: Record<string, unknown>[]): Promise<void> {
    await tx.invoice_line_items.deleteMany({ where: { invoice_id: invoiceId } });
    const now = new Date();
    let i = 0;
    for (const it of items) {
      const qty = Number(it.qty ?? 1);
      const rate = Number(it.rate ?? 0);
      await tx.invoice_line_items.create({
        data: { invoice_id: invoiceId, row_no: i + 1, description: String(it.description ?? ''), qty, rate, amount: round2(qty * rate), is_taxable: (it.is_taxable ?? true) as boolean, created_at: now, updated_at: now },
      });
      i++;
    }
  }

  private rate(taxRate: Prisma.Decimal | number | null, defaultRate: Prisma.Decimal | number): number {
    return Number(taxRate ?? defaultRate);
  }
  private toDate(v: unknown): Date | null {
    return v ? new Date(String(v).slice(0, 10) + 'T00:00:00.000Z') : null;
  }
  private numberFormat(n: number): string {
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  private requireField(body: Record<string, unknown>, field: string): void {
    if (body[field] === undefined || body[field] === null || body[field] === '') {
      throwValidation({ [field]: [`The ${field.replace(/_/g, ' ')} field is required.`] });
    }
  }

  /**
   * TD-004 — what an invoice is allowed to say, checked before any of it is written.
   *
   * The endpoints validated PRESENCE and nothing else: `invoice_date` and `terms` had to be there,
   * and every value then went to the database as it arrived. A negative rate stored a −5,650
   * invoice; a discount of 999,999 against a 100 invoice stored a total of −999,886; `terms:
   * "NOT_A_TERM"` stored with a NULL due date, which removes the invoice from the overdue view
   * (`due_date: { lt: now }` cannot match NULL) and from the reminder sweep, so it is never chased;
   * `status: "Hacked"` stored verbatim. Negative totals flow straight into the dashboard's billed
   * and outstanding figures and into every commission report.
   *
   * Two of the seven cases came back as 500 rather than 422 — an unparseable `invoice_date`, and
   * `tax_rate: 9999` overflowing `Decimal(5,2)`. Those were the DATABASE refusing what the
   * application never looked at. Both are now field messages.
   *
   * EVERY FAULT IN ONE REPLY, the same way `TransactionsWriteService.store` answers (TD-113):
   * a caller fixing an invoice by API should not discover its problems one round trip at a time.
   *
   * WHY HERE AND NOT IN A DTO. The global `ValidationPipe` in `main.ts` is already wired for the
   * Laravel 422 shape and would cover the per-field types, but three of these rules are
   * cross-field — a discount is only wrong RELATIVE to the lines it discounts, and on update the
   * lines may not have been submitted at all — and a DTO cannot see the stored invoice. Splitting
   * the rules across two mechanisms would leave two places to look. `subTotal` is passed in by the
   * caller, which is what knows whether the lines came from the request or from the record.
   */
  private validateInvoiceInput(
    body: Record<string, unknown>,
    subTotal: number,
    current?: { status: string; amount_paid: Prisma.Decimal | number; sent_at: Date | null },
  ): void {
    const errors: Record<string, string[]> = {};
    const blank = (v: unknown): boolean => v === undefined || v === null || v === '';
    const present = (f: string): boolean => !blank(body[f]);

    for (const f of ['invoice_date', 'terms']) {
      if (blank(body[f])) errors[f] = [`The ${f.replace(/_/g, ' ')} field is required.`];
    }

    /*
     * A date that does not parse reached `new Date(...)` as `Invalid Date` and went to Prisma,
     * which is where the 500 came from. Checked for every date column this body can set, not only
     * the one the defect happened to probe.
     */
    for (const f of ['invoice_date', 'due_date', 'commission_received_date']) {
      if (!present(f)) continue;
      const raw = String(body[f]).slice(0, 10);
      const parsed = new Date(`${raw}T00:00:00.000Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(parsed.getTime())) {
        errors[f] = [`The ${f.replace(/_/g, ' ')} must be a date in YYYY-MM-DD form.`];
      }
    }

    if (present('terms') && !isInvoiceTerm(String(body.terms))) {
      errors.terms = [`"${String(body.terms)}" is not a payment term this system offers. Allowed: ${INVOICE_TERMS.join(', ')}.`];
    }

    if (present('status') && !isInvoiceStatus(String(body.status))) {
      errors.status = [`"${String(body.status)}" is not an invoice status. Allowed: ${INVOICE_STATUSES.join(', ')}.`];
    }

    /*
     * TD-048 — A STATUS THE PAYMENTS DECIDE IS NOT A STATUS ANYBODY MAY TYPE.
     *
     * `Draft` and `Partially Paid` are written by the system: a new invoice starts as a draft, and
     * a part payment moves it to Partially Paid on its own. Both were nonetheless ACCEPTED from a
     * request — which is where the Admin Activities panel's "Draft" on an issued invoice came from
     * — and `Unpaid` was accepted over an invoice with money against it, only for `recalculate` to
     * quietly put it back. A silent correction and a refusal look identical from the outside until
     * one of them is wrong.
     *
     * Only a CHANGE is refused. The editor spreads the whole form on every save, so an invoice
     * already sitting at `Partially Paid` re-sends that value on any edit; treating that as an
     * attempt to set it would break every ordinary save on a part-paid invoice.
     */
    if (present('status') && current && !errors.status) {
      const want = String(body.status);
      const paid = num(current.amount_paid);
      if (want !== current.status) {
        if (isDerivedStatus(want)) {
          errors.status = [
            `"${want}" is set by the invoice itself, not chosen: it follows the payments recorded against it. `
            + `Statuses that can be set: ${SETTABLE_STATUSES.join(', ')}.`,
          ];
        } else if (want === 'Unpaid' && paid > 0) {
          errors.status = [
            `This invoice has ${paid.toFixed(2)} recorded against it, so it cannot be set back to Unpaid — `
            + 'it is Partially Paid until those payments are removed.',
          ];
        }
      }
    }

    /*
     * Money that cannot exist, judged the way the transactions endpoint judges a price (TD-055):
     * a negative rate is not a credit and a negative quantity is not a return. Neither has ever had
     * a meaning on this screen, and both produce a negative invoice that the dashboard then adds up.
     */
    const money = (v: unknown): number => Number(String(v ?? '').replace(/,/g, ''));
    const lines = this.asArray(body.line_items);
    lines.forEach((it, i) => {
      for (const f of ['qty', 'rate'] as const) {
        if (it[f] === undefined || it[f] === null || it[f] === '') continue;
        const n = money(it[f]);
        if (!Number.isFinite(n)) errors[`line_items.${i}.${f}`] = [`The ${f} must be a number.`];
        else if (n < 0) errors[`line_items.${i}.${f}`] = [`The ${f} cannot be negative.`];
      }
    });

    if (present('discount')) {
      const d = money(body.discount);
      if (!Number.isFinite(d)) errors.discount = ['The discount must be a number.'];
      else if (d < 0) errors.discount = ['The discount cannot be negative.'];
      /*
       * Compared against the SUB-TOTAL rather than the total, deliberately. The total is
       * `subTotal + tax − discount`, so bounding by the sub-total guarantees a total that cannot
       * go negative, and it does so without this check having to predict which lines are taxable
       * and at what rate — a second copy of the calculator's arithmetic, able to disagree with it.
       */
      else if (d > subTotal) {
        errors.discount = [`The discount cannot be more than the invoice sub-total of ${subTotal.toFixed(2)}.`];
      }
    }

    if (present('tax_rate')) {
      const r = money(body.tax_rate);
      if (!Number.isFinite(r)) errors.tax_rate = ['The tax rate must be a number.'];
      else if (r < 0) errors.tax_rate = ['The tax rate cannot be negative.'];
      else if (r > MAX_TAX_RATE) errors.tax_rate = [`The tax rate cannot be more than ${MAX_TAX_RATE}%.`];
    }

    if (Object.keys(errors).length) throwValidation(errors);
  }

  /** The sub-total a body's line items would produce — what a discount has to be judged against. */
  private lineSubTotal(items: Record<string, unknown>[]): number {
    return round2(items.reduce((sum, it) => {
      const qty = Number(it.qty ?? 1);
      const rate = Number(it.rate ?? 0);
      return sum + (Number.isFinite(qty) && Number.isFinite(rate) ? round2(qty * rate) : 0);
    }, 0));
  }
  private asArray(v: unknown): Record<string, unknown>[] {
    return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
  }
}
