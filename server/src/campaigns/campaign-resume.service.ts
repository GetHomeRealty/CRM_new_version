import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CampaignsService } from './campaigns.service';
import { schedulersEnabled, schedulerSkipReason } from '../common/schedulers';
import { forEachTenant } from '../core/tenant-context';
import { allTenantIds } from '../core/tenants';

/** Wait after boot before resuming, so recovery does not compete with startup. */
const RESUME_DELAY_MS = 20_000;

/**
 * How often to look for campaigns whose scheduled time has arrived.
 *
 * A minute is the resolution the feature actually offers, and saying so is more honest than a
 * picker that implies seconds. Anything finer would poll far more often than a brokerage sending
 * a handful of campaigns a week could justify.
 */
const SCHEDULE_TICK_MS = 60_000;

/**
 * Finishes campaigns that a restart interrupted.
 *
 * Sending happens off the request thread, which fixed the timeouts but left one gap: a process
 * that stops mid-send — a deploy, a crash, an OOM kill — leaves some recipients emailed and the
 * rest not. The campaign said `sending` for ever and the only way forward was to send the whole
 * thing again, which would deliver a second copy to everyone who already had one. For a brokerage
 * that is worse than not sending at all.
 *
 * Resuming is only safe because progress is recorded per recipient. `campaign_recipients.status`
 * moves to `sent` or `failed` as each one is dealt with, so the rows still `pending` are exactly
 * the ones nobody has been emailed about — no bookkeeping to reconcile, and re-running cannot
 * double-send.
 *
 * Everything else the send needs was already on the row (template, subject, content, sender) or is
 * now persisted alongside it (`tracking_base_url`, and the resolved `vars` per recipient), so a
 * resumed campaign addresses the remainder exactly as the first half were addressed — even if the
 * lead has been edited or deleted since.
 */
