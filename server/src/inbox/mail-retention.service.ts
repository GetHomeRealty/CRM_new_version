import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { runAsSystem } from '../core/tenant-context';
import { schedulersEnabled, schedulerSkipReason } from '../common/schedulers';
import { clusterTick } from '../redis/cluster-tick';
import { RedisService } from '../redis/redis.service';
import { CacheService } from '../redis/cache.service';
import { registerWorker } from '../observability/worker-health';

/** Once a day is often enough for a policy measured in months. */
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FIRST_SWEEP_DELAY_MS = 5 * 60 * 1000;
/** Deleted in batches so one sweep can never hold a long transaction over a large table. */
const BATCH = 500;

const int = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};
const bool = (v: string | undefined, fallback: boolean): boolean =>
  v === undefined || v === '' ? fallback : v === 'true' || v === '1';

export interface RetentionPolicy {
  deleteAfterDays: number;
  stripBodiesAfterDays: number;
  includeLinked: boolean;
}

export const retentionPolicy = (): RetentionPolicy => ({
  deleteAfterDays: int(process.env.MAIL_RETENTION_DAYS, 0),
  stripBodiesAfterDays: int(process.env.MAIL_STRIP_BODIES_AFTER_DAYS, 0),
  includeLinked: bool(process.env.MAIL_RETENTION_INCLUDE_LINKED, false),
});

/**
 * Retention for the mirrored mailbox.
 *
 * `inbound_emails` is by far the largest thing in this database — 77 MB of an 80 MB database when
 * measured, having doubled in a week — and it grows with mail volume rather than with brokerage
 * activity. Backup size, dump duration and therefore restore time all track it, so the recovery
 * objective quietly degrades as the mailbox fills. Nothing was wrong with the data: the unique
 * index on `(account_id, uid)` already prevents re-ingestion. There was simply no policy.
 *
 * OFF BY DEFAULT, AND DELIBERATELY SO. `MAIL_RETENTION_DAYS=0` keeps everything forever, which is
 * exactly the behaviour before this existed, so upgrading changes nothing until somebody makes a
 * decision. That decision is not a disk-space question — a message attached to a deal can be part
 * of the record of that deal — which is why this ships inert rather than with a plausible-looking
 * default that would start deleting a brokerage's correspondence on the next restart.
 *
 * TWO LEVERS, because they carry very different risk:
 *
 *   MAIL_STRIP_BODIES_AFTER_DAYS  keeps the message — sender, subject, date, snippet, its link to
 *                                 a lead — and discards only `body_text`/`body_html`, which are
 *                                 nearly all of the bytes. The conversation remains visible and
 *                                 searchable. This is the setting to reach for first.
 *   MAIL_RETENTION_DAYS           removes the row. Irreversible.
 *
 * Messages linked to a lead are exempt from both unless MAIL_RETENTION_INCLUDE_LINKED is set,
 * because those are the ones most likely to matter later.
 *
 * The mail itself still exists on the mail server. This prunes a local mirror, not an archive of
 * record — but do not lean on that: nothing here re-fetches what it removed.
 */
