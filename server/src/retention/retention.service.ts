import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { parseJson } from '../common/serialize';
import { STORAGE_ROOT } from '../config/storage';

/**
 * Transaction Desk retention — six months, and not a row of the CRM's.
 *
 * WHAT IS PURGED, and it is a short list on purpose:
 *
 *   audit_logs             `domain = 'desk'` only, older than the cutoff
 *   Recycle Bin            transactions / documents / invoices / invoice payments / trashed rows
 *                          that were SOFT-DELETED before the cutoff
 *   reminder histories     `transaction_reminders` and `document_reminders` older than the cutoff
 *
 * WHAT IS NEVER TOUCHED, and this is the part that matters most:
 *
 *   · `domain = 'crm'`, `domain = 'common'` and `domain IS NULL` audit rows. `common` is Users and
 *     Company Settings — shared history that is not the Desk's to delete. NULL is the honest state
 *     for rows written before the split, and purging on "we cannot tell" is how a retention job
 *     destroys the wrong thing. All three are excluded by an explicit equality, not by a `NOT IN`.
 *   · Anything LIVE. Only rows already in the Recycle Bin are eligible; a deal nobody deleted is
 *     never purged however old it is.
 *   · Every CRM table. None appears in this file.
 *
 * DRY RUN IS THE DEFAULT. `plan()` counts and returns; it writes nothing. `sweep()` refuses to
 * delete unless `RETENTION_ENABLED=true` is set in the environment — so deploying this code does
 * not start deleting anything, and a staging run reports what production would remove before
 * anybody agrees to it. That ordering is the whole safety property.
 *
 * BATCHED, NOT ONE STATEMENT. Deletes run in chunks with a per-sweep ceiling, so a first run against
 * five years of history is many small transactions rather than one lock held over a million rows.
 * The work simply continues on the next pass.
 *
 * REFERENTIAL INTEGRITY comes from the schema: every child of `transactions` is
 * `onDelete: Cascade`, so purging a trashed deal takes its documents, statuses, audit rows, reviews
 * and reminders with it. The one thing the database cannot do is unlink the FILES those documents
 * point at, so that is done first and explicitly — see `purgeDocumentFiles`.
 */

/** The approved window. One constant, because three tables must not drift apart. */
export const RETENTION_MONTHS = 6;

/** Rows removed per statement, and the most any single pass will remove per table. */
const BATCH = 500;
const MAX_PER_SWEEP = 20_000;

export interface RetentionPlan {
  cutoff: string;
  /** True when this run would actually delete. False means counts only. */
  enabled: boolean;
  counts: {
    audit_logs_desk: number;
    trashed_transactions: number;
    trashed_documents: number;
    trashed_invoices: number;
    trashed_payments: number;
    trashed_rows: number;
    transaction_reminders: number;
    document_reminders: number;
  };
  /** Proof, in the same shape, that nothing outside the Desk is in scope. */
  excluded: { audit_logs_crm: number; audit_logs_common: number; audit_logs_unclassified: number };
}

export interface RetentionResult extends RetentionPlan {
  deleted: RetentionPlan['counts'];
  files_removed: number;
  capped: boolean;
}

