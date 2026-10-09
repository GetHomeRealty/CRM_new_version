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
 * delete unless `DESK_RETENTION_ENABLED=true` is set in the environment — so deploying this code does
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
  /**
   * Files the sweep tried to remove and could not — a permission error, a locked file, or a path
   * that resolves outside the storage root. Counted rather than swallowed: a sweep that quietly
   * skipped them would report a clean run while the bytes stayed, which is how the Recycle Bin's
   * own leak went unnoticed for so long.
   */
  files_failed: number;
  /**
   * Records left in place rather than purged — because their files could not be removed, or
   * because the delete itself failed. They stay eligible, so the next sweep tries again once
   * whatever blocked it is cleared.
   */
  records_retained: number;
  /**
   * Records whose DATABASE delete failed. Counted apart from `files_failed` because the two mean
   * different things to whoever reads the log: one says storage is unhappy, the other says the
   * database refused, and they are fixed in different places.
   */
  delete_failures: number;
  capped: boolean;
}

/*
 * TD-162 - NOTHING THE CLEAN-UP REMOVES MAY TAKE A RECORDED PAYMENT WITH IT.
 *
 * The brokerage's rule (2026-09-09): an invoice with a recorded payment can be neither voided nor
 * deleted. The database CASCADEs deal -> invoices -> invoice_payments, so a bulk delete of trashed
 * deals or trashed invoices erased live payments without asking - the one path the hand-operated
 * Recycle Bin already refused. A deal or invoice that still holds a live payment is therefore left
 * in the bin, and the plan does not count it as due. A payment that was itself removed is not live.
 */
const trashedDealWithoutPayments = (cut: Date) => ({
  deleted_at: { lt: cut },
  invoices: { none: { invoice_payments: { some: { deleted_at: null } } } },
});
const trashedInvoiceWithoutPayments = (cut: Date) => ({
  deleted_at: { lt: cut },
  invoice_payments: { none: { deleted_at: null } },
});

@Injectable()
export class RetentionService {
  private readonly log = new Logger(RetentionService.name);

  /**
   * Rows per batch. `protected` rather than a bare constant so a test can shrink it and exercise
   * the MULTI-BATCH path — the cursor, and what happens to the batches after one that kept a
   * record. Seeding 500 deals to reach the second batch would make that test unrunnable, so the
   * property would go untested, which is how a cursor bug survives.
   */
  protected readonly batchSize: number = BATCH;

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

  /**
   * Whether a sweep is allowed to delete. Off unless explicitly switched on, by ITS OWN name.
   *
   * This used to read `RETENTION_ENABLED`, which the notification sweep also read. That put two
   * very different operations behind one variable: notification housekeeping clears two tables of
   * expired signals, while THIS deletes trashed deals and cascades into twenty child tables —
   * `transaction_reviews` among them — and removes `audit_logs` and `transaction_reminders` by age
   * alone. Enabling the small one silently armed the large one.
   *
   * `DESK_RETENTION_ENABLED` names what it switches on. The old flag is not read here, not even as
   * a fallback: production has `RETENTION_ENABLED=true` set today, so a fallback would leave this
   * sweep armed by exactly the value the separation exists to stop honouring.
   *
   * Absent or malformed means FALSE. This deletes business records; it must fail closed.
   */
  enabled(): boolean {
    // Case-SENSITIVE, exactly as this sweep has always been: only the literal `true` arms it, so
    // `TRUE` or `True` leaves it off. Kept deliberately — for the destructive sweep the stricter
    // reading is the safer one, and its spec asserts it. Only the variable's NAME changed here.
    return (process.env.DESK_RETENTION_ENABLED ?? '').trim() === 'true';
  }

