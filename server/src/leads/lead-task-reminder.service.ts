import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { schedulerSkipReason, schedulersEnabled } from '../common/schedulers';
import { registerWorker } from '../observability/worker-health';
import { clusterTick } from '../redis/cluster-tick';
import { RedisService } from '../redis/redis.service';
import { CacheService } from '../redis/cache.service';
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
 *
 * ================================================================================================
 * AND THE ALREADY-NOTIFIED TEST IS IN THE QUERY, BEFORE THE LIMIT. This used to take the 500
 * longest-overdue tasks and rely on the dedupe key downstream to drop the ones already handled.
 * Two things followed, and neither is visible from the dispatcher's side:
 *
 *   STARVATION. `status` stays `pending` until a person completes the task, and the order is
 *   oldest-due first, so those 500 were re-selected every pass forever. A brokerage carrying a
 *   backlog of 500 stale overdue tasks would never notify anybody about task 501 — including every
 *   task that fell due afterwards. Unlike a birthday sweep, this does not reset the next day: the
 *   backlog is permanent, so the starvation is permanent.
 *
 *   REPEAT SENDS ON THE UNDEDUPED CHANNELS. The dedupe key is enforced by a unique index on the
 *   in-app row, which is the only channel that consults it — `lead_task_due` also supports email
 *   and push. Re-selecting the same task every pass therefore re-sent email and push every thirty
 *   minutes, for as long as the task stayed overdue: forty-eight emails a day, per task.
 *
 * Excluding the notified rows BEFORE the limit fixes both, because a task the recipient has already
 * been told about is no longer selected at all.
 * ================================================================================================
 *
 * THE EXCLUSION READS THE DISPATCHER'S DELIVERY LEDGER, so it holds whatever the recipient's channel
 * preferences are. An earlier version of this read the in-app notification row instead, which meant
 * a recipient who muted in-app — and kept email — recorded nothing, was re-selected on every pass,
 * and was re-emailed every thirty minutes for having switched off the channel that was keeping the
 * books. The ledger records what was HANDLED rather than what was DELIVERED, which is the question
 * this query is actually asking. Nothing about deduplication is implemented here any more.
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
    const tick = clusterTick({ redis: this.redis, cache: this.cache }, 'lead-task-due', () => this.sweep());
    setTimeout(tick, FIRST_PASS_MS).unref?.();
    this.timer = setInterval(tick, POLL_INTERVAL_MS);
    this.timer.unref?.();
    this.log.log(`Lead follow-up reminders every ${POLL_INTERVAL_MS / 60000} minutes (first pass in ${FIRST_PASS_MS / 1000}s).`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass over every due follow-up.
   *
   * `today` is injectable so a test can place itself relative to a due date rather than having to
   * create a task at a real wall-clock offset.
   */
  async sweep(today: Date = new Date()): Promise<{ notified: number }> {
    // Midnight UTC, matching the `@db.Date` column — a task due "today" is due for the whole day.
    const endOfDay = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 23, 59, 59));

    /*
     * Raw, because Prisma's query builder cannot express the `NOT EXISTS` against the dedupe key —
     * the key is a STRING BUILT FROM the task's own id and due date, so the correlation is on a
     * computed value rather than on a column it could relate through. See the class note for what
     * happens when this test is applied after the limit instead of before it.
     *
     * `to_char(due_date, 'YYYY-MM-DD')` is the SQL twin of the `occurrence` argument below —
     * `due_date.toISOString().slice(0, 10)` — and they must stay in step. Both are safe against a
     * timezone shifting the day: the column is a DATE, and Prisma hands it back as UTC midnight.
     *
     * IT READS THE DELIVERY LEDGER, NOT THE IN-APP NOTIFICATION ROW. Those are different questions
     * and only one of them is the right one. `notifications` records what was DELIVERED in-app, so
     * a recipient who muted in-app wrote no row and this exclusion would never fire for them — they
     * would be re-selected for ever, and re-emailed every pass, precisely because they had turned
     * off the channel that happened to be keeping the books. `notification_deliveries` records what
     * was HANDLED, for every channel including the muted ones, so it answers "has this person
     * already been told about this occurrence?" whatever their preferences are.
     *
     * Any row for the occurrence is enough — the channel is not part of the test. One row means
     * `dispatch` ran for it, and dispatch is what decides per channel.
     *
     * The lookup is served by the ledger's `(user_id, category, dedupe_key, channel)` unique index
     * as an equality match on its first three columns. No extra index.
     */
    const ids = await this.prisma.$queryRaw<{ id: number }[]>`
      SELECT t.id
        FROM lead_tasks t
        JOIN leads l ON l.id = t.lead_id
       WHERE t.due_date <= ${endOfDay}
         AND t.status = 'pending'
         AND t.assigned_to IS NOT NULL
         AND l.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM notification_deliveries d
            WHERE d.user_id = t.assigned_to
              AND d.category = 'lead_task_due'
              AND d.dedupe_key = 'lead-task-due:' || t.id || ':' || to_char(t.due_date, 'YYYY-MM-DD')
         )
       ORDER BY t.due_date ASC, t.id ASC
       LIMIT 500`;
    if (ids.length === 0) return { notified: 0 };

    const rows = await this.prisma.lead_tasks.findMany({
      where: { id: { in: ids.map((r) => r.id) } },
      select: {
        id: true, title: true, due_date: true, assigned_to: true,
        leads: { select: { id: true, name: true, email: true } },
      },
    });

    // `findMany` does not promise the order of an `in` list, and oldest-due-first is the order the
    // work should be done in when a pass is truncated.
    const byId = new Map(rows.map((r) => [r.id, r]));
    const due = ids.map((r) => byId.get(r.id)).filter((r): r is NonNullable<typeof r> => Boolean(r));

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
