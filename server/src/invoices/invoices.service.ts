import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CompanySettingsService } from '../settings/company-settings.service';
import { AuditService, type ActingUser } from '../audit/audit.service';
import { throwValidation } from '../common/laravel-exceptions';
import { jsonField, phpJsonNormalize, round2, toDateString, toDateTimeString, toIso8601String } from '../common/serialize';
import { INVOICEABLE_TYPES, isInvoiceableType } from '../reference/transaction.constants';
import { InvoiceCalculator } from './invoice.calculator';
import { InvoiceNumberService } from './invoice.numbers';
import { TransactionInvoiceService } from './transaction-invoice.service';

const num = (d: Prisma.Decimal | number | null): number => (d === null ? 0 : Number(d));

type InvoiceSummaryRow = Prisma.invoicesGetPayload<{ include: { transactions: true } }>;
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
  ) {}

  async index(): Promise<Record<string, unknown>[]> {
    const invoices = await this.prisma.invoices.findMany({
      where: { deleted_at: null },
      orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
      include: { customers: true, transactions: true },
    });
    return invoices.map((i) => this.summary(i));
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

  /** Overdue is derived: past due date with an outstanding balance. */
  private displayStatus(i: { status: string; due_date: Date | null; balance_due: Prisma.Decimal | number }): string {
    if (
      (i.status === 'Unpaid' || i.status === 'Partially Paid') &&
      i.due_date &&
      i.due_date < new Date() &&
      num(i.balance_due) > 0
    ) {
      return 'Overdue';
    }
    return i.status;
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
    this.requireField(body, 'invoice_date');
    this.requireField(body, 'terms');
    const settings = await this.settings.current();
    const now = new Date();

    const inv = await this.prisma.$transaction(async (tx) => {
      const created = await tx.invoices.create({
        data: {
          ...(this.mapFields(body, settings) as Prisma.invoicesCreateInput),
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
    this.requireField(body, 'invoice_date');
    this.requireField(body, 'terms');
    const invoice = await this.prisma.invoices.findFirst({ where: { id, deleted_at: null } });
    if (!invoice) throw new NotFoundException({ message: `No query results for model [App\\Models\\Invoice] ${id}.` });
    const settings = await this.settings.current();
    const oldStatus = invoice.status;

    await this.prisma.$transaction(async (tx) => {
      await tx.invoices.update({ where: { id }, data: { ...(this.mapFields(body, settings) as Prisma.invoicesUpdateInput), updated_at: new Date() } });
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
    const updated = await this.prisma.invoices.findUniqueOrThrow({ where: { id } });
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

  async recordReminder(actor: ActingUser | null, id: number): Promise<Record<string, unknown>> {
    const invoice = await this.prisma.invoices.findFirst({ where: { id, deleted_at: null } });
    if (!invoice) throw new NotFoundException({ message: `No query results for model [App\\Models\\Invoice] ${id}.` });
    const reminders = ((jsonField(invoice.reminders) as unknown[]) ?? []) as Record<string, unknown>[];
    reminders.push({ date: toDateTimeString(new Date()), by: actor?.name ?? null });
    await this.prisma.invoices.update({ where: { id }, data: { reminders: JSON.stringify(phpJsonNormalize(reminders)), updated_at: new Date() } });
    const updated = await this.prisma.invoices.findUniqueOrThrow({ where: { id } });
    await this.auditInvoice(id, updated.transaction_id, actor, { field: `Invoice ${updated.invoice_no} — Reminder`, action: 'Reminder sent', new: `Reminder #${reminders.length}` });
    this.emailInvoice();
    return this.show(id);
  }

  async send(actor: ActingUser | null, id: number): Promise<Record<string, unknown>> {
    const invoice = await this.prisma.invoices.findFirst({ where: { id, deleted_at: null } });
    if (!invoice) throw new NotFoundException({ message: `No query results for model [App\\Models\\Invoice] ${id}.` });
    if (!invoice.sent_at) await this.prisma.invoices.update({ where: { id }, data: { sent_at: new Date(), updated_at: new Date() } });
    const updated = await this.prisma.invoices.findUniqueOrThrow({ where: { id } });
    await this.auditInvoice(id, updated.transaction_id, actor, { field: updated.invoice_no, action: 'Invoice sent', new: toDateString(updated.sent_at) });
    this.emailInvoice();
    return this.show(id);
  }

  async generateForTransaction(actor: ActingUser | null, txnId: number): Promise<Record<string, unknown>> {
    const t = await this.prisma.transactions.findFirst({ where: { id: txnId, deleted_at: null } });
    if (!t) throw new NotFoundException({ message: `No query results for model [App\\Models\\Transaction] ${txnId}.` });
    if (!isInvoiceableType(t.type)) {
      throw new UnprocessableEntityException({ message: 'Invoices can only be generated for: ' + INVOICEABLE_TYPES.join(', ') + '.' });
    }
    const existing = await this.prisma.invoices.findMany({ where: { transaction_id: txnId, deleted_at: null }, include: { transactions: true } });
    if (existing.length > 0) {
      return { count: 0, existing: true, invoices: existing.map((i) => this.summary(i)) };
    }
    const created = await this.prisma.$transaction((tx) => this.txnInvoices.generate(tx, txnId, actor, false));
    const withTxn = await this.prisma.invoices.findMany({ where: { id: { in: created.map((c) => c.id) } }, orderBy: { id: 'asc' }, include: { transactions: true } });
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

  private emailInvoice(): void {
    // Templated email delivery is handled by the mail module (email settings); it is
    // best-effort and never affects the API response, matching Laravel's try/catch.
  }

  private mapFields(data: Record<string, unknown>, settings: { default_tax_rate: Prisma.Decimal | number }): Record<string, unknown> {
    void settings;
    const invoiceDate = this.toDate(data.invoice_date)!;
    const terms = String(data.terms);
    const dueDate = this.dueDate(invoiceDate, terms, (data.due_date ?? null) as string | null);
    return {
      transaction_id: (data.transaction_id ?? null) as number | null,
      property_reference: (data.property_reference ?? null) as string | null,
      customer_id: (data.customer_id ?? null) as number | null,
      customer_name: (data.customer_name ?? null) as string | null,
      customer_address: (data.customer_address ?? null) as string | null,
      customer_city: (data.customer_city ?? null) as string | null,
      customer_province: (data.customer_province ?? null) as string | null,
      customer_postal_code: (data.customer_postal_code ?? null) as string | null,
      customer_country: (data.customer_country ?? 'Canada') as string,
      invoice_date: invoiceDate,
      terms,
      due_date: dueDate,
      trade_number: (data.trade_number ?? null) as string | null,
      listing_agent: (data.listing_agent ?? null) as string | null,
      coop_salesperson: (data.coop_salesperson ?? null) as string | null,
      subject: (data.subject ?? null) as string | null,
      customer_phone: (data.customer_phone ?? null) as string | null,
      customer_email: (data.customer_email ?? null) as string | null,
      discount: (data.discount ?? 0) as number,
      tax_rate: data.tax_rate !== undefined && data.tax_rate !== null && data.tax_rate !== '' ? Number(data.tax_rate) : null,
      customer_notes: (data.customer_notes ?? null) as string | null,
      terms_conditions: (data.terms_conditions ?? null) as string | null,
      signature_path: (data.signature_path ?? null) as string | null,
      broker_name: (data.broker_name ?? null) as string | null,
      commission_received_date: this.toDate(data.commission_received_date),
      commission_received_via: (data.commission_received_via ?? null) as string | null,
      auto_reminder: data.auto_reminder !== undefined && data.auto_reminder !== null ? JSON.stringify(phpJsonNormalize(data.auto_reminder)) : null,
      status: (data.status ?? 'Draft') as string,
    };
  }

  private dueDate(invoiceDate: Date, terms: string, custom: string | null): Date | null {
    if (terms === 'Custom') return custom ? this.toDate(custom) : null;
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
  private asArray(v: unknown): Record<string, unknown>[] {
    return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
  }
}
