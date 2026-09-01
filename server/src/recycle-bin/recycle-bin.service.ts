import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { InvoiceCalculator } from '../invoices/invoice.calculator';
import { CompanySettingsService } from '../settings/company-settings.service';
import { parseJson, round2, toDateString, toDateTimeString } from '../common/serialize';
import { domainFilter } from '../common/domain';
import type { AuthUserRecord } from '../auth/auth.types';
import { STORAGE_ROOT } from '../config/storage';

import { isSuperAdmin } from '../core/authz';
type Actor = AuthUserRecord | null;

const KIND_LABELS: Record<string, string> = {
  agent_payment: 'Agent Commission Paid',
  cta: 'CTA to BA',
  adjustment_row: 'Adjustment',
  advance_row: 'Advance Payment',
  client_row: 'Client Referral',
  ext_referral: 'External Referral',
};

// Laravel Storage::disk('local') root = <app>/storage/app; the Nest server runs in <app>/server.

@Injectable()
export class RecycleBinService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly calc: InvoiceCalculator,
    private readonly settings: CompanySettingsService,
  ) {}

  private guard(user: Actor): void {
    if (!isSuperAdmin(user)) throw new ForbiddenException({ message: 'Only a Super Admin can access the Recycle Bin.' });
  }

  private async logAction(user: Actor, field: string, action: string): Promise<void> {
    const now = new Date();
    await this.prisma.audit_logs.create({
      // The Recycle Bin is a Transaction Desk screen, so its entries belong to that trail.
      data: { category: 'Recycle Bin', domain: 'desk', who: user?.name ?? null, user_id: user?.id ?? null, section: 'Recycle Bin', field, action, source: 'Manual', created_at: now, updated_at: now },
    });
  }

  private actingUser(user: Actor): { id: number; name: string } | null {
    return user ? { id: user.id, name: user.name } : null;
  }

  // ---- Transactions ----------------------------------------------------

  /**
   * TD-091 — the bin names who removed each record, not only what and when.
   *
   * A row carried the trade number, the property and a precise timestamp, and `null` for the actor:
   * `requested_by` is filled from a delete REQUEST, which only exists when an agent asked, so an
   * administrator's own deletion named nobody. The retention screen could not answer the retention
   * question without someone knowing to cross-reference the Deletion Log.
   *
   * NOTHING NEW IS RECORDED — the actor was always written, just not returned here. Both delete
   * paths audit `action: 'Record removed'` against the transaction with the actor's name
   * (`transactions-write.service.ts` for a direct delete, `delete-requests.service.ts` for an
   * approved request), so this reads what is already stored. That matters beyond tidiness: no
   * column is added, so there is no `ALTER TABLE` and nothing here depends on the application's
   * database user owning the table.
   *
   * `requested_by` and `deleted_by` are BOTH kept and are genuinely different people on an approved
   * request — the agent who asked, and the administrator who agreed. Collapsing them would lose
   * half of the accountability the screen exists to show.
   *
   * The LATEST removal wins. A transaction can be deleted, restored and deleted again; the row is
   * only in the bin because of the most recent one.
   */
  async transactions(user: Actor): Promise<{ count: number; items: Record<string, unknown>[] }> {
    this.guard(user);
    const rows = await this.prisma.transactions.findMany({
      where: { deleted_at: { not: null } },
      include: { transaction_delete_requests: { orderBy: [{ created_at: 'desc' }, { id: 'desc' }] } },
      orderBy: [{ deleted_at: 'desc' }, { id: 'desc' }],
    });

    // One query for the whole page rather than one per row.
    const deletedBy = new Map<number, string>();
    if (rows.length) {
      const removals = await this.prisma.audit_logs.findMany({
        where: { transaction_id: { in: rows.map((t) => t.id) }, action: 'Record removed' },
        select: { transaction_id: true, who: true },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      });
      // Ordered newest first, so the first entry seen for an id is the removal that put it here.
      for (const r of removals) {
        if (r.transaction_id != null && r.who && !deletedBy.has(r.transaction_id)) deletedBy.set(r.transaction_id, r.who);
      }
    }

    const items = rows.map((t) => {
      const req = t.transaction_delete_requests[0] ?? null;
      return {
        id: t.id,
        trade_no: t.trade_no,
        type: t.type,
        property: t.property,
        agent: t.agent,
        price: Number(t.price),
        closing_date: toDateString(t.closing_date),
        deleted_at: toDateTimeString(t.deleted_at),
        // Null only for a record removed before the trail carried the actor — the screen says
        // "Not recorded" there rather than inventing a name.
        deleted_by: deletedBy.get(t.id) ?? null,
        requested_by: req?.requested_by_name ?? null,
        reason: req?.reason ?? null,
      };
    });
    return { count: items.length, items };
  }

  async restoreTransaction(user: Actor, id: number): Promise<{ message: string; id: number }> {
    this.guard(user);
    const t = await this.onlyTrashed('transactions', id, 'Transaction');

    // Deleting a transaction takes its invoices with it, stamping both with the same instant.
    // Restoring reverses exactly that: only invoices carrying this transaction's deletion
    // timestamp come back, so an invoice that had been deleted separately, earlier, stays
    // deleted rather than reappearing as a side effect.
    const restored = t.deleted_at
      ? await this.prisma.invoices.updateMany({
          where: { transaction_id: id, deleted_at: t.deleted_at },
          data: { deleted_at: null },
        })
      : { count: 0 };

    await this.prisma.transactions.update({ where: { id }, data: { deleted_at: null } });
    await this.audit.record(id, this.actingUser(user), {
      section: 'Basic Information', action: 'Record restored', source: 'Manual',
      details: `Trade #${t.trade_no} restored from Recycle Bin${restored.count ? ` (with ${restored.count} invoice${restored.count === 1 ? '' : 's'})` : ''}`,
    });
    return { message: 'Transaction restored', id };
  }

  async forceDeleteTransaction(user: Actor, id: number): Promise<{ message: string }> {
    this.guard(user);
    const t = await this.onlyTrashed('transactions', id, 'Transaction');
    const trade = t.trade_no;
    await this.prisma.transactions.delete({ where: { id } });
    await this.logAction(user, `Trade #${trade}`, 'Transaction permanently deleted');
    return { message: 'Transaction permanently deleted' };
  }

  // ---- Documents -------------------------------------------------------

  async documents(user: Actor): Promise<{ count: number; items: Record<string, unknown>[] }> {
    this.guard(user);
    const rows = await this.prisma.documents.findMany({
      where: { deleted_at: { not: null } },
      include: { transactions: true },
      orderBy: [{ deleted_at: 'desc' }, { id: 'desc' }],
    });
    const items = rows.map((d) => {
      const files = parseJson<unknown[]>(d.files) ?? [];
      return {
        id: d.id,
        title: d.title,
        status: d.status,
        validation: d.validation,
        has_file: !!d.file_path,
        file_count: Array.isArray(files) ? files.length : 0,
        deleted_at: toDateTimeString(d.deleted_at),
        transaction_id: d.transaction_id,
        trade_no: d.transactions?.trade_no ?? null,
        property: d.transactions?.property ?? null,
        transaction_trashed: !!(d.transactions && d.transactions.deleted_at !== null),
      };
    });
    return { count: items.length, items };
  }

  async restoreDocument(user: Actor, id: number): Promise<{ message: string }> {
    this.guard(user);
    const d = await this.onlyTrashed('documents', id, 'Document');
    await this.prisma.documents.update({ where: { id }, data: { deleted_at: null } });
    const txn = await this.prisma.transactions.findFirst({ where: { id: d.transaction_id, deleted_at: null } });
    if (txn) {
      await this.audit.record(txn.id, this.actingUser(user), {
        section: 'Legal & Documents', field: d.title, action: 'Document restored', source: 'Manual',
      });
    }
    return { message: 'Document restored' };
  }

  async forceDeleteDocument(user: Actor, id: number): Promise<{ message: string }> {
    this.guard(user);
    const d = await this.onlyTrashed('documents', id, 'Document');
    await this.purgeDocumentFiles(d);
    const title = d.title;
    await this.prisma.documents.delete({ where: { id } });
    await this.logAction(user, title, 'Document permanently deleted');
    return { message: 'Document permanently deleted' };
  }

  private async purgeDocumentFiles(d: { file_path: string | null; validation_file_path: string | null; files: string | null }): Promise<void> {
    const unlink = async (p: string | null | undefined): Promise<void> => {
      if (!p) return;
      try { await fs.unlink(path.join(STORAGE_ROOT, p)); } catch { /* best-effort, matches Storage::delete swallowing */ }
    };
    await unlink(d.file_path);
    await unlink(d.validation_file_path);
    for (const f of (parseJson<{ file_path?: string }[]>(d.files) ?? [])) await unlink(f?.file_path);
  }

  // ---- Invoices --------------------------------------------------------

  async invoices(user: Actor): Promise<{ count: number; items: Record<string, unknown>[] }> {
    this.guard(user);
    const rows = await this.prisma.invoices.findMany({
      where: { deleted_at: { not: null } },
      include: { transactions: true },
      orderBy: [{ deleted_at: 'desc' }, { id: 'desc' }],
    });
    const items = rows.map((i) => ({
      id: i.id,
      invoice_no: i.invoice_no,
      customer_name: i.customer_name,
      total: Number(i.total),
      status: i.status,
      reason: i.delete_reason,
      deleted_at: toDateTimeString(i.deleted_at),
      transaction_id: i.transaction_id,
      trade_no: i.transactions?.trade_no ?? null,
      transaction_trashed: !!(i.transactions && i.transactions.deleted_at !== null),
    }));
    return { count: items.length, items };
  }

  async restoreInvoice(user: Actor, id: number): Promise<{ message: string }> {
    this.guard(user);
    const i = await this.onlyTrashed('invoices', id, 'Invoice');
    await this.prisma.invoices.update({ where: { id }, data: { deleted_at: null } });
    await this.logAction(user, i.invoice_no, 'Invoice restored');
    return { message: 'Invoice restored' };
  }

  async forceDeleteInvoice(user: Actor, id: number): Promise<{ message: string }> {
    this.guard(user);
    const i = await this.onlyTrashed('invoices', id, 'Invoice');
    const no = i.invoice_no;
    await this.prisma.invoice_line_items.deleteMany({ where: { invoice_id: id } });
    await this.prisma.invoice_payments.deleteMany({ where: { invoice_id: id } });
    await this.prisma.invoices.delete({ where: { id } });
    await this.logAction(user, no, 'Invoice permanently deleted');
    return { message: 'Invoice permanently deleted' };
  }

  // ---- Invoice payments ------------------------------------------------

  async payments(user: Actor): Promise<{ count: number; items: Record<string, unknown>[] }> {
    this.guard(user);
    const rows = await this.prisma.invoice_payments.findMany({
      where: { deleted_at: { not: null } },
      include: { invoices: true },
      orderBy: [{ deleted_at: 'desc' }, { id: 'desc' }],
    });
    const items = rows.map((p) => ({
      id: p.id,
      amount: Number(p.amount),
      method: p.method,
      reference: p.reference,
      paid_on: toDateString(p.paid_on),
      deleted_at: toDateTimeString(p.deleted_at),
      invoice_id: p.invoice_id,
      invoice_no: p.invoices?.invoice_no ?? null,
      invoice_trashed: !!(p.invoices && p.invoices.deleted_at !== null),
    }));
    return { count: items.length, items };
  }

  async restorePayment(user: Actor, id: number): Promise<{ message: string }> {
    this.guard(user);
    const p = await this.onlyTrashed('invoice_payments', id, 'InvoicePayment');
    await this.prisma.invoice_payments.update({ where: { id }, data: { deleted_at: null } });
    await this.recalcInvoice(p.invoice_id);
    await this.logAction(user, `Payment #${p.id}`, 'Payment restored');
    return { message: 'Payment restored' };
  }

  async forceDeletePayment(user: Actor, id: number): Promise<{ message: string }> {
    this.guard(user);
    const p = await this.onlyTrashed('invoice_payments', id, 'InvoicePayment');
    const invoiceId = p.invoice_id;
    await this.prisma.invoice_payments.delete({ where: { id } });
    await this.recalcInvoice(invoiceId);
    await this.logAction(user, `Payment #${id}`, 'Payment permanently deleted');
    return { message: 'Payment permanently deleted' };
  }

  /** Recompute a (live) invoice's totals after a payment changes. */
  private async recalcInvoice(invoiceId: number | null): Promise<void> {
    if (!invoiceId) return;
    const invoice = await this.prisma.invoices.findFirst({ where: { id: invoiceId, deleted_at: null } });
    if (!invoice) return;
    const taxRate = invoice.tax_rate !== null && invoice.tax_rate !== undefined ? Number(invoice.tax_rate) : Number((await this.settings.current()).default_tax_rate);
    await this.calc.recalculate(this.prisma, invoiceId, taxRate);
  }

  // ---- Deletion log ----------------------------------------------------

  /**
   * TD-019 — the Transaction Desk's Deletion Log, scoped to the Transaction Desk.
   *
   * This asked `audit_logs` for every row whose action mentions deleting or removing, with no area
   * restriction at all, so CRM deletions ('Campaign deleted: welcome…') were listed beside
   * transaction deletions in a log the Recycle Bin presents as this module's own history.
   *
   * `domainFilter('desk')` is the rule the Audit Trail already applies, reused rather than
   * restated — this area's rows, the genuinely shared ones (`common`, e.g. a user account), and
   * anything still unclassified. The last two matter: dropping to `{ domain: 'desk' }` would hide
   * rows written before the domain split from BOTH logs, which is a worse failure than the one
   * being fixed. Rows kept because they are shared are marked as such in the payload below, so the
   * log does not silently imply a user deletion happened inside the Desk.
   *
   * It goes into the existing `AND` rather than being spread into `where`: each element owns its
   * own `OR` key, and spreading would replace the action filter above it.
   */
  async deletions(user: Actor): Promise<{ count: number; items: Record<string, unknown>[] }> {
    this.guard(user);
    const logs = await this.prisma.audit_logs.findMany({
      where: {
        AND: [
          { OR: [{ action: { contains: 'delet', mode: 'insensitive' } }, { action: { contains: 'remov', mode: 'insensitive' } }] },
          { OR: [{ field: null }, { NOT: { field: { contains: 'Deletion Request', mode: 'insensitive' } } }] },
          domainFilter('desk'),
        ],
      },
      include: { transactions: true },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: 400,
    });
    const items = logs.map((a) => ({
      id: a.id,
      who: a.who,
      action: a.action,
      section: a.section,
      field: a.field,
      details: a.details,
      old_value: a.old_value,
      source: a.source,
      // TD-019 — 'common' rows belong to both areas; the screen marks them so a shared deletion is
      // not read as a Transaction Desk one. `desk` and unclassified rows need no marking.
      shared: a.domain === 'common',
      stamp: toDateTimeString(a.created_at),
      transaction_id: a.transaction_id,
      trade_no: a.transactions?.trade_no ?? null,
      property: a.transactions?.property ?? null,
      transaction_trashed: !!(a.transactions && a.transactions.deleted_at !== null),
      restore_type: null,
      restore_id: null,
    }));
    return { count: items.length, items };
  }

  // ---- Admin Activities / Adjustment row deletions (shown under Payments) ----

  async rowItems(user: Actor): Promise<{ count: number; items: Record<string, unknown>[] }> {
    this.guard(user);
    const rows = await this.prisma.trashed_row_items.findMany({
      include: { transactions: true },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    });
    const items = rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      kind_label: KIND_LABELS[r.kind] ?? r.kind,
      agent: r.agent,
      label: r.label,
      summary: this.rowSummary(r),
      who: r.who,
      deleted_at: toDateTimeString(r.created_at),
      transaction_id: r.transaction_id,
      trade_no: r.transactions?.trade_no ?? null,
      transaction_trashed: !!(r.transactions && r.transactions.deleted_at !== null),
    }));
    return { count: items.length, items };
  }

  async restoreRowItem(user: Actor, id: number): Promise<{ message: string }> {
    this.guard(user);
    const r = await this.prisma.trashed_row_items.findUnique({ where: { id } });
    if (!r) throw new NotFoundException({ message: `No query results for model [App\\Models\\TrashedRowItem] ${id}.` });
    const t = await this.prisma.transactions.findUnique({ where: { id: r.transaction_id } });
    if (!t) throw new NotFoundException({ message: 'Transaction not found.' });

    const module = r.module;
    const data = (parseJson<Record<string, unknown>>((t as unknown as Record<string, string | null>)[module]) ?? {}) as Record<string, unknown>;
    const row = parseJson<unknown>(r.data) ?? [];
    const obj = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;
    const arr = (v: unknown): unknown[] => v as unknown[];

    switch (r.kind) {
      case 'agent_payment':
      case 'cta': {
        const key = r.kind === 'cta' ? 'cta' : 'payments';
        if (r.term !== null && r.term !== undefined) {
          const ta = (obj(data).term_admin ??= {}) as Record<string, unknown>;
          const term = (obj(ta)[r.term] ??= {}) as Record<string, unknown>;
          const agents = (obj(term).agents ??= {}) as Record<string, unknown>;
          const agent = (obj(agents)[r.agent as string] ??= {}) as Record<string, unknown>;
          (arr(obj(agent)[key] ??= []) as unknown[]).push(row);
        } else {
          const agents = (obj(data).agents ??= {}) as Record<string, unknown>;
          const agent = (obj(agents)[r.agent as string] ??= {}) as Record<string, unknown>;
          (arr(obj(agent)[key] ??= []) as unknown[]).push(row);
        }
        break;
      }
      case 'adjustment_row':
        obj(data).agent_adjust = 'Yes';
        (arr(obj(data).adjustment_rows ??= []) as unknown[]).push(row);
        break;
      case 'advance_row':
        obj(data).advance_payment = 'Yes';
        (arr(obj(data).advance_rows ??= []) as unknown[]).push(row);
        break;
      case 'client_row':
        obj(data).client_referral = 'Yes';
        (arr(obj(data).client_rows ??= []) as unknown[]).push(row);
        break;
      case 'ext_referral':
        obj(data).ext_referral = 'Yes';
        obj(data).ext = row;
        break;
    }

    await this.prisma.transactions.update({ where: { id: t.id }, data: { [module]: JSON.stringify(data), updated_at: new Date() } });
    await this.prisma.trashed_row_items.delete({ where: { id } });

    if (t.deleted_at === null) {
      await this.audit.record(t.id, this.actingUser(user), { section: 'Recycle Bin', field: r.label ?? undefined, action: 'Row restored', source: 'Manual' });
    }
    return { message: 'Restored' };
  }

  async forceDeleteRowItem(user: Actor, id: number): Promise<{ message: string }> {
    this.guard(user);
    const r = await this.prisma.trashed_row_items.findUnique({ where: { id } });
    if (!r) throw new NotFoundException({ message: `No query results for model [App\\Models\\TrashedRowItem] ${id}.` });
    const label = r.label;
    await this.prisma.trashed_row_items.delete({ where: { id } });
    await this.logAction(user, String(label ?? ''), 'Deleted row permanently removed');
    return { message: 'Permanently deleted' };
  }

  private rowSummary(r: { kind: string; data: string | null }): string {
    const d = (parseJson<Record<string, unknown>>(r.data) ?? {}) as Record<string, unknown>;
    const money = (v: unknown): string => '$' + this.numberFormat(Number(String(v ?? 0).replace(/,/g, '')) || 0, 2);
    const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
    switch (r.kind) {
      case 'agent_payment':
        return `${s(d.paid_type) || 'N/A'} · ${s(d.paid_date) || '—'}${d.batch_no ? ' · ' + s(d.batch_no) : ''}`.trim();
      case 'cta':
        return 'CTA to BA: ' + (s(d.cta) || '—') + ' · ' + (s(d.date) || '—');
      case 'adjustment_row':
        return money(d.amount ?? 0) + (d.remarks ? ' · ' + s(d.remarks) : '');
      case 'advance_row':
        return money(d.amount ?? 0) + ' · ' + (s(d.paid_type) || 'N/A') + ' · ' + (s(d.paid_date) || '—');
      case 'client_row':
        return money(d.amount ?? 0);
      case 'ext_referral':
        return s(d.brokerage) + ' · ' + money(d.amount ?? 0);
      default:
        return '';
    }
  }

  private numberFormat(value: number, decimals: number): string {
    const n = round2(value);
    const fixed = Math.abs(n).toFixed(decimals);
    const [int, dec] = fixed.split('.');
    const withCommas = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (n < 0 ? '-' : '') + withCommas + (dec ? '.' + dec : '');
  }

  /** onlyTrashed()->findOrFail() — the trashed row or a Laravel-shaped 404. */
  private async onlyTrashed(model: 'transactions', id: number, label: string): Promise<{ id: number; trade_no: string; deleted_at: Date | null }>;
  private async onlyTrashed(model: 'documents', id: number, label: string): Promise<{ id: number; title: string; transaction_id: number; file_path: string | null; validation_file_path: string | null; files: string | null; deleted_at: Date | null }>;
  private async onlyTrashed(model: 'invoices', id: number, label: string): Promise<{ id: number; invoice_no: string; deleted_at: Date | null }>;
  private async onlyTrashed(model: 'invoice_payments', id: number, label: string): Promise<{ id: number; invoice_id: number; deleted_at: Date | null }>;
  private async onlyTrashed(model: string, id: number, label: string): Promise<Record<string, unknown>> {
    const row = await (this.prisma as unknown as Record<string, { findFirst: (a: unknown) => Promise<Record<string, unknown> | null> }>)[model].findFirst({ where: { id, deleted_at: { not: null } } });
    if (!row) throw new NotFoundException({ message: `No query results for model [App\\Models\\${label}] ${id}.` });
    return row;
  }
}