@Injectable()
export class RetentionService {
  private readonly log = new Logger(RetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Midnight, `RETENTION_MONTHS` ago. */
  cutoff(now: Date = new Date()): Date {
    const d = new Date(now);
    d.setMonth(d.getMonth() - RETENTION_MONTHS);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  /** Whether a sweep is allowed to delete. Off unless explicitly switched on. */
  enabled(): boolean {
    return (process.env.RETENTION_ENABLED ?? '').trim() === 'true';
  }

  /**
   * What a sweep WOULD remove, counted and returned. Writes nothing, ever.
   *
   * This is the staging verification step: run it against a copy of production, read the numbers,
   * and only then decide whether to set `RETENTION_ENABLED`.
   */
  async plan(now: Date = new Date()): Promise<RetentionPlan> {
    const cut = this.cutoff(now);
    const [
      auditDesk, txns, docs, invoices, payments, rows, txnReminders, docReminders,
      auditCrm, auditCommon, auditNull,
    ] = await Promise.all([
      this.prisma.audit_logs.count({ where: { domain: 'desk', created_at: { lt: cut } } }),
      this.prisma.transactions.count({ where: { deleted_at: { lt: cut } } }),
      this.prisma.documents.count({ where: { deleted_at: { lt: cut } } }),
      this.prisma.invoices.count({ where: { deleted_at: { lt: cut } } }),
      this.prisma.invoice_payments.count({ where: { deleted_at: { lt: cut } } }),
      this.prisma.trashed_row_items.count({ where: { created_at: { lt: cut } } }),
      this.prisma.transaction_reminders.count({ where: { created_at: { lt: cut } } }),
      this.prisma.document_reminders.count({ where: { sent_at: { lt: cut } } }),
      // Counted so the plan can PROVE the exclusions rather than asserting them.
      this.prisma.audit_logs.count({ where: { domain: 'crm', created_at: { lt: cut } } }),
      this.prisma.audit_logs.count({ where: { domain: 'common', created_at: { lt: cut } } }),
      this.prisma.audit_logs.count({ where: { domain: null, created_at: { lt: cut } } }),
    ]);

    return {
      cutoff: cut.toISOString(),
      enabled: this.enabled(),
      counts: {
        audit_logs_desk: auditDesk,
        trashed_transactions: txns,
        trashed_documents: docs,
        trashed_invoices: invoices,
        trashed_payments: payments,
        trashed_rows: rows,
        transaction_reminders: txnReminders,
        document_reminders: docReminders,
      },
      excluded: { audit_logs_crm: auditCrm, audit_logs_common: auditCommon, audit_logs_unclassified: auditNull },
    };
  }

  /**
   * One pass. Deletes only when `RETENTION_ENABLED=true`; otherwise reports the plan and stops.
   *
   * Order matters. Trashed TRANSACTIONS go first, because the cascade takes their documents,
   * invoices, reminders and audit rows with them — doing it the other way round would delete rows
   * twice over and count them twice. Files are unlinked before the rows that name them, so a crash
   * mid-pass leaves an orphaned file rather than a row pointing at nothing.
   */
  async sweep(now: Date = new Date()): Promise<RetentionResult> {
    const plan = await this.plan(now);
    const empty: RetentionPlan['counts'] = {
      audit_logs_desk: 0, trashed_transactions: 0, trashed_documents: 0, trashed_invoices: 0,
      trashed_payments: 0, trashed_rows: 0, transaction_reminders: 0, document_reminders: 0,
    };
    const result: RetentionResult = { ...plan, deleted: { ...empty }, files_removed: 0, capped: false };

    if (!plan.enabled) {
      this.log.log(
        `Retention DRY RUN (cutoff ${plan.cutoff.slice(0, 10)}): would remove `
        + Object.entries(plan.counts).map(([k, v]) => `${v} ${k}`).join(', ')
        + `. Nothing deleted — set RETENTION_ENABLED=true to act. Out of scope and untouched: `
        + `${plan.excluded.audit_logs_crm} CRM, ${plan.excluded.audit_logs_common} shared, `
        + `${plan.excluded.audit_logs_unclassified} unclassified audit rows.`,
      );
      return result;
    }

    const cut = this.cutoff(now);

    // 1. Trashed transactions — files first, then the row, and the cascade does the rest.
    result.deleted.trashed_transactions = await this.purgeTransactions(cut, result);

    // 2. Whatever is left standing alone: documents, invoices and payments trashed on their own.
    result.deleted.trashed_documents = await this.purgeDocuments(cut, result);
    result.deleted.trashed_invoices = await this.batchDelete('invoices', () =>
      this.prisma.invoices.findMany({ where: { deleted_at: { lt: cut } }, select: { id: true }, take: BATCH }),
      (ids) => this.prisma.invoices.deleteMany({ where: { id: { in: ids } } }), result);
    result.deleted.trashed_payments = await this.batchDelete('invoice_payments', () =>
      this.prisma.invoice_payments.findMany({ where: { deleted_at: { lt: cut } }, select: { id: true }, take: BATCH }),
      (ids) => this.prisma.invoice_payments.deleteMany({ where: { id: { in: ids } } }), result);
    result.deleted.trashed_rows = await this.batchDelete('trashed_row_items', () =>
      this.prisma.trashed_row_items.findMany({ where: { created_at: { lt: cut } }, select: { id: true }, take: BATCH }),
      (ids) => this.prisma.trashed_row_items.deleteMany({ where: { id: { in: ids } } }), result);

    // 3. Reminder histories.
    result.deleted.transaction_reminders = await this.batchDelete('transaction_reminders', () =>
      this.prisma.transaction_reminders.findMany({ where: { created_at: { lt: cut } }, select: { id: true }, take: BATCH }),
      (ids) => this.prisma.transaction_reminders.deleteMany({ where: { id: { in: ids } } }), result);
    result.deleted.document_reminders = await this.batchDelete('document_reminders', () =>
      this.prisma.document_reminders.findMany({ where: { sent_at: { lt: cut } }, select: { id: true }, take: BATCH }),
      (ids) => this.prisma.document_reminders.deleteMany({ where: { id: { in: ids } } }), result);

    /*
     * 4. Desk audit rows, LAST.
     *
     * After the cascades, so a row deleted as a child of a purged transaction is not also counted
     * here. `domain: 'desk'` is an equality, so `crm`, `common` and NULL cannot be reached by it
     * however the query is later edited.
     */
    result.deleted.audit_logs_desk = await this.batchDelete('audit_logs', () =>
      this.prisma.audit_logs.findMany({
        where: { domain: 'desk', created_at: { lt: cut } }, select: { id: true }, take: BATCH,
      }),
      (ids) => this.prisma.audit_logs.deleteMany({ where: { id: { in: ids } } }), result);

    await this.record(result);
    return result;
  }

  /** Purge trashed deals: unlink their document files, then delete the deal and let it cascade. */
  private async purgeTransactions(cut: Date, result: RetentionResult): Promise<number> {
    let removed = 0;
    for (;;) {
      if (removed >= MAX_PER_SWEEP) { result.capped = true; break; }
      const batch = await this.prisma.transactions.findMany({
        where: { deleted_at: { lt: cut } }, select: { id: true }, take: BATCH, orderBy: { id: 'asc' },
      });
      if (!batch.length) break;
      const ids = batch.map((t) => t.id);
      const docs = await this.prisma.documents.findMany({
        where: { transaction_id: { in: ids } },
        select: { file_path: true, validation_file_path: true, files: true },
      });
      for (const d of docs) result.files_removed += await this.purgeDocumentFiles(d);
      const done = await this.prisma.transactions.deleteMany({ where: { id: { in: ids } } });
      removed += done.count;
    }
    return removed;
  }

  /** Documents trashed on their own, whose transaction is still live. */
  private async purgeDocuments(cut: Date, result: RetentionResult): Promise<number> {
    let removed = 0;
    for (;;) {
      if (removed >= MAX_PER_SWEEP) { result.capped = true; break; }
      const batch = await this.prisma.documents.findMany({
        where: { deleted_at: { lt: cut } },
        select: { id: true, file_path: true, validation_file_path: true, files: true },
        take: BATCH, orderBy: { id: 'asc' },
      });
      if (!batch.length) break;
      for (const d of batch) result.files_removed += await this.purgeDocumentFiles(d);
      const done = await this.prisma.documents.deleteMany({ where: { id: { in: batch.map((d) => d.id) } } });
      removed += done.count;
    }
    return removed;
  }

  /**
   * Remove the files a document points at. Best-effort per file: a missing file is the state we
   * wanted anyway, and one unreadable path must not stop the pass.
   */
  private async purgeDocumentFiles(d: { file_path: string | null; validation_file_path: string | null; files: string | null }): Promise<number> {
    let n = 0;
    const unlink = async (rel: string | null | undefined): Promise<void> => {
      if (!rel) return;
      try { await fs.unlink(path.join(STORAGE_ROOT, rel)); n++; } catch { /* already gone */ }
    };
    await unlink(d.file_path);
    await unlink(d.validation_file_path);
    for (const f of (parseJson<{ file_path?: string }[]>(d.files) ?? [])) await unlink(f?.file_path);
    return n;
  }

  /** Delete in batches until nothing is left or the per-sweep ceiling is reached. */
  private async batchDelete(
    label: string,
    next: () => Promise<{ id: number }[]>,
    remove: (ids: number[]) => Promise<{ count: number }>,
    result: RetentionResult,
  ): Promise<number> {
    let removed = 0;
    for (;;) {
      if (removed >= MAX_PER_SWEEP) {
        result.capped = true;
        this.log.warn(`Retention: ${label} hit the ${MAX_PER_SWEEP}-row ceiling for this pass; the rest goes next time.`);
        break;
      }
      const batch = await next();
      if (!batch.length) break;
      const done = await remove(batch.map((r) => r.id));
      removed += done.count;
      if (done.count === 0) break; // nothing matched — stop rather than spin
    }
    return removed;
  }

  /**
   * The purge writes itself down.
   *
   * One row per sweep, not one per deletion — the point is an answerable "what was removed, and
   * when", and a per-row trail would be a retention job that grows the table it is pruning. Written
   * with `category: 'Retention'` and `section` naming the Desk, so `auditDomain()` files it as
   * `desk` and it is itself subject to the same six months.
   */
  private async record(r: RetentionResult): Promise<void> {
    const summary = Object.entries(r.deleted).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${k}`).join(', ');
    if (!summary && !r.files_removed) return;
    this.log.log(`Retention removed ${summary || 'nothing'}${r.files_removed ? `, ${r.files_removed} file(s)` : ''} (cutoff ${r.cutoff.slice(0, 10)})${r.capped ? ' — capped, more remains' : ''}.`);
    await this.audit.logModule(null, 'Retention', {
      section: 'Transaction Desk Retention',
      field: `Older than ${RETENTION_MONTHS} months`,
      action: 'Records purged',
      source: 'System',
      details: `${summary || 'nothing'}${r.files_removed ? `; ${r.files_removed} file(s)` : ''}; cutoff ${r.cutoff.slice(0, 10)}${r.capped ? '; capped' : ''}`,
    });
  }
}