  /**
   * What a sweep WOULD remove, counted and returned. Writes nothing, ever.
   *
   * This is the staging verification step: run it against a copy of production, read the numbers,
   * and only then decide whether to set `DESK_RETENTION_ENABLED`.
   */
  async plan(now: Date = new Date()): Promise<RetentionPlan> {
    const cut = this.cutoff(now);
    const [
      auditDesk, txns, docs, invoices, payments, rows, txnReminders, docReminders,
      auditCrm, auditCommon, auditNull,
    ] = await Promise.all([
      this.prisma.audit_logs.count({ where: { domain: 'desk', created_at: { lt: cut } } }),
      this.prisma.transactions.count({ where: trashedDealWithoutPayments(cut) }),
      this.prisma.documents.count({ where: { deleted_at: { lt: cut } } }),
      this.prisma.invoices.count({ where: trashedInvoiceWithoutPayments(cut) }),
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
   * One pass. Deletes only when `DESK_RETENTION_ENABLED=true`; otherwise reports the plan and stops.
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
    const result: RetentionResult = {
      ...plan, deleted: { ...empty }, files_removed: 0, files_failed: 0, records_retained: 0,
      delete_failures: 0, capped: false,
    };

    if (!plan.enabled) {
      this.log.log(
        `Retention DRY RUN (cutoff ${plan.cutoff.slice(0, 10)}): would remove `
        + Object.entries(plan.counts).map(([k, v]) => `${v} ${k}`).join(', ')
        + `. Nothing deleted — set DESK_RETENTION_ENABLED=true to act. Out of scope and untouched: `
        + `${plan.excluded.audit_logs_crm} CRM, ${plan.excluded.audit_logs_common} shared, `
        + `${plan.excluded.audit_logs_unclassified} unclassified audit rows.`,
      );
      return result;
    }

    const cut = this.cutoff(now);

    /*
     * A FAILURE THAT ESCAPES THE PER-RECORD HANDLING STILL HAS TO SAY WHAT HAD ALREADY HAPPENED.
     *
     * Record-level trouble is handled where it happens and the pass carries on. What reaches here
     * is broader — a lost connection, a statement timeout — and it used to propagate with the
     * counts still in a local variable, so the scheduler logged "Retention sweep failed: …" and
     * nothing recorded the nine hundred files the pass HAD removed before it died. The next person
     * reading the log could not tell a sweep that did nothing from one that did almost everything.
     *
     * The error is re-thrown unchanged: the scheduler owns the decision about a failed pass, and
     * swallowing it here would turn an aborted sweep into a reported success.
     */
    try {
      return await this.sweepFrom(cut, result);
    } catch (ex) {
      this.log.error(
        `Retention sweep ABORTED (cutoff ${plan.cutoff.slice(0, 10)}): ${(ex as Error).message}. `
        + `Completed before it stopped: ${this.summarise(result) || 'nothing'}.`,
      );
      throw ex;
    }
  }

  /** One line naming everything a pass did, used by both the abort log and the audit entry. */
  private summarise(r: RetentionResult): string {
    const rows = Object.entries(r.deleted).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${k}`).join(', ');
    const parts = [rows, r.files_removed ? `${r.files_removed} file(s)` : ''].filter(Boolean);
    if (r.files_failed) parts.push(`${r.files_failed} file(s) unremovable`);
    if (r.delete_failures) parts.push(`${r.delete_failures} delete(s) refused`);
    if (r.records_retained) parts.push(`${r.records_retained} record(s) kept for the next sweep`);
    return parts.join('; ');
  }

  /** The passes themselves, in order. Split out so `sweep` can report what was done if one throws. */
  private async sweepFrom(cut: Date, result: RetentionResult): Promise<RetentionResult> {

    // 1. Trashed transactions — files first, then the row, and the cascade does the rest.
    result.deleted.trashed_transactions = await this.purgeTransactions(cut, result);

    // 2. Whatever is left standing alone: documents, invoices and payments trashed on their own.
    result.deleted.trashed_documents = await this.purgeDocuments(cut, result);
    result.deleted.trashed_invoices = await this.batchDelete('invoices', () =>
      this.prisma.invoices.findMany({ where: trashedInvoiceWithoutPayments(cut), select: { id: true }, take: BATCH }),
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

  /**
   * Purge trashed deals: unlink their document files, then delete the deal and let it cascade.
   *
   * A DEAL WHOSE FILES COULD NOT BE REMOVED IS LEFT ALONE — the row and its paths are the only way
   * back to those bytes, so losing them would strand the files permanently. It stays eligible and
   * the next sweep tries again. One unreachable file therefore costs one deal, not the pass.
   *
   * THE BATCH IS WALKED BY CURSOR rather than re-queried from the start. While every fetched row
   * was deleted, re-querying terminated naturally; now that a row can be RETAINED it would be
   * fetched again for ever. `id > lastSeen` steps past it instead.
   */
  private async purgeTransactions(cut: Date, result: RetentionResult): Promise<number> {
    let removed = 0;
    let after = 0;
    for (;;) {
      if (removed >= MAX_PER_SWEEP) { result.capped = true; break; }
      const batch = await this.prisma.transactions.findMany({
        where: { AND: [trashedDealWithoutPayments(cut), { id: { gt: after } }] },
        select: { id: true }, take: this.batchSize, orderBy: { id: 'asc' },
      });
      if (!batch.length) break;
      const ids = batch.map((t) => t.id);
      after = ids[ids.length - 1];

      const docs = await this.prisma.documents.findMany({
        where: { transaction_id: { in: ids } },
        select: { transaction_id: true, file_path: true, validation_file_path: true, files: true, draft_files: true },
      });

      // Which deals in this batch still hold a file nobody could remove.
      const blocked = new Set<number>();
      for (const d of docs) {
        const outcome = await this.purgeDocumentFiles(d);
        result.files_removed += outcome.removed;
        if (outcome.failed.length) {
          result.files_failed += outcome.failed.length;
          blocked.add(d.transaction_id);
          this.log.warn(`Retention kept deal ${d.transaction_id}: ${outcome.failed.join('; ')}`);
        }
      }

      const deletable = ids.filter((id) => !blocked.has(id));
      result.records_retained += blocked.size;
      removed += await this.deleteIsolated(
        this.prisma.transactions as never, 'deal', deletable, result,
      );
    }
    return removed;
  }

  /** Documents trashed on their own, whose transaction is still live. Same rules as the deal path. */
  private async purgeDocuments(cut: Date, result: RetentionResult): Promise<number> {
    let removed = 0;
    let after = 0;
    for (;;) {
      if (removed >= MAX_PER_SWEEP) { result.capped = true; break; }
      const batch = await this.prisma.documents.findMany({
        where: { deleted_at: { lt: cut }, id: { gt: after } },
        select: { id: true, file_path: true, validation_file_path: true, files: true, draft_files: true },
        take: this.batchSize, orderBy: { id: 'asc' },
      });
      if (!batch.length) break;
      after = batch[batch.length - 1].id;

      const deletable: number[] = [];
      for (const d of batch) {
        const outcome = await this.purgeDocumentFiles(d);
        result.files_removed += outcome.removed;
        if (outcome.failed.length) {
          result.files_failed += outcome.failed.length;
          result.records_retained += 1;
          this.log.warn(`Retention kept document ${d.id}: ${outcome.failed.join('; ')}`);
          continue;
        }
        deletable.push(d.id);
      }

      removed += await this.deleteIsolated(
        this.prisma.documents as never, 'document', deletable, result,
      );
    }
    return removed;
  }

  /**
   * Delete these rows, isolating a failure to the records it actually affects.
   *
   * ONE STATEMENT FIRST, BECAUSE THAT IS THE NORMAL CASE and a row-at-a-time sweep over five years
   * of history would be thousands of round trips for no reason. But a `deleteMany` is all or
   * nothing: one row the database refuses — a foreign key nobody expected, a lock held by somebody
   * else — took its whole batch down with it, and before this took the entire sweep with it too.
   *
   * So a failure drops to one row at a time. The rows that can go, go; the ones that cannot are
   * counted, logged by id, and left exactly as they were, with their paths, for the next sweep.
   * The files of a retained row are already gone — that is the cost of unlinking first, and the
   * reason the row must survive: it is the only record that those files ever existed.
   */
  private async deleteIsolated(
    table: { deleteMany: (a: unknown) => Promise<{ count: number }>; delete: (a: unknown) => Promise<unknown> },
    label: string,
    ids: number[],
    result: RetentionResult,
  ): Promise<number> {
    if (!ids.length) return 0;
    try {
      return (await table.deleteMany({ where: { id: { in: ids } } })).count;
    } catch (ex) {
      this.log.warn(`Retention: deleting ${ids.length} ${label} together failed (${(ex as Error).message}); trying them one at a time.`);
      let done = 0;
      for (const id of ids) {
        try {
          await table.delete({ where: { id } });
          done += 1;
        } catch (inner) {
          result.delete_failures += 1;
          result.records_retained += 1;
          this.log.warn(`Retention kept ${label} ${id}: delete failed (${(inner as Error).message}).`);
        }
      }
      return done;
    }
  }

  /** Is this resolved path textually inside `root`? */
  private static within(root: string, abs: string): boolean {
    const rel = path.relative(root, abs);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  /**
   * The storage root with links resolved. The root itself may be one — a deployment pointing
   * `storage/app` at a mounted volume is ordinary — and comparing a resolved file against an
   * unresolved root would put every legitimate file "outside" and purge nothing.
   */
  private async realStorageRoot(): Promise<string> {
    const root = path.resolve(STORAGE_ROOT);
    return fs.realpath(root).catch(() => root);
  }

  /**
   * What to do with one stored path: unlink this absolute path, treat it as already gone, or refuse.
   *
   * TWO CHECKS, BECAUSE THEY CATCH DIFFERENT THINGS. The textual one stops `../../.env`, which
   * `path.join` would resolve happily and which `realpath` cannot help with when the target does
   * not exist. The second RESOLVES LINKS: `documents/x/f.pdf` is textually inside the root however
   * many symlinks lie along it, so if `documents/x` points at another volume only `realpath` can
   * tell. Containment is a question about the filesystem, not about the spelling of a string.
   *
   * This mirrors `RecycleBinService`, deliberately and with the duplication acknowledged: both
   * paths unlink the same files under the same root and must not disagree about what is reachable.
   * Worth extracting to a shared helper, which is a change to both modules rather than this one.
   */
  private async resolveForUnlink(rel: string): Promise<{ abs: string } | { gone: true } | { refuse: string }> {
    const root = await this.realStorageRoot();
    const abs = path.resolve(root, rel);
    if (!RetentionService.within(root, abs)) return { refuse: 'outside the storage root' };

    let real: string;
    try {
      real = await fs.realpath(abs);
    } catch (ex) {
      const code = (ex as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { gone: true };
      return { refuse: code ?? (ex as Error).message };
    }
    if (!RetentionService.within(root, real)) return { refuse: 'resolves outside the storage root through a link' };
    return { abs: real };
  }

  /**
   * Remove every file a document points at — all four sources, including the agent's unsubmitted
   * `draft_files`, which this sweep used to ignore entirely and so orphaned on every purge.
   *
   * ALREADY GONE IS SUCCESS, ANYTHING ELSE IS NOT. `ENOENT` means the file is in the state the
   * sweep wanted. A permission error, a locked file or a path that escapes the root is a real
   * failure, and the caller keeps the record so the paths survive for the next pass.
   *
   * EVERY FILE IS ATTEMPTED even once one has failed, so an operator sees the whole problem at once
   * rather than discovering it one sweep at a time. Nothing is thrown: this runs over many records
   * and one bad file must cost its own record, not the pass.
   */
  private async purgeDocumentFiles(
    d: { file_path: string | null; validation_file_path: string | null; files: string | null; draft_files?: string | null },
  ): Promise<{ removed: number; failed: string[] }> {
    let removed = 0;
    const failed: string[] = [];

    const unlink = async (rel: string | null | undefined): Promise<void> => {
      if (!rel) return;
      const target = await this.resolveForUnlink(rel);
      if ('gone' in target) return;                                    // nothing there — already done
      if ('refuse' in target) { failed.push(`${rel} (${target.refuse})`); return; }
      try {
        await fs.unlink(target.abs);
        removed += 1;
      } catch (ex) {
        const code = (ex as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return;   // removed between the check and the unlink; still done
        failed.push(`${rel} (${code ?? (ex as Error).message})`);
      }
    };

    await unlink(d.file_path);
    await unlink(d.validation_file_path);
    for (const f of (parseJson<{ file_path?: string }[]>(d.files) ?? [])) await unlink(f?.file_path);
    for (const f of (parseJson<{ file_path?: string }[]>(d.draft_files) ?? [])) await unlink(f?.file_path);

    return { removed, failed };
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
    /*
     * The failures are named in the same breath as the successes. A run that removed nine hundred
     * files and could not remove three is not a clean run, and a summary mentioning only the nine
     * hundred would read like one — so `summarise` carries both, and the audit entry and the log
     * line say the same thing rather than drifting apart.
     */
    const summary = this.summarise(r);
    if (!summary) return;
    this.log.log(`Retention: ${summary} (cutoff ${r.cutoff.slice(0, 10)})${r.capped ? ' — capped, more remains' : ''}.`);
    await this.audit.logModule(null, 'Retention', {
      section: 'Transaction Desk Retention',
      field: `Older than ${RETENTION_MONTHS} months`,
      action: 'Records purged',
      source: 'System',
      details: `${summary}; cutoff ${r.cutoff.slice(0, 10)}${r.capped ? '; capped' : ''}`,
    });
  }
}
