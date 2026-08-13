import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { schedulersEnabled, schedulerSkipReason } from '../common/schedulers';
import { clusterTick } from '../redis/cluster-tick';
import { RedisService } from '../redis/redis.service';
import { CacheService } from '../redis/cache.service';
import { registerWorker } from '../observability/worker-health';

/**
 * Empties Recently Deleted.
 *
 * A deleted lead is soft-deleted: it drops out of every list and sits in Recently Deleted so an
 * accidental delete can be undone. Nothing ever took it from there. The bin was therefore permanent
 * storage under another name — every lead the brokerage had ever deleted, with its name, email,
 * phone and address, kept for ever and restorable by anyone who could reach the screen.
 *
 * SIXTY DAYS is the brokerage's decision, and it is long: two months is far past the point where an
 * accidental delete is noticed, and it still lands inside the window a CASL enquiry would care
 * about. `LEAD_RETENTION_DAYS` overrides it; 0 switches the sweep off entirely and restores the
 * previous keep-for-ever behaviour, which is what makes this safe to deploy before anyone has
 * agreed a number.
 *
 * WHAT IS DELETED IS WHAT `purge` DELETES — the same `prisma.leads.delete`, so notes, tasks,
 * showings and calls cascade exactly as they do when somebody empties the bin by hand, and campaign
 * recipient rows keep their address while losing the lead link, so past campaign results stay
 * intact. This is not a second definition of "permanently delete"; it is the existing one, on a
 * timer.
 *
 * ONLY ROWS ALREADY IN THE BIN are touched: `deleted_at` must be non-null AND older than the
 * window. A live lead has `deleted_at IS NULL` and can never match, whatever its age.
 */
@Injectable()
export class LeadRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(LeadRetentionService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  /** Once a day is ample for a policy measured in months. */
  private static readonly SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
  private static readonly FIRST_SWEEP_DELAY_MS = 10 * 60 * 1000;
  /** Deleted in batches, so one sweep cannot hold a long transaction over the leads table. */
  private static readonly BATCH = 500;

  constructor(
    private readonly prisma: PrismaService,
    // Optional so existing constructions — including this service's specs — keep working. Used only
    // to decide whether THIS process should run a given sweep; see `clusterTick`.
    private readonly redis?: RedisService,
    private readonly cache?: CacheService,
  ) {}

  /** How long a deleted lead is kept. 0 disables the sweep. */
  static retentionDays(): number {
    const raw = Number(process.env.LEAD_RETENTION_DAYS ?? 60);
    return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 60;
  }

  onModuleInit(): void {
    const days = LeadRetentionService.retentionDays();
    if (days === 0) {
      this.log.log('Lead retention is off (LEAD_RETENTION_DAYS=0) — Recently Deleted keeps everything.');
      return;
    }
    if (!schedulersEnabled()) {
      this.log.log(`Lead retention sweep not started (${schedulerSkipReason()}).`);
      return;
    }

    this.first = setTimeout(() => { void this.sweep(); }, LeadRetentionService.FIRST_SWEEP_DELAY_MS);
    this.first.unref?.();

    // `clusterTick`, not a bare interval: this DESTROYS rows, and two processes racing the same
    // batch is the one thing worth spending a lock on. Without Redis it runs as a single instance
    // always has.
    registerWorker('lead-retention', LeadRetentionService.SWEEP_INTERVAL_MS);
    this.timer = setInterval(
      this.redis && this.cache
        ? clusterTick({ redis: this.redis, cache: this.cache }, 'lead-retention', () => this.sweep())
        : () => { void this.sweep(); },
      LeadRetentionService.SWEEP_INTERVAL_MS,
    );
    this.timer.unref?.();
    this.log.log(`Recently Deleted leads are purged after ${days} day(s).`);
  }

  onModuleDestroy(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
  }

  /** What the next sweep would remove, without removing it. Used by the readiness surface and tests. */
  async preview(): Promise<{ days: number; due: number }> {
    const days = LeadRetentionService.retentionDays();
    if (days === 0) return { days, due: 0 };
    return { days, due: await this.prisma.leads.count({ where: this.dueWhere(days) }) };
  }

  async sweep(): Promise<{ purged: number }> {
    const days = LeadRetentionService.retentionDays();
    if (days === 0 || this.running) return { purged: 0 };
    this.running = true;
    let purged = 0;

    try {
      for (;;) {
        const doomed = await this.prisma.leads.findMany({
          where: this.dueWhere(days), select: { id: true }, take: LeadRetentionService.BATCH,
        });
        if (!doomed.length) break;
        const res = await this.prisma.leads.deleteMany({ where: { id: { in: doomed.map((d) => d.id) } } });
        purged += res.count;
        if (doomed.length < LeadRetentionService.BATCH) break;
      }
      if (purged) this.log.log(`Lead retention: ${purged} lead(s) removed from Recently Deleted (older than ${days} days).`);
    } catch (err) {
      // Housekeeping must never take the process down; the next pass is in 24 hours.
      this.log.error(`Lead retention sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
    return { purged };
  }

  /**
   * In the bin, and older than the window.
   *
   * `deleted_at` carries both facts — that the lead is in Recently Deleted at all, and when it went
   * there — so the age is measured from the deletion rather than from `created_at`. A lead created
   * three years ago and deleted this morning has fifty-nine days left, which is the whole point.
   */
  private dueWhere(days: number) {
    return { deleted_at: { not: null, lt: new Date(Date.now() - days * 24 * 60 * 60 * 1000) } };
  }
}
