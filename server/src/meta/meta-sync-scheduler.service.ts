import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MetaSyncService } from './meta-sync.service';
import { schedulersEnabled, schedulerSkipReason } from '../common/schedulers';

import { forEachTenant } from '../core/tenant-context';
import { allTenantIds } from '../core/tenants';
import { registerWorker, trackedTick } from '../observability/worker-health';
/**
 * Pulls Meta lead-ad submissions on a timer, so leads arrive without anyone pressing Sync.
 *
 * Meta's webhook is the fast path and this does not replace it — a webhook delivery lands within
 * seconds, this within the interval. It exists because the webhook is the more fragile of the
 * two: it only works while META_PUBLIC_URL is a public HTTPS address Meta can actually reach and
 * the subscription is live. A tunnel that expired, a redeploy on a new host, a subscription that
 * lapsed — in every case deliveries stop silently and the only symptom is leads that never
 * appear. Polling closes that gap, and because both paths converge on the same upsert, a lead
 * that arrived by webhook is recognised rather than duplicated.
 *
 * `syncUser` already understood a 'scheduled' trigger and recorded it in the sync history;
 * nothing was calling it.
 */

/** How often connected accounts are polled. Long by IMAP standards: Graph rate limits are strict. */
const POLL_INTERVAL_MS = Math.max(60, Number(process.env.META_SYNC_SECONDS ?? 900)) * 1000;
/** A first pass shortly after boot, so a restart does not leave a gap until the first tick. */
const FIRST_POLL_DELAY_MS = 20 * 1000;

@Injectable()
export class MetaSyncSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(MetaSyncSchedulerService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: MetaSyncService,
  ) {}

  onModuleInit(): void {
    // Same rule as the other schedulers: one process owns them, and a test run must never reach
    // the Graph API on a timer.
    if (!schedulersEnabled() || process.env.META_SYNC_DISABLED === '1') {
      this.log.log(`Meta auto-sync not started (${process.env.META_SYNC_DISABLED === '1' ? 'META_SYNC_DISABLED=1' : schedulerSkipReason()}). "Sync now" still works.`);
      return;
    }

    this.first = setTimeout(() => { void this.pollAll(); }, FIRST_POLL_DELAY_MS);
    this.first.unref?.();
    registerWorker('meta-sync', POLL_INTERVAL_MS);
    this.timer = setInterval(trackedTick('meta-sync', () => this.pollAll()), POLL_INTERVAL_MS);
    this.timer.unref?.();
    this.log.log(`Meta auto-sync every ${POLL_INTERVAL_MS / 1000}s (first pass in ${FIRST_POLL_DELAY_MS / 1000}s)`);
  }

  onModuleDestroy(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Sync every active connection, one after another.
   *
   * Deliberately sequential, unlike the IMAP poller. Graph rate limits are per app, not per
   * connection, so running accounts in parallel spends the same budget faster and risks a
   * throttle that stops every account at once — and unlike mail, nobody is waiting on this in
   * the foreground.
   */
  /**
   * Pull lead-ad submissions, one brokerage at a time.
   *
   * The pass itself is unchanged; it simply runs once per tenant, inside that tenant's
   * context, so every query it makes is scoped the same way a request would be.
   */
  async pollAll(): Promise<void> {
    await forEachTenant(() => allTenantIds(this.prisma), () => this.pollAllForTenant());
  }

  async pollAllForTenant(): Promise<void> {
    if (this.running) return; // a slow round must not overlap the next tick
    this.running = true;
    try {
      /*
       * Connections whose token Meta has already told us is finished are skipped.
       *
       * `token_expires_at` is set to the moment of the failure when a sync hits a 190, so this
       * filter is "the token is known dead", not a guess about age. Without it the poll retried a
       * dead token every fifteen minutes for ever — one Graph call per connected form each time,
       * charged to the shared app budget, producing an identical error line nobody was reading.
       *
       * The agent has been emailed and the screen says Reconnect. Until somebody acts there is
       * nothing here to retry, and retrying costs the agents whose tokens still work.
       */
      const connections = await this.prisma.meta_connections.findMany({
        where: {
          is_active: true,
          OR: [{ token_expires_at: null }, { token_expires_at: { gt: new Date() } }],
        },
        select: { user_id: true },
      });
      if (!connections.length) return;

      for (const c of connections) {
        const user = await this.prisma.users.findUnique({
          where: { id: c.user_id },
          select: { id: true, name: true, email: true, role: true, status: true },
        });
        // A connection whose owner was deleted has nothing to sync against.
        if (!user) continue;

        /*
         * NOR HAS ONE WHOSE OWNER IS DEACTIVATED — which this claimed to handle and did not.
         * `findUnique` returns a deactivated account exactly as it returns an active one, so the
         * poll ran on, importing leads into a book that had just been made unreachable: the owner
         * cannot sign in, and lead visibility is per person, so an administrator cannot see them
         * either. The brokerage kept paying for the clicks and nobody ever saw the enquiries.
         *
         * Skipping rather than disconnecting, deliberately. This is reversible — reactivate the
         * account and the next tick resumes, with the tokens and the form claims untouched —
         * whereas disconnecting destroys the tokens and releases the forms, which is right for a
         * departure and wrong for a suspension.
         *
         * A NET RATHER THAN THE MECHANISM. Deactivating an account now disconnects Meta outright
         * (`OffboardingService.depart`), so through the UI this should never fire. It covers
         * connections predating that change, and the case where the disconnect could not complete
         * — `depart` deliberately does not abort a deactivation when the Meta call fails, because
         * cutting off access must not wait on Meta.
         *
         * What this does not do is retrieve leads that arrive while paused. Meta keeps them
         * retrievable for a limited window, so the form should be connected by whoever takes over
         * the advertising.
         */
        if ((user.status ?? 'Active') !== 'Active') {
          this.log.warn(
            `Meta auto-sync skipped for ${user.name}: their account is ${user.status}. `
            + 'Leads for this form are not being collected. Disconnect Meta on that account and '
            + 'connect the form to whoever is running it now.',
          );
          continue;
        }

        try {
          const r = await this.sync.syncUser(user as never, 'scheduled');
          if (r.imported || r.updated) {
            this.log.log(`Meta auto-sync for ${user.name}: ${r.imported} new, ${r.updated} updated, ${r.duplicates} duplicate(s).`);
          }
          // syncUser collects per-form problems rather than throwing, so they surface here.
          for (const e of r.errors) this.log.warn(`Meta auto-sync (${user.name}): ${e}`);
        } catch (ex) {
          // One account's failure must not stop the rest — an expired token is common and
          // is already recorded against the connection by syncUser.
          this.log.warn(`Meta auto-sync failed for user #${c.user_id}: ${(ex as Error).message}`);
        }
      }

      /*
       * Forget raw Graph payloads past their retention window.
       *
       * Runs here rather than on its own timer because it is housekeeping that does not need to be
       * prompt, and this pass already holds the `running` guard so two sweeps cannot overlap. Its
       * own failure must not affect the sync that just succeeded.
       */
      try {
        await this.sync.pruneRawPayloads();
      } catch (ex) {
        this.log.warn(`Meta payload retention sweep failed: ${(ex as Error).message}`);
      }
    } finally {
      this.running = false;
    }
  }
}
