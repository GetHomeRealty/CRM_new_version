import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { schedulersEnabled, schedulerSkipReason } from '../common/schedulers';
import { IMPORT_BATCH_SIZE, LeadImportEngine, emptyTally } from './lead-import.engine';
import { hasBrokerageLeadScope, ownerAtIntake } from '../common/lead-scope';
import type { AuthUserRecord } from '../auth/auth.types';

/** Above this the file is refused outright rather than accepted and run for an hour. */
const MAX_IMPORT_ROWS = 50_000;

export interface ImportJobView {
  job_id: string;
  status: string;
  total_rows: number;
  processed_rows: number;
  percent: number;
  imported: number;
  tagged: number;
  duplicate: number;
  invalid: number;
  failure_reason: string | null;
  /** Ready-made for the UI, so every screen phrases progress the same way. */
  message: string;
  done: boolean;
}

/**
 * Runs CSV lead imports off the request thread.
 *
 * WHY THIS EXISTS. Importing used to happen inside the HTTP request that asked for it. A 5,000-row
 * file against 40,000 existing leads took ~132 seconds in lookups alone — longer than a default
 * nginx timeout — so the browser got a 504 while the server carried on writing. Nothing was
 * transactional and nothing recorded where it had reached, so the operator saw a failure over a
 * partially-imported file and re-running it reprocessed everything already written.
 *
 * The queue is in-process and serial, matching `export-job.service.ts` — this deployment runs a
 * single API node, and two imports racing on the same file would fight over the same addresses.
 * Swapping in a real broker later means replacing `enqueue` and `drain`, nothing else.
 *
 * PROGRESS IS PERSISTED, NOT HELD IN MEMORY, so a client polling from a different browser tab (or
 * after a refresh) sees the same numbers, and a restart can tell what was in flight.
 */
