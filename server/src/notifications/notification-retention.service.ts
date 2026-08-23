import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { schedulerSkipReason, schedulersEnabled } from '../common/schedulers';
import { registerWorker } from '../observability/worker-health';
import { clusterTick } from '../redis/cluster-tick';
import { RedisService } from '../redis/redis.service';
import { CacheService } from '../redis/cache.service';
import { RETENTION_MONTHS } from '../retention/retention.service';

/**
 * Six-month retention for notification history and for the delivery ledger.
 *
 * ================================================================================================
 * THE ONE THING THAT MAKES THIS DANGEROUS, and the reason most of this file is a guard rather than
 * a DELETE.
 *
 * `notification_deliveries` is not history. It is the record that STOPS a notification being sent
 * again, so deleting a row hands back permission to send. For almost every category that is
 * harmless, because the event is over: a campaign finished once, a lead was created once, a mention
 * happened once, and nothing will ever produce that occurrence a second time.
 *
 * `lead_task_due` is the exception, and it is not a hypothetical one. A follow-up stays `pending`
 * until a PERSON completes it, and the sweep selects on `due_date <= today` — so a task that fell
 * due eight months ago and was never done is still selected on every pass today. Purge its ledger
 * row on age alone and the next sweep finds no record, treats the occurrence as new, and emails the
 * agent about a follow-up they were already told about eight months ago. Every thirty minutes,
 * until somebody closes the task.
 *
 * So age is necessary and not sufficient. A row is purged only when it is older than the window AND
 * nothing can still produce its occurrence. `STILL_LIVE` below is that second test, written per
 * category, and a category with no entry is one where the occurrence genuinely cannot recur.
 * ================================================================================================
 *
 * WHY THE CATEGORIES WITHOUT A GUARD ARE SAFE — checked one at a time rather than assumed, because
 * "probably one-shot" is how the `lead_task_due` case would have been missed too:
 *
 *   lead_created, lead_meta, lead_assigned   raised when the thing happens; no sweep re-selects them
 *   campaign_completed, campaign_failed      terminal states of a campaign that has stopped
 *   transaction_approvals, document_review   raised by a person's decision
 *   mention                                  keyed to one message and one reader
 *   lawyer_details, listing_expiry           the reminder sweep keys on the DAY, so an old key can
 *                                            never be produced again — tomorrow is a different key
 *   calendar reminders                       the retry stops at `MAX` attempts and clears
 *                                            `next_retry_at`, so an exhausted reminder is never
 *                                            selected again whatever its age
 *   inbox                                    keyed to a mailbox UID, which only ever increases
 *
 * `lead_assigned` deserves a note. Its key is the lead and the assignee with no occurrence, so
 * re-assigning the same lead to the same person is currently suppressed FOR EVER. Purging after six
 * months restores the notification for a genuine re-assignment more than six months later, which is
 * a better answer than silence — but it is a behaviour change and is called out here rather than
 * discovered later.
 *
 * `notifications` — the in-app list — is ordinary history and is purged on age alone. It stopped
 * being the dedupe record when the ledger arrived; the ledger is authoritative, and rows written
 * before it existed were backfilled into it by the migration.
 *
 * DRY RUN IS THE DEFAULT, matching Transaction Desk retention exactly: `plan()` only counts, and
 * `sweep()` refuses to delete unless `NOTIFICATION_RETENTION_ENABLED=true`. Deploying this starts deleting
 * nothing, and a staging run reports what production would remove before anybody agrees to it.
 */
