import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { schedulersEnabled, schedulerSkipReason } from '../common/schedulers';
import { clusterTick } from '../redis/cluster-tick';
import { RedisService } from '../redis/redis.service';
import { CacheService } from '../redis/cache.service';
import { forEachTenant } from '../core/tenant-context';
import { allTenantIds } from '../core/tenants';
import { registerWorker, trackedTick } from '../observability/worker-health';
import { ReviewSlaService } from './review-sla.service';

/** Hourly, like the other reminder sweeps. The ladder itself decides what is actually due. */
const POLL_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Wakes the review reminder ladder.
 *
 * Modelled on the lawyer-detail sweep, including the reason only one process may run it: these send
 * real email, so a second instance would deliver a duplicate of every reminder. Disable on all but
 * one with REVIEW_SLA_DISABLED=1.
 */
@Injectable()
export class ReviewSlaSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ReviewSlaSchedulerService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sla: ReviewSlaService,
    // Optional so existing constructions — including this service's specs — keep working.
    // Used only to decide whether THIS process should run a given pass; see `clusterTick`.
    private readonly redis?: RedisService,
    private readonly cache?: CacheService,
  ) {}

  onModuleInit(): void {
    if (!schedulersEnabled() || process.env.REVIEW_SLA_DISABLED === '1') {
      this.log.log(`Review reminders not scheduled (${process.env.REVIEW_SLA_DISABLED === '1' ? 'REVIEW_SLA_DISABLED=1' : schedulerSkipReason()}).`);
      return;
    }
    registerWorker('review-sla', POLL_INTERVAL_MS);
    this.timer = setInterval(
      this.redis && this.cache
        ? clusterTick({ redis: this.redis, cache: this.cache }, 'review-sla', () => this.sweep())
        : trackedTick('review-sla', () => this.sweep()),
      POLL_INTERVAL_MS,
    );
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass per brokerage, inside that tenant's context, as the other sweeps do. */
  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await forEachTenant(() => allTenantIds(this.prisma), () => this.sla.sweep().then(() => undefined));
    } catch (err) {
      this.log.error(`Review reminder sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }
}
