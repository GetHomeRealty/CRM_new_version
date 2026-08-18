import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { InvoiceReminderService } from './invoice-reminder.service';
import { schedulersEnabled, schedulerSkipReason } from '../common/schedulers';
import { clusterTick } from '../redis/cluster-tick';
import { RedisService } from '../redis/redis.service';
import { CacheService } from '../redis/cache.service';
import { registerWorker, trackedTick } from '../observability/worker-health';

/**
 * Wakes the Invoice auto-reminder sweep.
 *
 * Modelled on the retention and reminder sweeps, including why only one process may run it: this one
 * SENDS EMAIL. Two instances racing would put two copies of the same chaser in a customer's inbox,
 * and an invoice reminder is a message about money — a duplicate reads as a second demand.
 *
 * THREE THINGS STOP A DUPLICATE, at three different levels:
 *
 *   `RUN_SCHEDULERS` decides whether this process runs timers at all. That is the single-instance
 *   answer and the one the deployment already uses.
 *
 *   `clusterTick` makes exactly one process win each pass when Redis is present, so a clustered
 *   deployment (`WEB_CONCURRENCY` > 1) sweeps once rather than once per worker.
 *
 *   The REMINDER HISTORY makes the send itself idempotent — see `InvoiceReminderService`. That is
 *   the one that holds when the other two are misconfigured, because it is a property of the data
 *   rather than of the topology.
 *
 * HOURLY, NOT EVERY FEW SECONDS. The schedule it evaluates moves a day at a time, so a tighter poll
 * would re-read the same candidates to reach the same conclusion. Hourly means a reminder due today
 * goes out within the hour whatever time the process started, and a restart at any point costs at
 * most one hour rather than a day.
 */
const POLL_INTERVAL_MS = 60 * 60 * 1000;

/** Five minutes after boot: a deploy should finish before anything is emailed. */
const FIRST_RUN_DELAY_MS = 5 * 60 * 1000;

@Injectable()
export class InvoiceReminderScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(InvoiceReminderScheduler.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly reminders: InvoiceReminderService,
    private readonly redis?: RedisService,
    private readonly cache?: CacheService,
  ) {}

  onModuleInit(): void {
    if (!schedulersEnabled()) {
      this.log.log(`Invoice auto-reminders not scheduled (${schedulerSkipReason()}). Reminders sent by hand still work.`);
      return;
    }
    this.log.log('Invoice auto-reminders scheduled — invoices with an auto-reminder setting are evaluated hourly.');
    registerWorker('invoice-reminders', POLL_INTERVAL_MS);
    this.timer = setInterval(
      this.redis && this.cache
        ? clusterTick({ redis: this.redis, cache: this.cache }, 'invoice-reminders', () => this.run())
        : trackedTick('invoice-reminders', () => this.run()),
      POLL_INTERVAL_MS,
    );
    if (typeof this.timer.unref === 'function') this.timer.unref();
    setTimeout(() => void this.run(), FIRST_RUN_DELAY_MS).unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * One pass, never two at once.
   *
   * `running` guards the case `clusterTick` cannot: a sweep that outlives its own interval on this
   * same process. Overlapping passes would both read the same candidate before either wrote a
   * history entry, which is the one window where the idempotence check can be beaten.
   */
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.reminders.sweep();
    } catch (err) {
      this.log.error(`Invoice auto-reminder sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }
}