@Injectable()
export class NotificationRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(NotificationRetentionService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  /** Once a day is ample for a policy measured in months. */
  private static readonly SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
  private static readonly FIRST_SWEEP_DELAY_MS = 15 * 60 * 1000;
  /** Rows per statement, and the ceiling for one pass. The rest waits for tomorrow. */
  private static readonly BATCH = 500;
  private static readonly MAX_PER_SWEEP = 20_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis?: RedisService,
    private readonly cache?: CacheService,
  ) {}

  /**
   * The window, in months. `RETENTION_MONTHS` is the shared DEFAULT only — the two policies may
   * differ, and this one is set independently by `NOTIFICATION_RETENTION_MONTHS`. 0 disables this
   * sweep entirely.
   */
  static months(): number {
    const raw = Number(process.env.NOTIFICATION_RETENTION_MONTHS ?? RETENTION_MONTHS);
    return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : RETENTION_MONTHS;
  }

  /**
   * Whether this run may actually delete. Its OWN switch — and this is the important part.
   *
   * THIS AND THE DESK SWEEP USED TO READ THE SAME `RETENTION_ENABLED`. Two sweeps with wildly
   * different blast radii behind one variable meant that turning on notification housekeeping —
   * two tables of expired signals — also armed the Transaction Desk purge, which deletes trashed
   * deals and cascades into twenty child tables including `transaction_reviews`, and removes
   * `audit_logs` and `transaction_reminders` by age alone. Nobody enabling notification retention
   * would expect to be agreeing to that, and the variable's name gave no hint of it.
   *
   * So each sweep now answers to a flag named after itself, and NEITHER reads the other's. The old
   * shared flag is deliberately not consulted, not even as a fallback: production already has
   * `RETENTION_ENABLED=true` set, so honouring it would carry the exact coupling this removes.
   * `warnIfLegacyFlagSet` says so at boot rather than letting it look effective.
   *
   * Absent or malformed means FALSE. A destructive default must be the one that does nothing.
   */
  static enabled(): boolean {
    return (process.env.NOTIFICATION_RETENTION_ENABLED ?? '').trim().toLowerCase() === 'true';
  }

  static cutoff(months = NotificationRetentionService.months(), now = new Date()): Date {
    const d = new Date(now);
    d.setMonth(d.getMonth() - months);
    return d;
  }

  onModuleInit(): void {
    const months = NotificationRetentionService.months();
    if (months === 0) {
      this.log.log('Notification retention is off (NOTIFICATION_RETENTION_MONTHS=0) — nothing is purged.');
      return;
    }
    if (!schedulersEnabled()) {
      this.log.log(`Notification retention sweep not started (${schedulerSkipReason()}).`);
      return;
    }

    this.first = setTimeout(() => { void this.sweep(); }, NotificationRetentionService.FIRST_SWEEP_DELAY_MS);
    this.first.unref?.();

    // `clusterTick`, because this DESTROYS rows and two processes racing the same batch is exactly
    // what a lock is for. Without Redis it behaves as a single instance always has.
    registerWorker('notification-retention', NotificationRetentionService.SWEEP_INTERVAL_MS);
    this.timer = setInterval(
      this.redis && this.cache
        ? clusterTick({ redis: this.redis, cache: this.cache }, 'notification-retention', () => this.sweep())
        : () => { void this.sweep(); },
      NotificationRetentionService.SWEEP_INTERVAL_MS,
    );
    this.timer.unref?.();

    /*
     * Named, scoped and unambiguous. The previous line said only "notification history ... purged",
     * which on a console beside the Desk sweep's own message left it unclear which system was
     * armed. Anyone reading this must be able to tell WHICH retention is on, over WHAT, without
     * consulting the code.
     */
    this.log.log(
      NotificationRetentionService.enabled()
        ? `Notification retention: ENABLED (NOTIFICATION_RETENTION_ENABLED=true), ${months} month(s). `
          + 'Scope: notifications and notification_deliveries ONLY. No Transaction Desk or CRM record is touched.'
        : `Notification retention: DISABLED — DRY RUN, ${months} month(s). It will report what would be `
          + 'removed from notifications and notification_deliveries and delete nothing. '
          + 'Set NOTIFICATION_RETENTION_ENABLED=true to act.',
    );
  }

  onModuleDestroy(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * What a sweep WOULD remove, without removing it.
   *
   * `protected` is reported separately and is the number worth watching: it is how many ledger rows
   * are past the window but still holding back a live occurrence. A number that climbs steadily
   * means a growing pile of overdue follow-ups nobody is closing, which is worth knowing on its own.
   */
  async plan(now = new Date()): Promise<{
    cutoff: string; months: number; enabled: boolean;
    deliveries: number; protected: number; notifications: number;
  }> {
    const months = NotificationRetentionService.months();
    const cutoff = NotificationRetentionService.cutoff(months, now);

    const [purgeable, expired, notifications] = await Promise.all([
      this.countPurgeableDeliveries(cutoff),
      this.prisma.notification_deliveries.count({ where: { created_at: { lt: cutoff } } }),
      this.prisma.notifications.count({ where: { created_at: { lt: cutoff } } }),
    ]);

    return {
      cutoff: cutoff.toISOString(),
      months,
      enabled: NotificationRetentionService.enabled(),
      deliveries: purgeable,
      protected: expired - purgeable,
      notifications,
    };
  }

  /** One pass. Deletes nothing unless `NOTIFICATION_RETENTION_ENABLED=true`. */
  async sweep(now = new Date()): Promise<{ deliveries: number; notifications: number; skipped: boolean }> {
    const months = NotificationRetentionService.months();
    if (months === 0 || this.running) return { deliveries: 0, notifications: 0, skipped: true };

    if (!NotificationRetentionService.enabled()) {
      const p = await this.plan(now);
      this.log.log(
        `Notification retention DRY RUN: would remove ${p.deliveries} ledger row(s) and `
        + `${p.notifications} notification(s) older than ${p.cutoff}; ${p.protected} ledger row(s) `
        + 'are past the window but still protecting a live occurrence.',
      );
      return { deliveries: 0, notifications: 0, skipped: true };
    }

    this.running = true;
    const cutoff = NotificationRetentionService.cutoff(months, now);
    let deliveries = 0;
    let notifications = 0;

    try {
      deliveries = await this.purgeDeliveries(cutoff);
      notifications = await this.purgeNotifications(cutoff);
      if (deliveries || notifications) {
        this.log.log(
          `Notification retention: ${deliveries} ledger row(s) and ${notifications} notification(s) `
          + `removed (older than ${cutoff.toISOString()}).`,
        );
      }
    } catch (err) {
      // Housekeeping must never take the process down; the next pass is in 24 hours.
      this.log.error(`Notification retention sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }

    return { deliveries, notifications, skipped: false };
  }

  // ------------------------------------------------------------------ the guard

  /**
   * The categories whose occurrences can still be produced, and the test for "still live".
   *
   * Each entry is a correlated EXISTS against the ledger row `d`. A row matching one of these is
   * kept however old it is, because purging it would let the occurrence be sent again.
   *
   * ADD AN ENTRY HERE WHENEVER A SWEEP LEARNS TO RE-SELECT SOMETHING. The rule to apply is: can any
   * query still select a row that would produce this exact dedupe key? If yes, it needs a guard.
   */
  private static readonly STILL_LIVE: string[] = [
    /*
     * A follow-up nobody has completed. The sweep selects `due_date <= today` with no lower bound,
     * so age does not retire it — only somebody closing the task does. The key is rebuilt here
     * exactly as `CrmEventNotifier.leadTaskDue` builds it, and the two must stay in step.
     */
    `EXISTS (
       SELECT 1 FROM lead_tasks t
        WHERE d.category = 'lead_task_due'
          AND t.status = 'pending'
          AND d.dedupe_key = 'lead-task-due:' || t.id || ':' || to_char(t.due_date, 'YYYY-MM-DD')
     )`,
  ];

  /** `created_at < cutoff AND NOT (still live)`, as one SQL fragment over the alias `d`. */
  private static purgeableWhere(): string {
    const guards = NotificationRetentionService.STILL_LIVE.map((g) => `NOT ${g}`).join('\n      AND ');
    return `d.created_at < $1${guards ? `\n      AND ${guards}` : ''}`;
  }

  private async countPurgeableDeliveries(cutoff: Date): Promise<number> {
    const rows = await this.prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*) AS count FROM notification_deliveries d WHERE ${NotificationRetentionService.purgeableWhere()}`,
      cutoff,
    );
    return Number(rows[0]?.count ?? 0);
  }

  /** Batched, so one sweep cannot hold a long transaction over the ledger. */
  private async purgeDeliveries(cutoff: Date): Promise<number> {
    let removed = 0;
    for (;;) {
      const done = await this.prisma.$executeRawUnsafe(
        `DELETE FROM notification_deliveries
          WHERE id IN (
            SELECT d.id FROM notification_deliveries d
             WHERE ${NotificationRetentionService.purgeableWhere()}
             ORDER BY d.id
             LIMIT ${NotificationRetentionService.BATCH}
          )`,
        cutoff,
      );
      removed += done;
      if (done < NotificationRetentionService.BATCH) break;
      if (removed >= NotificationRetentionService.MAX_PER_SWEEP) break;
    }
    return removed;
  }

  private async purgeNotifications(cutoff: Date): Promise<number> {
    let removed = 0;
    for (;;) {
      const batch = await this.prisma.notifications.findMany({
        where: { created_at: { lt: cutoff } },
        select: { id: true },
        take: NotificationRetentionService.BATCH,
      });
      if (!batch.length) break;
      const done = await this.prisma.notifications.deleteMany({ where: { id: { in: batch.map((b) => b.id) } } });
      removed += done.count;
      if (batch.length < NotificationRetentionService.BATCH) break;
      if (removed >= NotificationRetentionService.MAX_PER_SWEEP) break;
    }
    return removed;
  }
}
