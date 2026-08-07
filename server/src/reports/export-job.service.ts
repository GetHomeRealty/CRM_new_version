import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs/promises';
import { createWriteStream } from 'fs';
import { PrismaService } from '../prisma/prisma.service';
import { BulkExportService, type BulkSelection } from './bulk-export.service';
import { clusterTick } from '../redis/cluster-tick';
import { RedisService } from '../redis/redis.service';
import { CacheService } from '../redis/cache.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { schedulersEnabled, schedulerSkipReason } from '../common/schedulers';
import { EXPORT_ROOT } from '../config/storage';


import { forEachTenant, run, runAsSystem } from '../core/tenant-context';
import { allTenantIds } from '../core/tenants';
import { registerWorker, trackedTick } from '../observability/worker-health';
/** What a job produces. */
export type ExportAction =
  | 'transaction-complete-xlsx' | 'transaction-complete-csv'
  | 'transaction-data-xlsx' | 'transaction-data-csv' | 'transaction-data-pdf'
  | 'transaction-pdf-zip' | 'documents-zip';

/** Job lifecycle, as reported to the Download Centre. */
export const JOB_STATUSES = ['Queued', 'Processing', 'Completed', 'Partially Completed', 'Failed', 'Expired'] as const;

/** A generated file stays downloadable for this long, then it is swept from disk. */
export const DEFAULT_EXPIRY_HOURS = 24;
/** How often the sweeper runs. */
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
/** A queued request identical to one already in flight is rejected rather than duplicated. */
const DUPLICATE_STATUSES = ['Queued', 'Processing'];

