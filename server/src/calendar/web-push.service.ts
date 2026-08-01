import { Injectable, Logger } from '@nestjs/common';
import webpush from 'web-push';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Push notifications to a browser, for appointment reminders.
 *
 * WHAT THIS IS AND IS NOT. This is Web Push: a notification delivered by the browser's own push
 * service (Google's for Chrome, Mozilla's for Firefox) to a browser that has asked for them. It is
 * NOT a native mobile app notification — there is no mobile app here. It works on desktop and on
 * Android; on iOS it works only where the site has been added to the home screen, because Apple
 * requires an installed PWA before it will deliver one. That limitation is real and is stated on
 * the screen rather than discovered later.
 *
 * WHY IT SITS BESIDE EMAIL RATHER THAN REPLACING IT. A push is delivered to a browser that happens
 * to be reachable. A phone that is off, a browser whose permission was revoked, an iPhone that
 * never installed the site — all of them silently get nothing. Email is the reminder of record;
 * push is the one that arrives while somebody is between appointments.
 *
 * FAILURES ARE NOT ALL THE SAME. A push service answering 404 or 410 is telling us the subscription
 * is gone for good — the browser data was cleared, or permission was withdrawn — and the row is
 * deleted at once. Anything else is counted, and a browser that has failed repeatedly is dropped
 * rather than chased for ever.
 */

/** After this many consecutive failures a subscription is assumed dead and removed. */
const MAX_FAILURES = 5;

export interface PushPayload {
  title: string;
  body: string;
  /** Where the browser should go when the notification is clicked. */
  url?: string;
  /** Groups notifications: a second reminder for one appointment replaces the first. */
  tag?: string;
}

export interface PushResult {
  sent: number;
  failed: number;
  /** Subscriptions the push service told us were gone, and which have been removed. */
  removed: number;
}

@Injectable()
export class WebPushService {
  private readonly log = new Logger(WebPushService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The public key a browser needs to subscribe. Safe to hand out — it is half a keypair, and the
   * private half never leaves this server. Null when push is not configured, which the client reads
   * as "do not offer this".
   */
  publicKey(): string | null {
    const k = (process.env.VAPID_PUBLIC_KEY ?? '').trim();
    return k === '' ? null : k;
  }

  /** Whether push can actually be sent — both halves of the keypair and a contact subject. */
  configured(): boolean {
    return !!(process.env.VAPID_PUBLIC_KEY ?? '').trim() && !!(process.env.VAPID_PRIVATE_KEY ?? '').trim();
  }

  /**
   * Record a browser's subscription.
   *
   * Keyed on the endpoint, which IS the identity of a browser: subscribing again on the same device
   * returns the same endpoint, so this updates rather than inserting a duplicate that would make
   * every reminder arrive twice. The failure count is reset — a browser that has just asked to be
   * subscribed is by definition reachable again.
   */
  async subscribe(
    userId: number,
    sub: { endpoint: string; keys: { p256dh: string; auth: string } },
    scope: string | null,
    userAgent: string | null,
  ): Promise<{ id: number }> {
    const now = new Date();
    const row = await this.prisma.push_subscriptions.upsert({
      where: { endpoint: sub.endpoint },
      create: {
        user_id: userId, endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh, auth: sub.keys.auth,
        scope, user_agent: userAgent?.slice(0, 255) ?? null,
        company_id: 1, created_at: now, updated_at: now,
      },
      // A device handed to a new agent must not keep pushing the old one's appointments, so the
      // owner is taken from whoever is subscribing now.
      update: {
        user_id: userId, p256dh: sub.keys.p256dh, auth: sub.keys.auth,
        scope, user_agent: userAgent?.slice(0, 255) ?? null,
        failures: 0, updated_at: now,
      },
      select: { id: true },
    });
    return row;
  }

  /** Forget a browser. Silent when it is already gone — unsubscribing twice is not an error. */
  async unsubscribe(userId: number, endpoint: string): Promise<{ removed: number }> {
    const done = await this.prisma.push_subscriptions.deleteMany({ where: { user_id: userId, endpoint } });
    return { removed: done.count };
  }

  /** Every browser this person has subscribed, for the settings screen. */
  async forUser(userId: number): Promise<{ id: number; user_agent: string | null; scope: string | null; last_used_at: Date | null; created_at: Date | null }[]> {
    return this.prisma.push_subscriptions.findMany({
      where: { user_id: userId },
      select: { id: true, user_agent: true, scope: true, last_used_at: true, created_at: true },
      orderBy: { id: 'desc' },
    });
  }

  /**
   * Send to every browser one person has subscribed.
   *
   * Never throws. A reminder must not fail because a phone was unreachable — the email is the
   * record, and this is the extra. The counts come back so the caller can note what happened.
   */
  async sendToUser(userId: number, payload: PushPayload, scope?: string | null): Promise<PushResult> {
    const result: PushResult = { sent: 0, failed: 0, removed: 0 };
    if (!this.configured()) return result;

    const subs = await this.prisma.push_subscriptions.findMany({
      // A subscription with no scope predates the choice and gets everything, matching how
      // unclassified calendar events behave.
      where: { user_id: userId, ...(scope ? { OR: [{ scope }, { scope: null }] } : {}) },
    });
    if (!subs.length) return result;

    webpush.setVapidDetails(
      (process.env.VAPID_SUBJECT ?? 'mailto:noreply@example.com').trim(),
      (process.env.VAPID_PUBLIC_KEY ?? '').trim(),
      (process.env.VAPID_PRIVATE_KEY ?? '').trim(),
    );

    const body = JSON.stringify(payload);
    for (const s of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          body,
          // A reminder is worth nothing after the appointment; a push service holding it for a day
          // would deliver "in 1 hour" tomorrow morning. Six hours is generous for a phone that is
          // briefly off and short enough that nothing stale arrives.
          { TTL: 6 * 60 * 60 },
        );
        result.sent += 1;
        await this.prisma.push_subscriptions.update({
          where: { id: s.id }, data: { failures: 0, last_used_at: new Date(), updated_at: new Date() },
        });
      } catch (ex) {
        const status = (ex as { statusCode?: number }).statusCode;
        // 404/410 mean the push service has permanently forgotten this browser. Keeping the row
        // would mean a failure logged every hour for a device that no longer exists.
        if (status === 404 || status === 410) {
          await this.prisma.push_subscriptions.delete({ where: { id: s.id } }).catch(() => {});
          result.removed += 1;
        } else {
          const failures = s.failures + 1;
          if (failures >= MAX_FAILURES) {
            await this.prisma.push_subscriptions.delete({ where: { id: s.id } }).catch(() => {});
            result.removed += 1;
            this.log.warn(`Push subscription ${s.id} removed after ${failures} consecutive failures.`);
          } else {
            await this.prisma.push_subscriptions.update({
              where: { id: s.id }, data: { failures, updated_at: new Date() },
            }).catch(() => {});
          }
          result.failed += 1;
        }
      }
    }
    return result;
  }
}
