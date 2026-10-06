import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { schedulersEnabled, schedulerSkipReason } from '../common/schedulers';
import { clusterTick } from '../redis/cluster-tick';
import { RedisService } from '../redis/redis.service';
import { CacheService } from '../redis/cache.service';
import { registerWorker, trackedTick } from '../observability/worker-health';
import { RecruitmentInterviewReminderService } from './recruitment-interview-reminder.service';

/**
 * The job behind recruitment interview reminders.
 *
 * TEN MINUTES, for the reason the appointment reminder sweep gives: the shortest lead time here is
 * an hour, so an hourly tick would deliver "in 1 hour" anywhere between one and two hours early,
 * which is no use to somebody deciding when to leave.
 *
 * Waking often is safe because the pass is idempotent — the reminder's dedupe key names the
 * interview AND its scheduled time, and the unique index on the delivery ledger refuses a repeat.
 * A tick overlapping the last one, a restart mid-pass, or a manual re-run all send nothing extra.
 *
 * Only one process may run it, like every other sweep here: `clusterTick` settles that between
 * instances when Redis is available, and `RECRUITMENT_REMINDER_DISABLED=1` turns it off outright.
 */
const POLL_INTERVAL_MS = 10 * 60 * 1000;

@Injectable()
export class RecruitmentInterviewReminderScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(RecruitmentInterviewReminderScheduler.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly reminders: RecruitmentInterviewReminderService,
    // Optional so the service can be constructed directly in a test without a Redis.
    private readonly redis?: RedisService,
    private readonly cache?: CacheService,
  ) {}

  onModuleInit(): void {
    if (!schedulersEnabled() || process.env.RECRUITMENT_REMINDER_DISABLED === '1') {
      this.log.log(
        `Recruitment interview reminders not scheduled (${
          process.env.RECRUITMENT_REMINDER_DISABLED === '1'
            ? 'RECRUITMENT_REMINDER_DISABLED=1'
            : schedulerSkipReason()
        }).`,
      );
      return;
    }
    registerWorker('recruitment-interview-reminders', POLL_INTERVAL_MS);
    this.timer = setInterval(
      this.redis && this.cache
        ? clusterTick({ redis: this.redis, cache: this.cache }, 'recruitment-interview-reminders', () => this.run())
        : trackedTick('recruitment-interview-reminders', () => this.run()),
      POLL_INTERVAL_MS,
    );
    if (typeof this.timer.unref === 'function') this.timer.unref();
    // One pass shortly after start, so a deployment does not swallow the reminders due during it.
    // Delayed rather than immediate to keep it clear of the boot path.
    setTimeout(() => void this.run(), 50_000).unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async run(): Promise<void> {
    try {
      await this.reminders.run();
    } catch (ex) {
      // A failed pass must not stop the timer: the next tick is ten minutes away and the window
      // has slack enough that a single bad pass loses nothing.
      this.log.error(`Recruitment interview reminder pass failed: ${(ex as Error).message}`);
    }
  }
}
