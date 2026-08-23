import { Injectable, Logger, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RetentionService } from './retention.service';
import { schedulersEnabled, schedulerSkipReason } from '../common/schedulers';
import { clusterTick } from '../redis/cluster-tick';
import { RedisService } from '../redis/redis.service';
import { CacheService } from '../redis/cache.service';
import { registerWorker, trackedTick } from '../observability/worker-health';

/** Daily. The cutoff moves by a day at a time, so there is nothing to gain from running it often. */
const POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Wakes the Transaction Desk retention sweep.
 *
 * Modelled on the reminder sweeps, including the reason only one process may run it — this one
 * DELETES, so two instances racing would double the work and interleave their batches. `clusterTick`
 * makes exactly one process win each pass when Redis is present, and `RUN_SCHEDULERS` is the single-
 * process answer when it is not.
 *
 * IT IS SAFE TO SCHEDULE BEFORE IT IS SAFE TO RUN. Without `DESK_RETENTION_ENABLED=true` the sweep is a
 * dry run: it counts what it would remove, logs that, and returns. So this can ship switched on as a
 * timer and switched off as a deletion, which is the order the rollout needs — deploy, read the
 * numbers from staging and from production's own dry runs, then enable.
 *
 * The first pass is deliberately delayed past boot: a deploy should not be competing with a purge.
 */
@Injectable()
class RetentionScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(RetentionScheduler.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly retention: RetentionService,
    private readonly redis?: RedisService,
    private readonly cache?: CacheService,
  ) {}

  onModuleInit(): void {
    if (!schedulersEnabled() || process.env.RETENTION_DISABLED === '1') {
      this.log.log(`Retention sweep not scheduled (${process.env.RETENTION_DISABLED === '1' ? 'RETENTION_DISABLED=1' : schedulerSkipReason()}).`);
      return;
    }
    /*
     * SAY WHICH RETENTION THIS IS. The old line began "Retention sweep scheduled", which on a
     * console that also carries the notification sweep's message was ambiguous exactly where it
     * mattered most — the two have very different blast radii, and a reader could not tell from
     * the wording which one was armed.
     */
    this.log.log(
      this.retention.enabled()
        ? 'Transaction Desk retention: ENABLED (DESK_RETENTION_ENABLED=true) — it WILL delete trashed '
          + 'Transaction Desk records past six months, cascading into their child rows, and will remove '
          + 'desk audit_logs and reminder history by age. This is NOT notification retention.'
        : 'Transaction Desk retention: DISABLED — DRY RUN. It will report what six months would remove '
          + 'and delete nothing. Set DESK_RETENTION_ENABLED=true to act. This is NOT notification retention.',
    );

    /*
     * The old shared flag is no longer read by either sweep. If it is still present it now does
     * nothing, and an operator who set it expecting an effect must be told — silence would look
     * like it had been honoured.
     */
    if ((process.env.RETENTION_ENABLED ?? '').trim()) {
      this.log.warn(
        'RETENTION_ENABLED is set but is NO LONGER READ by either retention sweep. It once armed both. '
        + 'Use NOTIFICATION_RETENTION_ENABLED for notification retention and DESK_RETENTION_ENABLED for '
        + 'Transaction Desk retention. This variable can be removed from the environment.',
      );
    }
    registerWorker('retention', POLL_INTERVAL_MS);
    this.timer = setInterval(
      this.redis && this.cache
        ? clusterTick({ redis: this.redis, cache: this.cache }, 'retention', () => this.run())
        : trackedTick('retention', () => this.run()),
      POLL_INTERVAL_MS,
    );
    if (typeof this.timer.unref === 'function') this.timer.unref();
    // Ten minutes after boot, so a deploy is finished before anything is counted or removed.
    setTimeout(() => void this.run(), 10 * 60_000).unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.retention.sweep();
    } catch (err) {
      this.log.error(`Retention sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }
}

@Module({
  imports: [AuditModule],
  providers: [RetentionService, RetentionScheduler],
  exports: [RetentionService],
})
export class RetentionModule {}