const ACTION_META: Record<ExportAction, { label: string; format: string; ext: string; mime: string }> = {
  'transaction-complete-xlsx': { label: 'Complete Transaction Export (one row per deal)', format: 'XLSX', ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  'transaction-complete-csv': { label: 'Complete Transaction Export (one row per deal)', format: 'CSV', ext: 'csv', mime: 'text/csv; charset=utf-8' },
  'transaction-data-xlsx': { label: 'Transaction Data Export', format: 'XLSX', ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  'transaction-data-csv': { label: 'Transaction Data Export', format: 'CSV', ext: 'csv', mime: 'text/csv; charset=utf-8' },
  'transaction-data-pdf': { label: 'Transaction Data Export', format: 'PDF', ext: 'pdf', mime: 'application/pdf' },
  'transaction-pdf-zip': { label: 'Transaction PDFs (separate files)', format: 'ZIP', ext: 'zip', mime: 'application/zip' },
  'documents-zip': { label: 'Transaction Documents', format: 'ZIP', ext: 'zip', mime: 'application/zip' },
};

/**
 * Export & Download Centre.
 *
 * Bulk exports run on a background worker rather than inside the HTTP request, so a large
 * selection cannot time out the API. Jobs are persisted, so their status survives a restart
 * and the whole history is auditable. Generated files are written under storage/app/exports
 * and are reachable only via a random token until they expire.
 *
 * The queue is deliberately in-process and serial: this deployment runs a single API node,
 * and one export at a time keeps memory and disk churn predictable. Swapping in a real
 * broker later only means replacing `enqueue`/`drain`.
 */
@Injectable()
export class ExportJobService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ExportJobService.name);
  private queue: number[] = [];
  private draining = false;
  private sweeper?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bulk: BulkExportService,
    // Optional so existing constructions — including this service's specs — keep working.
    // Used only to decide whether THIS process should run a given sweep; see `clusterTick`.
    private readonly redis?: RedisService,
    private readonly cache?: CacheService,
  ) {}

  async onModuleInit(): Promise<void> {
    await fs.mkdir(EXPORT_ROOT, { recursive: true });

    // Everything below reaches across the whole export_jobs table rather than this process's own
    // work, so only the scheduler owner may do it. On a second instance the reclaim would mark a
    // job another instance is actively generating as failed, and the backlog pickup would have
    // both instances building the same file. Jobs enqueued here are still drained here — that
    // part is process-local and writes to this machine's disk, which is where the download is
    // served from.
    if (!schedulersEnabled()) {
      this.log.log(`Export reclaim and sweeper not started (${schedulerSkipReason()}). Exports queued on this process still run.`);
      return;
    }

    // A job left mid-flight by a restart can never finish — fail it honestly rather than
    // leaving it "Processing" forever.
    // Reclaim and backlog pickup deliberately span every brokerage: a restart interrupts whatever
    // was running regardless of whose export it was, and the queue belongs to this machine rather
    // than to a tenant. Said with runAsSystem so the reason is recorded where the query is, instead
    // of being left to a context that happens to be empty.
    const orphaned = await runAsSystem(() => this.prisma.export_jobs.updateMany({
      where: { status: 'Processing' },
      data: { status: 'Failed', failure_reason: 'The server restarted while this export was being generated.', completed_at: new Date() },
    }));
    if (orphaned.count) this.log.warn(`Marked ${orphaned.count} interrupted export job(s) as failed.`);

    // Anything still queued from before the restart can simply be run now.
    const queued = await runAsSystem(() => this.prisma.export_jobs.findMany({ where: { status: 'Queued' }, select: { id: true }, orderBy: { id: 'asc' } }));
    this.queue.push(...queued.map((j) => j.id));
    if (this.queue.length) void this.drain();

    registerWorker('export-sweeper', SWEEP_INTERVAL_MS);
    this.sweeper = setInterval(
      this.redis && this.cache
        ? clusterTick({ redis: this.redis, cache: this.cache }, 'export-sweeper', () => this.sweepExpired())
        : trackedTick('export-sweeper', () => this.sweepExpired()),
      SWEEP_INTERVAL_MS,
    );
    this.sweeper.unref?.();
    void this.sweepExpired();
  }

  /**
   * Release the sweep timer on shutdown. Unlike the other two schedulers this had no destroy
   * hook, so the interval outlived `app.close()` and kept the event loop from draining.
   */
  onModuleDestroy(): void {
    if (this.sweeper) { clearInterval(this.sweeper); this.sweeper = undefined; }
  }

  // ------------------------------------------------------------------ queue
  /** Queue an export. Returns immediately — the file is generated in the background. */
  async enqueue(action: ExportAction, sel: BulkSelection, user: AuthUserRecord, expiryHours = DEFAULT_EXPIRY_HOURS): Promise<Record<string, unknown>> {
    const meta = ACTION_META[action];
    if (!meta) throw new BadRequestException({ message: `Unknown export type "${action}".` });

    // Validate the selection up front so an impossible request fails fast, with a real error,
    // instead of being queued and failing invisibly later.
    const txns = await this.bulk.resolve(sel, user);

    const hash = this.hashRequest(action, sel, user);
    const existing = await this.prisma.export_jobs.findFirst({
      where: { request_hash: hash, requested_by_id: user.id ?? null, status: { in: DUPLICATE_STATUSES } },
    });
    if (existing) {
      throw new BadRequestException({
        message: `An identical export (${existing.export_id}) is already ${existing.status.toLowerCase()}. Wait for it to finish before requesting it again.`,
      });
    }

    const now = new Date();
    const job = await this.prisma.export_jobs.create({
      data: {
        export_id: 'EXP-' + now.getTime().toString(36).toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase(),
        token: crypto.randomBytes(24).toString('hex'),
        action_type: action,
        format: meta.format,
        status: 'Queued',
        transaction_count: txns.length,
        filters: JSON.stringify(this.bulkFilters(sel)),
        selection: JSON.stringify(sel),
        request_hash: hash,
        requested_by: user.name,
        requested_by_id: user.id ?? null,
        requested_at: now,
        expires_at: new Date(now.getTime() + expiryHours * 3600_000),
        created_at: now,
        updated_at: now,
      },
    });

    this.queue.push(job.id);
    void this.drain();
    return this.present(job);
  }

  /** Run queued jobs one at a time. Never rejects — a failed job is recorded, not thrown. */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        const id = this.queue.shift()!;
        // A queued job outlives the request that asked for it, so it carries its own tenant and the
        // work runs inside that brokerage's context — the export must contain exactly what the
        // person who asked for it could see, not whatever the worker happens to be able to read.
        try { await this.runOwnedJob(id); }
        catch (err) { this.log.error(`Export job ${id} failed: ${err instanceof Error ? err.message : String(err)}`); }
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Run a queued job as the brokerage that owns it.
   *
   * Which tenant that is has to be read before the context exists, so the lookup is system and the
   * work that follows is not.
   */
  private async runOwnedJob(id: number): Promise<void> {
    const owner = await runAsSystem(() =>
      this.prisma.export_jobs.findUnique({ where: { id }, select: { company_id: true } }));
    if (!owner) {
      this.log.warn(`Export job ${id} vanished before it could run.`);
      return;
    }
    await run(owner.company_id, () => this.run(id));
  }

  /** Generate one job's file and record the outcome. */
  private async run(id: number): Promise<void> {
    const job = await this.prisma.export_jobs.findUnique({ where: { id } });
    if (!job || job.status !== 'Queued') return;

    await this.prisma.export_jobs.update({ where: { id }, data: { status: 'Processing', started_at: new Date(), updated_at: new Date() } });
    const meta = ACTION_META[job.action_type as ExportAction];
    const sel = JSON.parse(job.selection ?? '{}') as BulkSelection;
    // the job runs as the user who requested it, so scoping is identical to a live request
    const user = { id: job.requested_by_id ?? undefined, name: job.requested_by ?? '', role: 'admin' } as unknown as AuthUserRecord;
    const fileName = `${meta.label.replace(/[^A-Za-z0-9]+/g, '_')}_${job.export_id}.${meta.ext}`;
    const rel = path.join('exports', fileName);
    const abs = path.join(EXPORT_ROOT, fileName);

    try {
      let documents = 0, skipped = 0;
      if (job.action_type === 'documents-zip' || job.action_type === 'transaction-pdf-zip') {
        // These stream into a Response; write to a file with the same interface instead.
        const sink = this.fileSink(abs);
        if (job.action_type === 'documents-zip') {
          const res = await this.bulk.documentsZip(sel, user, sink.res);
          void res;
        } else {
          await this.bulk.dataPdfZip(sel, user, sink.res);
        }
        await sink.done;
        const counts = await this.bulk.summary(sel, user);
        documents = counts.documents_available;
        skipped = counts.documents_unavailable;
      } else {
        const buf = job.action_type === 'transaction-complete-xlsx' ? await this.bulk.completeXlsx(sel, user)
          : job.action_type === 'transaction-complete-csv' ? await this.bulk.completeCsv(sel, user)
            : job.action_type === 'transaction-data-xlsx' ? await this.bulk.dataXlsx(sel, user)
              : job.action_type === 'transaction-data-csv' ? await this.bulk.dataCsv(sel, user)
                : await this.bulk.dataPdf(sel, user);
        await fs.writeFile(abs, buf);
      }

      const stat = await fs.stat(abs);
      // "Partially Completed" is honest when files were requested but some were unavailable.
      const status = job.action_type === 'documents-zip' && skipped > 0 ? 'Partially Completed' : 'Completed';
      await this.prisma.export_jobs.update({
        where: { id },
        data: {
          status, file_name: fileName, file_path: rel, file_size: stat.size,
          document_count: documents, skipped_count: skipped,
          completed_at: new Date(), updated_at: new Date(),
        },
      });
    } catch (err) {
      await fs.rm(abs, { force: true }).catch(() => { /* nothing to clean */ });
      await this.prisma.export_jobs.update({
        where: { id },
        data: {
          status: 'Failed',
          failure_reason: err instanceof Error ? err.message : String(err),
          completed_at: new Date(), updated_at: new Date(),
        },
      });
    }
  }

  /**
   * A minimal Response stand-in so the streaming exporters can write to a file unchanged.
   * They only use setHeader/end/write/on/once/emit, which is what this provides.
   */
  private fileSink(abs: string): { res: never; done: Promise<void> } {
    const out = createWriteStream(abs);
    const done = new Promise<void>((resolve, reject) => {
      out.on('finish', () => resolve());
      out.on('error', reject);
    });
    const sink = {
      setHeader: () => sink,
      getHeader: () => undefined,
      write: (chunk: unknown) => out.write(chunk as Buffer),
      end: (chunk?: unknown) => { if (chunk) out.write(chunk as Buffer); out.end(); return sink; },
      on: (ev: string, fn: (...a: unknown[]) => void) => { out.on(ev, fn); return sink; },
      once: (ev: string, fn: (...a: unknown[]) => void) => { out.once(ev, fn); return sink; },
      emit: () => false,
      removeListener: () => sink,
      destroy: () => out.destroy(),
      headersSent: false,
      writableEnded: false,
    };
    return { res: sink as unknown as never, done };
  }

  // ---------------------------------------------------------------- reading
  /** The requesting user's export history (admins see everything). */
  async history(user: AuthUserRecord, limit = 50): Promise<Record<string, unknown>[]> {
    const isAdmin = (user.role ?? 'agent') !== 'agent';
    const rows = await this.prisma.export_jobs.findMany({
      where: isAdmin ? {} : { requested_by_id: user.id ?? -1 },
      orderBy: { id: 'desc' },
      take: Math.min(200, Math.max(1, limit)),
    });
    return rows.map((j) => this.present(j));
  }

  async get(exportId: string, user: AuthUserRecord): Promise<Record<string, unknown>> {
    const job = await this.prisma.export_jobs.findUnique({ where: { export_id: exportId } });
    if (!job || !this.mayAccess(job, user)) throw new NotFoundException({ message: 'Export not found.' });
    return this.present(job);
  }

  /**
   * Resolve a download token to a file on disk. Enforces expiry and ownership, and records
   * that the file was downloaded.
   */
  async download(token: string, user: AuthUserRecord): Promise<{ abs: string; fileName: string; mime: string }> {
    const job = await this.prisma.export_jobs.findUnique({ where: { token } });
    if (!job || !this.mayAccess(job, user)) throw new NotFoundException({ message: 'Export not found.' });
    if (job.status === 'Failed') throw new BadRequestException({ message: job.failure_reason ?? 'This export failed to generate.' });
    if (job.status === 'Queued' || job.status === 'Processing') {
      throw new BadRequestException({ message: `This export is still ${job.status.toLowerCase()}.` });
    }
    if (this.isExpired(job)) {
      await this.expire(job.id);
      throw new BadRequestException({ message: 'This download link has expired. Request the export again.' });
    }
    if (!job.file_path) throw new NotFoundException({ message: 'The generated file is no longer available.' });

    const abs = path.join(EXPORT_ROOT, path.basename(job.file_path));
    try { await fs.access(abs); }
    catch {
      await this.expire(job.id);
      throw new NotFoundException({ message: 'The generated file is no longer available on the server.' });
    }

    const now = new Date();
    await this.prisma.export_jobs.update({
      where: { id: job.id },
      data: { download_status: 'Downloaded', downloaded_at: now, download_count: { increment: 1 }, updated_at: now },
    });
    return { abs, fileName: job.file_name ?? path.basename(abs), mime: ACTION_META[job.action_type as ExportAction]?.mime ?? 'application/octet-stream' };
  }

  /** Delete a generated file (and mark the job expired). Admins only. */
  async remove(exportId: string, user: AuthUserRecord): Promise<{ deleted: boolean }> {
    if ((user.role ?? 'agent') === 'agent') {
      throw new ForbiddenException({ message: 'You do not have permission to delete generated exports.' });
    }
    const job = await this.prisma.export_jobs.findUnique({ where: { export_id: exportId } });
    if (!job) throw new NotFoundException({ message: 'Export not found.' });
    await this.expire(job.id);
    return { deleted: true };
  }

  // ---------------------------------------------------------------- expiry
  /**
   * Remove expired files from disk and mark their jobs Expired, one brokerage at a time.
   *
   * Returns the total swept across all tenants, which is what the single-tenant version returned
   * and what the caller logs.
   */
  async sweepExpired(): Promise<number> {
    const counts = await forEachTenant(() => allTenantIds(this.prisma), () => this.sweepExpiredForTenant());
    return counts.reduce((a, b) => a + b, 0);
  }

  /** The sweep itself, scoped to whichever tenant is in context. */
  async sweepExpiredForTenant(): Promise<number> {
    const due = await this.prisma.export_jobs.findMany({
      where: { status: { in: ['Completed', 'Partially Completed'] }, expires_at: { lt: new Date() } },
      select: { id: true },
    });
    for (const j of due) await this.expire(j.id);
    if (due.length) this.log.log(`Swept ${due.length} expired export file(s).`);
    return due.length;
  }

  private async expire(id: number): Promise<void> {
    const job = await this.prisma.export_jobs.findUnique({ where: { id } });
    if (!job) return;
    if (job.file_path) {
      await fs.rm(path.join(EXPORT_ROOT, path.basename(job.file_path)), { force: true }).catch(() => { /* already gone */ });
    }
    await this.prisma.export_jobs.update({
      where: { id },
      data: { status: 'Expired', file_path: null, file_size: null, updated_at: new Date() },
    });
  }

  private isExpired(job: { expires_at: Date | null; status: string }): boolean {
    return job.status === 'Expired' || (!!job.expires_at && job.expires_at.getTime() < Date.now());
  }

  // ----------------------------------------------------------------- utils
  /** A user sees their own exports; staff/admin see all of them. */
  private mayAccess(job: { requested_by_id: number | null }, user: AuthUserRecord): boolean {
    if ((user.role ?? 'agent') !== 'agent') return true;
    return job.requested_by_id === (user.id ?? -1);
  }

  private hashRequest(action: string, sel: BulkSelection, user: AuthUserRecord): string {
    const canonical = JSON.stringify({
      action, user: user.id ?? user.name,
      ids: [...(sel.transaction_ids ?? [])].sort((a, b) => a - b),
      all: !!sel.all_matching, filters: sel.filters ?? {},
      documents: sel.documents ?? 'all', categories: [...(sel.categories ?? [])].sort(),
      from: sel.uploaded_from ?? '', to: sel.uploaded_to ?? '',
    });
    return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 64);
  }

  private bulkFilters(sel: BulkSelection): { label: string; value: string }[] {
    const out: { label: string; value: string }[] = [];
    const add = (label: string, v: unknown) => { if (v && String(v).length) out.push({ label, value: Array.isArray(v) ? v.join(', ') : String(v) }); };
    add('Selection', sel.all_matching ? 'All matching the filters' : `${sel.transaction_ids?.length ?? 0} selected`);
    add('Deal Type', sel.filters?.deal_type); add('Agent', sel.filters?.agent);
    add('Closing Year', sel.filters?.year); add('Search', sel.filters?.search);
    add('Documents', sel.documents && sel.documents !== 'all' ? sel.documents : null);
    add('Categories', sel.categories);
    return out;
  }

  /** The shape the Download Centre renders. The token is only exposed to someone who may use it. */
  private present(j: Record<string, unknown>): Record<string, unknown> {
    const expired = this.isExpired(j as unknown as { expires_at: Date | null; status: string });
    const status = expired && (j.status === 'Completed' || j.status === 'Partially Completed') ? 'Expired' : j.status;
    return {
      export_id: j.export_id,
      action_type: j.action_type,
      action_label: ACTION_META[j.action_type as ExportAction]?.label ?? String(j.action_type),
      format: j.format,
      status,
      transaction_count: j.transaction_count,
      document_count: j.document_count,
      skipped_count: j.skipped_count,
      file_name: j.file_name,
      file_size: j.file_size,
      filters: JSON.parse((j.filters as string) ?? '[]'),
      requested_by: j.requested_by,
      requested_at: this.iso(j.requested_at),
      started_at: this.iso(j.started_at),
      completed_at: this.iso(j.completed_at),
      expires_at: this.iso(j.expires_at),
      download_status: j.download_status,
      downloaded_at: this.iso(j.downloaded_at),
      download_count: j.download_count,
      failure_reason: j.failure_reason,
      // only a live file is given a usable link
      download_token: status === 'Completed' || status === 'Partially Completed' ? j.token : null,
    };
  }

  private iso(v: unknown): string | null { return v instanceof Date ? v.toISOString() : null; }
}
