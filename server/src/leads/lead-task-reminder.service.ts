import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { schedulerSkipReason, schedulersEnabled } from '../common/schedulers';
import { registerWorker } from '../observability/worker-health';
import { clusterTick } from '../redis/cluster-tick';
import { RedisService } from '../redis/redis.service';
import { CacheService } from '../redis/cache.service';
import { forEachTenant } from '../core/tenant-context';
import { allTenantIds } from '../core/tenants';
import { CrmEventNotifier } from '../notifications/crm-events.service';

/** Every 30 minutes. A follow-up is due on a DAY, so this is about promptness, not precision. */
const POLL_INTERVAL_MS = 30 * 60 * 1000;
/** A short delay after boot, so a restart does not sweep before the application has settled. */
const FIRST_PASS_MS = 45 * 1000;

/**
 * Tells people when a follow-up on one of their leads falls due.
 *
 * WHY A SWEEP RATHER THAN A TIMER PER TASK. A task's due date can be set weeks out, changed, or
 * completed before it arrives; a timer scheduled at creation would have to be cancelled and rebuilt
 * on every edit and would not survive a restart. Asking "what is due today and not yet done?" on a
 * schedule needs no bookkeeping and is correct after any outage.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not notify for a task that has been completed,
 * cancelled, or whose lead has been deleted — each is checked in the query rather than after, so a
 * task completed five minutes before the sweep produces nothing.
 *
 * IDEMPOTENT BY DAY. The dedupe key is the task and the due date, so the sweep running every thirty
 * minutes notifies once, and a retry after a failure notifies nobody twice. A task legitimately due
 * again on a later date is a different key and does notify.
 */
@Injectable()
export class LeadTaskReminderService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(LeadTaskReminderService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crmEvents: CrmEventNotifier,
    private readonly redis: RedisService,
    private readonly cache: CacheService,
  ) {}

  onModuleInit(): void {
    if (!schedulersEnabled() || process.env.LEAD_TASK_REMINDERS_DISABLED === '1') {
      this.log.log(
        `Lead follow-up reminders not scheduled (${process.env.LEAD_TASK_REMINDERS_DISABLED === '1'
          ? 'LEAD_TASK_REMINDERS_DISABLED=1' : schedulerSkipReason()}).`,
      );
      return;
    }

    registerWorker('lead-task-due', POLL_INTERVAL_MS);
    /*
     * `clusterTick`, not `trackedTick`: this notifies real people, so two processes running it
     * would mean two of everything. With Redis exactly one process wins each pass; without it,
     * behaviour is unchanged from a single-instance deployment.
     */
    const tick = clusterTick({ redis: this.redis, cache: this.cache }, 'lead-task-due', () => this.sweepAllTenants());
    setTimeout(tick, FIRST_PASS_MS).unref?.();
    this.timer = setInterval(tick, POLL_INTERVAL_MS);
    this.timer.unref?.();
    this.log.log(`Lead follow-up reminders every ${POLL_INTERVAL_MS / 60000} minutes (first pass in ${FIRST_PASS_MS / 1000}s).`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** A timer has no request to inherit a brokerage from, so it must name each one itself. */
  async sweepAllTenants(): Promise<void> {
    await forEachTenant(() => allTenantIds(this.prisma), () => this.sweep());
  }

  /**
   * One pass for one brokerage.
   *
   * `today` is injectable so a test can place itself relative to a due date rather than having to
   * create a task at a real wall-clock offset.
   */
  async sweep(today: Date = new Date()): Promise<{ notified: number }> {
    // Midnight UTC, matching the `@db.Date` column — a task due "today" is due for the whole day.
    const endOfDay = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 23, 59, 59));

    const due = await this.prisma.lead_tasks.findMany({
      where: {
        // Due today or overdue. An overdue follow-up is still worth chasing, and the dedupe key is
        // per due-date, so an overdue task notifies once rather than every pass.
        due_date: { lte: endOfDay },
        status: 'pending',
        assigned_to: { not: null },
        // A task on a deleted lead is not work anybody should be chased about.
        leads: { deleted_at: null },
      },
      select: {
        id: true, title: true, due_date: true, assigned_to: true,
        leads: { select: { id: true, name: true, email: true } },
      },
      orderBy: { due_date: 'asc' },
      // Bounded: a brokerage with a large backlog must not turn one pass into an unbounded job.
      take: 500,
    });

    let notified = 0;
    for (const task of due) {
      if (!task.assigned_to || !task.leads) continue;
      await this.crmEvents.leadTaskDue(
        { id: task.id, title: task.title, due_at: task.due_date },
        { id: task.leads.id, first_name: task.leads.name, last_name: null, email: task.leads.email },
        task.assigned_to,
        // The occurrence: the day it was due. Two passes on the same day are one notification; a
        // task due again on another date is a different occurrence and notifies again.
        task.due_date.toISOString().slice(0, 10),
      );
      notified += 1;
    }

    if (notified) this.log.log(`Lead follow-up reminders: ${notified} due task(s) processed.`);
    return { notified };
  }
}
