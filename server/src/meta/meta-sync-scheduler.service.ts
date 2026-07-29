import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MetaSyncService } from './meta-sync.service';
import { schedulersEnabled, schedulerSkipReason } from '../common/schedulers';

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
    this.timer = setInterval(() => { void this.pollAll(); }, POLL_INTERVAL_MS);
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
  async pollAll(): Promise<void> {
    if (this.running) return; // a slow round must not overlap the next tick
    this.running = true;
    try {
      const connections = await this.prisma.meta_connections.findMany({
        where: { is_active: true },
        select: { user_id: true },
      });
      if (!connections.length) return;

      for (const c of connections) {
        const user = await this.prisma.users.findUnique({
          where: { id: c.user_id },
          select: { id: true, name: true, email: true, role: true },
        });
        // A connection whose owner was deleted or deactivated has nothing to sync against.
        if (!user) continue;

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
    } finally {
      this.running = false;
    }
  }
}