@Injectable()
export class CampaignResumeService implements OnModuleInit {
  private readonly log = new Logger(CampaignResumeService.name);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private scheduleTimer: ReturnType<typeof setInterval> | null = null;
  /** Guards against a slow send being overlapped by the next tick. */
  private dispatching = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly campaigns: CampaignsService,
  ) {}

  onModuleInit(): void {
    // Only the scheduler owner resumes. Two processes both picking up the same interrupted
    // campaign would race on the same pending rows and send duplicates — the precise outcome this
    // exists to prevent.
    if (!schedulersEnabled()) {
      this.log.log(`Campaign resume not armed (${schedulerSkipReason()}).`);
      return;
    }
    this.timer = setTimeout(() => { void this.resumeAll(); }, RESUME_DELAY_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();

    // One timer for both sweeps, run in sequence rather than concurrently: they both end in a
    // delivery pass, and two of those starting in the same tick is how a campaign gets sent twice.
    this.scheduleTimer = setInterval(() => { void this.tick(); }, SCHEDULE_TICK_MS);
    if (typeof this.scheduleTimer.unref === 'function') this.scheduleTimer.unref();
    this.log.log(`Scheduled campaigns and soft-bounce retries checked every ${SCHEDULE_TICK_MS / 1000}s.`);
  }

  /** One pass of each sweep. Neither may take the timer down, so both are caught inside. */
  private async tick(): Promise<void> {
    await this.dispatchDue();
    await this.retryDeferred();
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
  }

  /**
   * Send anything whose time has come.
   *
   * `dispatching` matters more than it looks: a campaign to a few hundred recipients takes minutes,
   * far longer than the tick, and without the guard the next tick would pick up the same row —
   * which is still `scheduled` until the status write lands — and send it twice. Claiming the row
   * by flipping its status is what makes the second tick skip it, and the flag covers the window
   * before that write completes.
   */
  async dispatchDue(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      await forEachTenant(() => allTenantIds(this.prisma), () => this.dispatchDueForTenant());
    } catch (err) {
      this.log.error(`Scheduled campaign sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.dispatching = false;
    }
  }

  private async dispatchDueForTenant(): Promise<void> {
    const due = await this.prisma.campaigns.findMany({
      where: { status: 'scheduled', scheduled_for: { lte: new Date() } },
      select: { id: true, name: true, scheduled_for: true },
      orderBy: { scheduled_for: 'asc' },
    });
    for (const c of due) {
      this.log.log(`Sending scheduled campaign #${c.id} "${c.name}" (was due ${c.scheduled_for?.toISOString()}).`);
      try {
        await this.campaigns.dispatchScheduled(c.id);
      } catch (err) {
        this.log.error(
          `Scheduled campaign #${c.id} failed to start: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Left as `partial` rather than `scheduled`: retrying on the next tick would hammer a
        // broken send every minute, and a campaign nobody can explain is worse than one that
        // visibly stopped.
        await this.prisma.campaigns
          .update({ where: { id: c.id }, data: { status: 'partial', updated_at: new Date() } })
          .catch(() => undefined);
      }
    }
  }

  /**
   * Try again at the addresses that deferred us.
   *
   * A soft bounce — mailbox full, greylisted, rate-limited — leaves the recipient `pending` with a
   * `next_retry_at`, and the campaign `sending`. Without this sweep those recipients would simply
   * wait: the delivery pass that deferred them has finished, and nothing else looks at the row
   * until the next restart. That is the difference between "we'll try again in an hour" and
   * quietly dropping a deliverable recipient.
   *
   * `resume` re-reads what is due and sends only that, so a campaign whose backoff has not expired
   * costs one query and nothing else.
   */
  async retryDeferred(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      await forEachTenant(() => allTenantIds(this.prisma), () => this.retryDeferredForTenant());
    } catch (err) {
      this.log.error(`Soft-bounce retry sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.dispatching = false;
    }
  }

  private async retryDeferredForTenant(): Promise<void> {
    // Which campaigns have someone due, rather than which recipients — the delivery pass picks up
    // every due recipient of a campaign in one go, so one row per campaign is all this needs.
    const due = await this.prisma.campaign_recipients.findMany({
      where: {
        status: 'pending',
        next_retry_at: { not: null, lte: new Date() },
        campaigns: { status: 'sending' },
      },
      select: { campaign_id: true },
      distinct: ['campaign_id'],
      orderBy: { campaign_id: 'asc' },
    });

    for (const { campaign_id } of due) {
      try {
        await this.campaigns.resume(campaign_id);
      } catch (err) {
        this.log.error(
          `Could not retry deferred recipients of campaign #${campaign_id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /** One pass per brokerage, inside that brokerage's context. */
  async resumeAll(): Promise<void> {
    try {
      await forEachTenant(() => allTenantIds(this.prisma), () => this.resumeForTenant());
    } catch (err) {
      this.log.error(`Campaign resume sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async resumeForTenant(): Promise<void> {
    const stuck = await this.prisma.campaigns.findMany({
      where: { status: 'sending' },
      select: { id: true, name: true },
      orderBy: { id: 'asc' },
    });
    if (!stuck.length) return;

    for (const c of stuck) {
      const pending = await this.prisma.campaign_recipients.count({
        where: { campaign_id: c.id, status: 'pending' },
      });

      if (pending === 0) {
        /*
         * Interrupted after the last recipient but before the closing update. Nothing left to
         * send, so this is bookkeeping rather than delivery — settle the status from the counts
         * that are already correct instead of starting a send that would do nothing.
         */
        const counts = await this.prisma.campaigns.findUnique({
          where: { id: c.id }, select: { sent: true, failed: true },
        });
        const status = (counts?.sent ?? 0) === 0 ? 'failed' : (counts?.failed ?? 0) > 0 ? 'partial' : 'completed';
        await this.prisma.campaigns.update({ where: { id: c.id }, data: { status, updated_at: new Date() } });
        this.log.log(`Campaign #${c.id} "${c.name}" was already finished; recorded as ${status}.`);
        continue;
      }

      // Some of those `pending` rows may be soft bounces still inside their backoff rather than
      // recipients an interruption stranded. `resume` sends only what is due; saying so here keeps
      // the log from reporting a healthy retry queue as an interrupted send.
      const deferred = await this.prisma.campaign_recipients.count({
        where: { campaign_id: c.id, status: 'pending', next_retry_at: { not: null, gt: new Date() } },
      });
      if (deferred === pending) {
        this.log.log(`Campaign #${c.id} "${c.name}" has ${deferred} recipient(s) waiting on a bounce retry — nothing due yet.`);
        continue;
      }
      this.log.warn(
        `Resuming campaign #${c.id} "${c.name}" — ${pending - deferred} recipient(s) never sent`
        + `${deferred ? `, ${deferred} more waiting on a bounce retry` : ''}.`,
      );
      try {
        await this.campaigns.resume(c.id);
      } catch (err) {
        this.log.error(
          `Could not resume campaign #${c.id}: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err.stack : undefined,
        );
        await this.prisma.campaigns
          .update({ where: { id: c.id }, data: { status: 'partial', updated_at: new Date() } })
          .catch(() => undefined);
      }
    }
  }
}
