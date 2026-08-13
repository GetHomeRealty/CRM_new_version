import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { schedulersEnabled, schedulerSkipReason } from '../common/schedulers';
import { registerWorker } from '../observability/worker-health';
import { clusterTick } from '../redis/cluster-tick';
import { RedisService } from '../redis/redis.service';
import { CacheService } from '../redis/cache.service';
import { ReminderSweepService } from './reminder-sweep.service';

/**
 * The nightly job behind the listing-expiry and lawyer-detail reminders.
 *
 * WAKES HOURLY, WORKS ONCE A DAY. The sweep itself is idempotent — every reminder is claimed by a
 * unique row keyed on the day — so waking often costs nothing and buys the one thing a strict
 * once-a-day timer cannot: a server that was restarted, redeployed or asleep at the appointed hour
 * still sends the day's reminders when it comes back, instead of skipping them until tomorrow.
 *
 * Only one process may run it: these send real email, so a second instance would deliver a duplicate
 * of every reminder. Disable on all but one with REMINDER_SWEEP_DISABLED=1.
 */
const POLL_INTERVAL_MS = 60 * 60 * 1000;

@Injectable()
export class ReminderSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ReminderSchedulerService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly sweep: ReminderSweepService,
    // Only used to decide whether THIS process should run a given pass — see `clusterTick`.
    private readonly redis: RedisService,
    private readonly cache: CacheService,
  ) {}

  onModuleInit(): void {
    if (!schedulersEnabled() || process.env.REMINDER_SWEEP_DISABLED === '1') {
      this.log.log(`Listing and lawyer reminders not scheduled (${process.env.REMINDER_SWEEP_DISABLED === '1' ? 'REMINDER_SWEEP_DISABLED=1' : schedulerSkipReason()}).`);
      return;
    }
    registerWorker('reminder-sweep', POLL_INTERVAL_MS);
    /*
     * `clusterTick`, not `trackedTick`: this sweep emails real clients, so two processes running it
     * means two copies of every reminder arriving in somebody's inbox. With Redis, exactly one
     * process wins each pass; without it, this behaves exactly as it always did.
     */
    this.timer = setInterval(
      clusterTick({ redis: this.redis, cache: this.cache }, 'reminder-sweep', () => this.run()),
      POLL_INTERVAL_MS,
    );
    if (typeof this.timer.unref === 'function') this.timer.unref();
    // One pass shortly after start, so a deployment on the morning of an expiry does not cost that
    // day's reminders. Delayed rather than immediate to keep it clear of the boot path.
    setTimeout(() => void this.run(), 60_000).unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass over every due reminder. */
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.sweep.sweep();
    } catch (err) {
      this.log.error(`Reminder sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }
}