@Injectable()
export class LeadImportJobService implements OnModuleInit {
  private readonly log = new Logger(LeadImportJobService.name);
  private queue: number[] = [];
  private draining = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: LeadImportEngine,
  ) {}

  async onModuleInit(): Promise<void> {
    // Only the scheduler owner reclaims: on a second instance this would mark a job as failed
    // while the first instance was still happily running it.
    if (!schedulersEnabled()) {
      this.log.log(`Lead-import reclaim not started (${schedulerSkipReason()}). Imports queued on this process still run.`);
      return;
    }

    // A job left mid-flight by a restart cannot be resumed — the batch loop's position lives in
    // memory — but it MUST NOT be left saying "Processing" forever, which would show a progress
    // bar that never moves. It is failed with a reason that says what to do, and the rows it did
    // import are already committed, so re-importing the same file is safe: existing addresses are
    // recognised and tagged rather than duplicated.
    const stranded = await this.prisma.lead_import_jobs.updateMany({
      where: { status: 'Processing' },
      data: {
        status: 'Failed',
        failure_reason: 'The server restarted while this import was running. Rows imported before the restart were kept — re-importing the same file will skip them.',
        completed_at: new Date(),
        payload: null,
      },
    });
    if (stranded.count) this.log.warn(`Marked ${stranded.count} interrupted lead import(s) as failed.`);

    const queued = await this.prisma.lead_import_jobs.findMany({
      where: { status: 'Queued' }, select: { id: true }, orderBy: { id: 'asc' },
    });
    this.queue.push(...queued.map((j) => j.id));
    if (this.queue.length) {
      this.log.log(`Resuming ${this.queue.length} queued lead import(s).`);
      void this.drain();
    }
  }

  // ------------------------------------------------------------------ enqueue

  async enqueue(csv: string, tag: string, source: 'leads' | 'campaigns', user: AuthUserRecord): Promise<ImportJobView> {
    // Parsed up front so an unusable file is rejected while somebody is still looking at the
    // screen, rather than becoming a job that fails a minute later.
    const rows = this.engine.parseCsv(csv);
    if (!rows.length) {
      throw new BadRequestException({ message: 'No rows found. Include a header row with at least name and email.' });
    }
    if (rows.length > MAX_IMPORT_ROWS) {
      throw new BadRequestException({
        message: `That file has ${rows.length.toLocaleString()} rows, above the ${MAX_IMPORT_ROWS.toLocaleString()}-row limit. Split it and import in parts.`,
      });
    }

    const now = new Date();
    const job = await this.prisma.lead_import_jobs.create({
      data: {
        job_id: randomBytes(16).toString('hex'),
        status: 'Queued',
        source,
        tag: tag || null,
        payload: csv,
        total_rows: rows.length,
        requested_by: user.name ?? null,
        requested_by_id: user.id ?? null,
        requested_at: now,
        created_at: now,
        updated_at: now,
      },
    });

    this.queue.push(job.id);
    void this.drain();
    return this.view(job);
  }

  // ------------------------------------------------------------------ status

  async status(jobId: string): Promise<ImportJobView> {
    const job = await this.prisma.lead_import_jobs.findFirst({ where: { job_id: jobId } });
    if (!job) throw new NotFoundException({ message: 'That import could not be found.' });
    return this.view(job);
  }

  /** The caller's recent imports, newest first — so a refreshed page can find a job in flight. */
  async recent(user: AuthUserRecord, limit = 5): Promise<ImportJobView[]> {
    const rows = await this.prisma.lead_import_jobs.findMany({
      where: { requested_by_id: user.id ?? -1 },
      orderBy: { id: 'desc' },
      take: limit,
    });
    return rows.map((r) => this.view(r));
  }

  // ------------------------------------------------------------------ queue

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        const id = this.queue.shift();
        if (id !== undefined) await this.run(id);
      }
    } finally {
      this.draining = false;
    }
  }

  private async run(id: number): Promise<void> {
    // Runs on a timer, with no request in context — the job row carries everything it needs.
    const job = await this.prisma.lead_import_jobs.findUnique({ where: { id } });
    if (!job || job.status !== 'Queued' || !job.payload) return;

    const started = Date.now();
    await this.prisma.lead_import_jobs.update({
      where: { id }, data: { status: 'Processing', started_at: new Date(), updated_at: new Date() },
    });

    const total = emptyTally();
    let processed = 0;

    try {
      const rows = this.engine.parseCsv(job.payload);
      // The requester's data scope, read once per job: the engine needs it to decide which existing
      // leads are theirs to tag. Cheap, and it keeps the rule identical to the Leads module's — the
      // import runs on a timer with no request in context, so the role has to be fetched here.
      const requester = job.requested_by_id
        ? await this.prisma.users.findUnique({ where: { id: job.requested_by_id! }, select: { role: true } })
        : null;
      const principal = { id: job.requested_by_id, role: requester?.role ?? '' };
      const ctx = {
        tag: job.tag ?? '', userName: job.requested_by, userId: job.requested_by_id,
        // Ownership and scope are both decided from the requester's role, once, here — the import
        // runs on a timer with no request in context.
        ownerId: ownerAtIntake(principal),
        userHasBrokerageScope: hasBrokerageLeadScope(principal),
      };
      // Spans batches, so a duplicate address either side of a boundary is still caught.
      const seen = new Set<string>();

      for (let i = 0; i < rows.length; i += IMPORT_BATCH_SIZE) {
        const batch = rows.slice(i, i + IMPORT_BATCH_SIZE);
        const tally = await this.engine.runBatch(batch, ctx, seen);
        total.imported += tally.imported;
        total.tagged += tally.tagged;
        total.duplicate += tally.duplicate;
        total.invalid += tally.invalid;
        processed += batch.length;

        // Written once per batch, not per row: this is what a client polls, and 100 writes for a
        // 50,000-row file is negligible where 50,000 would not be.
        await this.prisma.lead_import_jobs.update({
          where: { id },
          data: { processed_rows: processed, ...total, updated_at: new Date() },
        });
      }

      await this.prisma.lead_import_jobs.update({
        where: { id },
        data: {
          status: 'Completed', processed_rows: processed, ...total,
          completed_at: new Date(), updated_at: new Date(),
          payload: null,   // the uploaded file has served its purpose; do not keep it forever
        },
      });
      this.log.log(`Lead import ${job.job_id}: ${total.imported} imported, ${total.duplicate} existing, ${total.invalid} invalid in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log.error(`Lead import ${job.job_id} failed after ${processed} rows: ${reason}`);
      await this.prisma.lead_import_jobs.update({
        where: { id },
        data: {
          status: 'Failed', processed_rows: processed, ...total,
          // Says what survived, because "it failed" over a partial import is the worst thing to
          // read: batches already committed are kept, and re-importing skips them.
          failure_reason: `${reason} — ${total.imported} lead(s) imported before the failure were kept. Re-importing the same file will skip them.`,
          completed_at: new Date(), updated_at: new Date(), payload: null,
        },
      });
    }
  }

  // ------------------------------------------------------------------ view

  private view(job: {
    job_id: string; status: string; total_rows: number; processed_rows: number;
    imported: number; tagged: number; duplicate: number; invalid: number; failure_reason: string | null;
  }): ImportJobView {
    const done = job.status === 'Completed' || job.status === 'Failed';
    const percent = job.total_rows ? Math.min(100, Math.round((job.processed_rows / job.total_rows) * 100)) : 0;

    let message: string;
    if (job.status === 'Queued') message = `Queued — ${job.total_rows.toLocaleString()} rows to import.`;
    else if (job.status === 'Processing') message = `${job.processed_rows.toLocaleString()} of ${job.total_rows.toLocaleString()} leads imported…`;
    else if (job.status === 'Failed') message = job.failure_reason ?? 'The import failed.';
    else {
      const parts = [`${job.imported.toLocaleString()} imported`];
      if (job.tagged) parts.push(`${job.tagged.toLocaleString()} tagged`);
      if (job.duplicate) parts.push(`${job.duplicate.toLocaleString()} already existed`);
      /*
       * SAYS WHY, because "skipped" on its own is unactionable.
       *
       * There is exactly one reason a row is counted invalid: it carried no usable email address.
       * An agent importing a list gathered by phone therefore saw "0 imported, 500 skipped" and no
       * hint that the address column was the problem — the commonest confusion this screen
       * produces. Naming the cause turns it into something they can fix in the spreadsheet.
       */
      if (job.invalid) parts.push(`${job.invalid.toLocaleString()} skipped (no email address)`);
      message = parts.join(', ') + '.';
    }

    return {
      job_id: job.job_id, status: job.status,
      total_rows: job.total_rows, processed_rows: job.processed_rows, percent,
      imported: job.imported, tagged: job.tagged, duplicate: job.duplicate, invalid: job.invalid,
      failure_reason: job.failure_reason, message, done,
    };
  }
}
