import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { schedulersEnabled, schedulerSkipReason } from '../common/schedulers';
import { clusterTick } from '../redis/cluster-tick';
import { RedisService } from '../redis/redis.service';
import { CacheService } from '../redis/cache.service';
import { forEachTenant } from '../core/tenant-context';
import { allTenantIds } from '../core/tenants';
import { registerWorker, trackedTick } from '../observability/worker-health';
import { EventReminderService } from './event-reminder.service';

/**
 * The job behind appointment reminders.
 *
 * WAKES EVERY TEN MINUTES, unlike the nightly transaction sweep. The shortest lead time here is an
 * hour, so an hourly tick would deliver "in 1 hour" anywhere between an hour and two hours early —
 * useless for a showing. Ten minutes keeps the notice within about a sixth of its own lead time
 * while still being nothing like a busy loop.
 *
 * Waking often is safe because the sweep is idempotent: each reminder is claimed by a unique row on
 * (event, lead time), so a tick that overlaps the previous one, a restart mid-pass, or a manual
 * re-run all send nothing extra. That is also what makes a redeploy harmless — the reminders due
 * during the restart go out on the next tick rather than being lost.
 *
 * Only one process may run it: these send real email, so a second instance would double every
 * reminder. Disable on all but one with EVENT_REMINDER_DISABLED=1.
 */
const POLL_INTERVAL_MS = 10 * 60 * 1000;

@Injectable()
export class EventReminderSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(EventReminderSchedulerService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly reminders: EventReminderService,
    // Optional so existing constructions — including this service's specs — keep working.
    // Used only to decide whether THIS process should run a given pass; see `clusterTick`.
    private readonly redis?: RedisService,
    private readonly cache?: CacheService,
  ) {}

  onModuleInit(): void {
    if (!schedulersEnabled() || process.env.EVENT_REMINDER_DISABLED === '1') {
      this.log.log(`Appointment reminders not scheduled (${process.env.EVENT_REMINDER_DISABLED === '1' ? 'EVENT_REMINDER_DISABLED=1' : schedulerSkipReason()}).`);
      return;
    }
    registerWorker('event-reminders', POLL_INTERVAL_MS);
    this.timer = setInterval(
      this.redis && this.cache
        ? clusterTick({ redis: this.redis, cache: this.cache }, 'event-reminders', () => this.run())
        : trackedTick('event-reminders', () => this.run()),
      POLL_INTERVAL_MS,
    );
    if (typeof this.timer.unref === 'function') this.timer.unref();
    // One pass shortly after start, so a deployment does not swallow the reminders due in the next
    // ten minutes. Delayed rather than immediate to keep it clear of the boot path.
    setTimeout(() => void this.run(), 45_000).unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass per brokerage, inside that tenant's context, as the other sweeps do. */
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await forEachTenant(() => allTenantIds(this.prisma), async () => { await this.reminders.sweep(); });
    } catch (err) {
      this.log.error(`Appointment reminder sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }
}
