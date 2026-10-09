import {
  ForbiddenException, Injectable, InternalServerErrorException, Logger, NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
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
  private readonly log = new Logger(RecycleBinService.name);

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
    /*
     * THE INVOICE'S OWN GUARD IS NEVER REACHED ON THIS PATH. transactions -> invoices ->
     * invoice_payments are CASCADE in the database, so erasing the deal takes its paid invoices and
     * every payment row with them, and nothing asks first. Measured 2026-09-30 before this was
     * written: no trashed deal held a paid invoice and no trashed invoice held a live payment, so
     * this closes a door rather than fixes a leak. The wording is the invoice's own, because it is
     * the same rule.
     */
    const invoiceIds = (await this.prisma.invoices.findMany({ where: { transaction_id: id }, select: { id: true } })).map((i) => i.id);
    const paid = invoiceIds.length === 0 ? 0
      : await this.prisma.invoice_payments.count({ where: { invoice_id: { in: invoiceIds }, deleted_at: null } });
    if (paid > 0) {
      const m = 'This deal has an invoice with a payment recorded against it, so it cannot be permanently deleted. If the payment was entered in error, Accounting or a Super Admin can remove it first.';
      throw new UnprocessableEntityException({ message: m, errors: { id: [m] } });
    }
    /*
     * ================================================================================================
     * THE DOCUMENTS' FILES GO FIRST, BECAUSE AFTER THE DELETE THERE IS NOTHING LEFT TO FIND THEM BY.
     *
     * `documents.transaction_id` is ON DELETE CASCADE, so the statement below removes every document
     * row for this deal — and with them the only record of where their uploads live. Until now
     * nothing read those rows first, so purging a deal orphaned every file it carried: invisible to
     * the product, still on disk, and still the one copy of documents somebody deliberately
     * destroyed. Measured on a development copy before this was written: 13 of 24 document files
     * were orphans, four of them under folders whose deal no longer existed.
     *
     * The order matches `RetentionService.purgeTransactions`, which has always done it this way.
     * Files first is the safer half of the trade: if the unlink fails we still hold the rows and the
     * paths, and the purge can be retried. Deleting first and unlinking after would lose the paths
     * the moment anything went wrong, which is the state this is fixing.
     * ================================================================================================
     */
    const docs = await this.prisma.documents.findMany({
      where: { transaction_id: id },
      select: { file_path: true, validation_file_path: true, files: true, draft_files: true },
    });
    /*
     * EVERY DOCUMENT IS ATTEMPTED BEFORE GIVING UP, for the reason the per-file loop is written the
     * same way: stopping at the first failure leaves the rest of the deal on disk with no attempt
     * made, and whoever is clearing it up discovers the remaining problems one retry at a time.
     */
    const failed: string[] = [];
    for (const d of docs) failed.push(...await this.collectPurgeFailures(d));
    this.refusePurgeOnFailures(failed);

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

  /*
   * A DOCUMENT CANNOT COME BACK BEFORE THE DEAL IT BELONGS TO.
   *
   * Restoring one whose transaction is also in the bin used to succeed and hide it in both places:
   * no longer deleted, so it left this screen, and its deal still deleted, so there was nowhere to
   * open it. Nothing said so — the restore even skipped its own audit entry, because that is
   * written against a live transaction.
   *
   * Restoring the DEAL brings its documents back with it, so nothing is lost by refusing here; the
   * message names that as the action that works.
   */
  async restoreDocument(user: Actor, id: number): Promise<{ message: string }> {
    this.guard(user);
    const d = await this.onlyTrashed('documents', id, 'Document');
    const txn = await this.prisma.transactions.findUnique({ where: { id: d.transaction_id } });
    if (txn && txn.deleted_at !== null) {
      const m = `Trade #${txn.trade_no} is in the Recycle Bin, so “${d.title}” cannot be restored on its own — it would be hidden on a deleted deal. Restore the transaction and its documents come back with it.`;
      throw new UnprocessableEntityException({ message: m, errors: { id: [m] } });
    }
    await this.prisma.documents.update({ where: { id }, data: { deleted_at: null } });
    if (txn) {
      await this.audit.record(txn.id, this.actingUser(user), {
        section: 'Documents', field: d.title, action: 'Document restored', source: 'Manual',
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

  /** Is this resolved path textually inside `root`? */
  private static within(root: string, abs: string): boolean {
    const rel = path.relative(root, abs);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  /**
   * The storage root with every link resolved, so comparisons are made against the real directory.
   *
   * The root ITSELF may be a link — a deployment pointing `storage/app` at a mounted volume is an
   * ordinary arrangement. Comparing a resolved file path against an unresolved root would then put
   * every legitimate file "outside" and refuse every purge.
   */
  private async realStorageRoot(): Promise<string> {
    const root = path.resolve(STORAGE_ROOT);
    return fs.realpath(root).catch(() => root);
  }

  /**
   * What to do with one stored path: unlink this absolute path, treat it as already gone, or refuse.
   *
   * ================================================================================================
   * TWO CHECKS, BECAUSE THEY CATCH DIFFERENT THINGS.
   *
   * The first is textual. `path.join` walks out of the root happily, so a stored `../../.env`
   * resolves to a real file nobody meant to hand to an unlink. `path.relative` is the test rather
   * than a `startsWith`, because `C:\storage-old` starts with `C:\storage` and is not inside it.
   *
   * The second RESOLVES LINKS, and the first cannot stand in for it. `documents/x/f.pdf` is
   * textually inside the root however many symlinks or junctions lie along it — if `documents/x`
   * points at another volume, the textual check passes and the unlink lands outside. Only
   * `realpath` can tell the difference, because containment is a question about the filesystem and
   * not about the spelling of a string.
   *
   * ENOENT FROM `realpath` IS NOT A REFUSAL. It means nothing is there, which is the state the
   * purge wanted; the caller counts it as done.
   * ================================================================================================
   */
  private async resolveForUnlink(rel: string): Promise<{ abs: string } | { gone: true } | { refuse: string }> {
    const root = await this.realStorageRoot();
    const abs = path.resolve(root, rel);
    if (!RecycleBinService.within(root, abs)) return { refuse: 'outside the storage root' };

    let real: string;
    try {
      real = await fs.realpath(abs);
    } catch (ex) {
      const code = (ex as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { gone: true };
      return { refuse: code ?? (ex as Error).message };
    }
    if (!RecycleBinService.within(root, real)) return { refuse: 'resolves outside the storage root through a link' };
    return { abs: real };
  }

  /**
   * Remove every file a document points at — all four sources.
   *
   * ALREADY GONE IS SUCCESS, ANYTHING ELSE IS NOT. `ENOENT` means the file is in the state we were
   * trying to reach, so it is not a failure. A permission error, a locked file or a path that
   * escapes the storage root IS one, and it used to be swallowed by a bare `catch {}` — the purge
   * then reported "permanently deleted" while the bytes were still there, which is the worst of the
   * three outcomes because nothing recorded that anything had gone wrong.
   *
   * So failures are collected, logged with the paths, and thrown. The caller has not deleted
   * anything yet, so the rows and their paths survive and the purge can be retried once whatever
   * blocked it is cleared.
   *
   * EVERY FILE IS ATTEMPTED BEFORE THROWING. Stopping at the first failure would leave the rest of
   * a multi-file document on disk with no attempt made, and the operator fixing it would have to
   * discover them one retry at a time.
   */
  private async purgeDocumentFiles(d: { file_path: string | null; validation_file_path: string | null; files: string | null; draft_files?: string | null }): Promise<void> {
    this.refusePurgeOnFailures(await this.collectPurgeFailures(d));
  }

  /**
   * Log what could not be removed and refuse the purge, or return quietly when there is nothing to
   * report. Shared so the deal path and the single-document path answer in the same words.
   */
  private refusePurgeOnFailures(failed: string[]): void {
    if (!failed.length) return;
    this.log.error(`Recycle Bin purge could not remove ${failed.length} file(s): ${failed.join('; ')}`);
    const m = failed.length === 1
      ? 'One of this record\u2019s files could not be removed from storage, so nothing was deleted. '
        + 'The record is unchanged and can be deleted again once the file is reachable.'
      : `${failed.length} of this record\u2019s files could not be removed from storage, so nothing was `
        + 'deleted. The record is unchanged and can be deleted again once the files are reachable.';
    throw new InternalServerErrorException({ message: m, errors: { id: [m] } });
  }

  /** Attempt every file this document points at; return what could not be removed. */
  private async collectPurgeFailures(d: { file_path: string | null; validation_file_path: string | null; files: string | null; draft_files?: string | null }): Promise<string[]> {
    const failed: string[] = [];

    const unlink = async (p: string | null | undefined): Promise<void> => {
      if (!p) return;
      const target = await this.resolveForUnlink(p);
      if ('gone' in target) return;                                   // nothing there — already done
      if ('refuse' in target) { failed.push(`${p} (${target.refuse})`); return; }
      try {
        await fs.unlink(target.abs);
      } catch (ex) {
        const code = (ex as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return;   // removed between the check and the unlink; still done
        failed.push(`${p} (${code ?? (ex as Error).message})`);
      }
    };

    await unlink(d.file_path);
    await unlink(d.validation_file_path);
    for (const f of (parseJson<{ file_path?: string }[]>(d.files) ?? [])) await unlink(f?.file_path);
    for (const f of (parseJson<{ file_path?: string }[]>(d.draft_files) ?? [])) await unlink(f?.file_path);

    return failed;
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
    // TD-162 - the deal's own purge refuses a paid invoice; deleting the invoice directly did not,
    // and erased its payments first. Same rule, same words. A removed payment is not live.
    const paid = await this.prisma.invoice_payments.count({ where: { invoice_id: id, deleted_at: null } });
    if (paid > 0) {
      const m = 'This invoice has a payment recorded against it, so it cannot be permanently deleted. If the payment was entered in error, Accounting or a Super Admin can remove it first.';
      throw new UnprocessableEntityException({ message: m, errors: { id: [m] } });
    }
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

  /** Same rule as a document: a payment cannot come back onto an invoice that is itself deleted. */
  async restorePayment(user: Actor, id: number): Promise<{ message: string }> {
    this.guard(user);
    const p = await this.onlyTrashed('invoice_payments', id, 'InvoicePayment');
    const invoice = p.invoice_id ? await this.prisma.invoices.findUnique({ where: { id: p.invoice_id } }) : null;
    if (invoice && invoice.deleted_at !== null) {
      const m = `Invoice ${invoice.invoice_no} is in the Recycle Bin, so this payment cannot be restored on its own — its totals would not be recalculated. Restore the invoice first, then the payment.`;
      throw new UnprocessableEntityException({ message: m, errors: { id: [m] } });
    }
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

    /*
     * A ROW ALREADY BACK ON THE DEAL IS NOT RESTORED TWICE.
     *
     * The restore appended blindly, so re-entering a deleted payment by hand and then restoring it
     * here — or two people restoring the same entry — put the SAME commission or adjustment on the
     * transaction twice, and each copy is money in a total. Identical content is the test, which is
     * what a person comparing the two rows on screen would also call a duplicate.
     */
    const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
    const refuseDuplicate = (): never => {
      const m = `“${r.label ?? KIND_LABELS[r.kind] ?? 'That row'}” is already on this transaction, so restoring it would enter it twice. Delete this bin entry if it is no longer needed.`;
      throw new UnprocessableEntityException({ message: m, errors: { id: [m] } });
    };
    const pushUnique = (list: unknown[], entry: unknown): void => {
      if (list.some((x) => same(x, entry))) refuseDuplicate();
      list.push(entry);
    };

    switch (r.kind) {
      case 'agent_payment':
      case 'cta': {
        const key = r.kind === 'cta' ? 'cta' : 'payments';
        if (r.term !== null && r.term !== undefined) {
          const ta = (obj(data).term_admin ??= {}) as Record<string, unknown>;
          const term = (obj(ta)[r.term] ??= {}) as Record<string, unknown>;
          const agents = (obj(term).agents ??= {}) as Record<string, unknown>;
          const agent = (obj(agents)[r.agent as string] ??= {}) as Record<string, unknown>;
          pushUnique(arr(obj(agent)[key] ??= []) as unknown[], row);
        } else {
          const agents = (obj(data).agents ??= {}) as Record<string, unknown>;
          const agent = (obj(agents)[r.agent as string] ??= {}) as Record<string, unknown>;
          pushUnique(arr(obj(agent)[key] ??= []) as unknown[], row);
        }
        break;
      }
      case 'adjustment_row':
        pushUnique(arr(obj(data).adjustment_rows ??= []) as unknown[], row);
        obj(data).agent_adjust = 'Yes';
        break;
      case 'advance_row':
        pushUnique(arr(obj(data).advance_rows ??= []) as unknown[], row);
        obj(data).advance_payment = 'Yes';
        break;
      case 'client_row':
        pushUnique(arr(obj(data).client_rows ??= []) as unknown[], row);
        obj(data).client_referral = 'Yes';
        break;
      case 'ext_referral':
        // One external referral per deal, so a stored one that already matches is the duplicate.
        if (same(obj(data).ext, row)) refuseDuplicate();
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