@Injectable()
export class MailRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(MailRetentionService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    // Optional so existing constructions — including this service's specs — keep working.
    // Used only to decide whether THIS process should run a given sweep; see `clusterTick`.
    private readonly redis?: RedisService,
    private readonly cache?: CacheService,
  ) {}

  onModuleInit(): void {
    const policy = retentionPolicy();
    if (!policy.deleteAfterDays && !policy.stripBodiesAfterDays) {
      this.log.log('Mail retention not configured — every message is kept. Set MAIL_RETENTION_DAYS or MAIL_STRIP_BODIES_AFTER_DAYS to change that.');
      return;
    }
    if (!schedulersEnabled()) {
      this.log.log(`Mail retention sweep not started (${schedulerSkipReason()}).`);
      return;
    }

    this.first = setTimeout(() => { void this.sweep(); }, FIRST_SWEEP_DELAY_MS);
    this.first.unref?.();

    /*
     * `clusterTick`, so that on a multi-process deployment one instance sweeps rather than all of
     * them.
     *
     * THE STAKES ARE LOWER HERE THAN FOR CAMPAIGN MAIL, and saying so matters because it explains
     * why this is tidiness rather than a blocker. Both operations are idempotent: the body strip is
     * an `updateMany` whose `where` excludes rows already stripped, and the delete works from a
     * fresh `findMany` each batch. Four processes sweeping produce the same end state as one — they
     * simply do redundant work against a large table while the IMAP poller is writing to it.
     *
     * Without Redis this behaves exactly as before, because `clusterTick` runs the tick when no
     * lock is available. Registering the worker also puts the sweep on `/api/health/workers`, where
     * every other scheduler already reports.
     */
    registerWorker('mail-retention', SWEEP_INTERVAL_MS);
    this.timer = setInterval(
      this.redis && this.cache
        ? clusterTick({ redis: this.redis, cache: this.cache }, 'mail-retention', () => this.sweep())
        : () => { void this.sweep(); },
      SWEEP_INTERVAL_MS,
    );
    this.timer.unref?.();
    this.log.log(
      `Mail retention: ${policy.stripBodiesAfterDays ? `strip bodies after ${policy.stripBodiesAfterDays}d` : 'no body stripping'}, `
      + `${policy.deleteAfterDays ? `delete after ${policy.deleteAfterDays}d` : 'no deletion'}, `
      + `lead-linked messages ${policy.includeLinked ? 'INCLUDED' : 'exempt'}.`,
    );
  }

  onModuleDestroy(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
  }

  /** What a sweep would do, without doing it. Used by the readiness/monitoring surface and by tests. */
  async preview(): Promise<{ toStrip: number; toDelete: number; policy: RetentionPolicy }> {
    const policy = retentionPolicy();
    return runAsSystem(async () => ({
      policy,
      toStrip: policy.stripBodiesAfterDays
        ? await this.prisma.inbound_emails.count({ where: this.stripWhere(policy) })
        : 0,
      toDelete: policy.deleteAfterDays
        ? await this.prisma.inbound_emails.count({ where: this.deleteWhere(policy) })
        : 0,
    }));
  }

  async sweep(): Promise<{ stripped: number; deleted: number }> {
    if (this.running) return { stripped: 0, deleted: 0 };
    this.running = true;
    const policy = retentionPolicy();
    let stripped = 0, deleted = 0;

    try {
      // Retention spans every brokerage, so it runs outside tenant scope — the same escape hatch
      // the other cross-tenant background work uses, and the reason this file is on the pinned
      // list of callers.
      await runAsSystem(async () => {
        if (policy.stripBodiesAfterDays) {
          // updateMany, not a loop: this rewrites two columns and holds no rows in memory.
          const r = await this.prisma.inbound_emails.updateMany({
            where: this.stripWhere(policy),
            data: { body_text: null, body_html: null },
          });
          stripped = r.count;
        }

        if (policy.deleteAfterDays) {
          // Batched. A single deleteMany over a 900 MB table takes one long transaction and blocks
          // the IMAP poller writing into the same table; 500 at a time keeps each one short.
          for (;;) {
            const doomed = await this.prisma.inbound_emails.findMany({
              where: this.deleteWhere(policy), select: { id: true }, take: BATCH,
            });
            if (!doomed.length) break;
            const r = await this.prisma.inbound_emails.deleteMany({ where: { id: { in: doomed.map((d) => d.id) } } });
            deleted += r.count;
            if (doomed.length < BATCH) break;
          }
        }
      });

      if (stripped || deleted) {
        this.log.log(`Mail retention sweep: ${stripped} bodies stripped, ${deleted} messages deleted.`);
      }
    } catch (err) {
      // A failed sweep must never take the process down — it is housekeeping, and the next one is
      // in 24 hours.
      this.log.error(`Mail retention sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
    return { stripped, deleted };
  }

  private cutoff(days: number): Date {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  }

  /** Old enough to strip, still has a body, and not spared for being attached to a lead. */
  private stripWhere(policy: RetentionPolicy): Record<string, unknown> {
    return {
      received_at: { lt: this.cutoff(policy.stripBodiesAfterDays) },
      OR: [{ body_text: { not: null } }, { body_html: { not: null } }],
      ...(policy.includeLinked ? {} : { lead_id: null }),
    };
  }

  private deleteWhere(policy: RetentionPolicy): Record<string, unknown> {
    return {
      received_at: { lt: this.cutoff(policy.deleteAfterDays) },
      ...(policy.includeLinked ? {} : { lead_id: null }),
    };
  }
}
