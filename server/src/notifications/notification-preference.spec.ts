import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { NotificationPreferenceService, NOTIFICATION_CATEGORIES, NOTIFICATION_CHANNELS } from './notification-preference.service';

/**
 * Notification preferences.
 *
 * The rule that matters most here is the default. A missing row means ENABLED — nobody's
 * notifications may go quiet because a feature shipped, and there is no backfill to go stale.
 * Several of these assertions exist to stop that being "tidied" into a default-off later.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };
const svc = (tx: PrismaService) => new NotificationPreferenceService(tx);

async function makeUser(tx: PrismaService): Promise<number> {
  const now = new Date();
  const t = tag();
  const u = await tx.users.create({
    data: { name: `Notif User ${t}`, email: `notif-${t}@example.test`, role: 'agent', status: 'Active', password: 'x', created_at: now, updated_at: now },
  });
  return u.id;
}

describe('notification preferences', () => {
  it('defaults to enabled when nothing has been chosen', async () => {
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      for (const c of NOTIFICATION_CATEGORIES) {
        for (const channel of NOTIFICATION_CHANNELS) {
          // Unsupported pairs are never "on" — nothing sends them, so offering them would lie.
          const expected = c.channels[channel] !== 'unsupported';
          expect(await svc(tx).isEnabled(userId, c.key, channel)).toBe(expected);
        }
      }
    });
  });

  it('lists every category as enabled for a user who has never set one', async () => {
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      const { categories, channels } = await svc(tx).list(userId);
      expect(categories).toHaveLength(NOTIFICATION_CATEGORIES.length);
      expect(channels).toEqual(NOTIFICATION_CHANNELS);
      expect(categories.every((c) => NOTIFICATION_CHANNELS.every(
        (ch) => c.enabled[ch] === (c.channels[ch] !== 'unsupported'),
      ))).toBe(true);
    });
  });

  it('stores an opt-out and reports it', async () => {
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      await svc(tx).set(userId, 'calendar_reminders', 'push', false);

      expect(await svc(tx).isEnabled(userId, 'calendar_reminders', 'push')).toBe(false);
      /*
       * THE POINT OF THE CHANNEL DIMENSION. Muting push must leave email and in-app alone — the old
       * model could not express this at all, and turning a toggle off silenced the push only while
       * the screen had to explain that in prose.
       */
      expect(await svc(tx).isEnabled(userId, 'calendar_reminders', 'email')).toBe(true);
      expect(await svc(tx).isEnabled(userId, 'calendar_reminders', 'in_app')).toBe(true);
      // Muting one category must not touch any other.
      expect(await svc(tx).isEnabled(userId, 'listing_expiry', 'push')).toBe(true);
    });
  });

  it('turns a category back on', async () => {
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      await svc(tx).set(userId, 'calendar_reminders', 'push', false);
      await svc(tx).set(userId, 'calendar_reminders', 'push', true);
      expect(await svc(tx).isEnabled(userId, 'calendar_reminders', 'push')).toBe(true);
    });
  });

  it('keeps one person’s choices out of another’s', async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx);
      const b = await makeUser(tx);
      await svc(tx).set(a, 'calendar_reminders', 'push', false);

      expect(await svc(tx).isEnabled(a, 'calendar_reminders', 'push')).toBe(false);
      expect(await svc(tx).isEnabled(b, 'calendar_reminders', 'push')).toBe(true);
    });
  });

  it('saves the whole screen in one call', async () => {
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      const { categories } = await svc(tx).setMany(userId, {
        calendar_reminders: { push: false, email: true },
        listing_expiry: { in_app: true, email: false },
      });

      const byKey = new Map(categories.map((c) => [c.key, c.enabled]));
      expect(byKey.get('calendar_reminders')).toMatchObject({ push: false, email: true });
      expect(byKey.get('listing_expiry')).toMatchObject({ in_app: true, email: false });
      // Untouched pairs stay on rather than being written as false.
      expect(byKey.get('listing_expiry')?.push).toBe(true);
      expect(byKey.get('lawyer_details')).toMatchObject({ in_app: true, email: true, push: true });
    });
  });

  it('rejects an unknown category rather than silently storing it', async () => {
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      // A typo that saved nothing but reported success would be the worst outcome: the user
      // believes they are muted and keeps being notified.
      await expect(svc(tx).set(userId, 'not_a_real_category', 'push', false)).rejects.toThrow();
      // Same for a channel that does not exist, and for a pair nothing can deliver.
      await expect(svc(tx).set(userId, 'calendar_reminders', 'carrier_pigeon', false)).rejects.toThrow();
      await expect(svc(tx).set(userId, 'inbox_new_mail', 'email', false)).rejects.toThrow();
    });
  });

  it('fails open — an unknown key is treated as enabled, never as muted', async () => {
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      // Reading is deliberately more forgiving than writing: a missed closing reminder costs far
      // more than one that should have been muted.
      expect(await svc(tx).isEnabled(userId, 'category_removed_in_a_later_release')).toBe(true);
      expect(await svc(tx).isEnabled(userId, 'calendar_reminders', 'not_a_channel' as never)).toBe(true);
    });
  });

  it('exposes which categories actually have a push sender', async () => {
    // Guards the honesty of the screen: if a sender is wired up, its readiness must move to
    // 'live' here, and if one is removed this fails rather than leaving a toggle that lies.
    /*
     * `web-push.service.ts` is the only push sender in the codebase, and calendar reminders are the
     * only thing that calls it. If a push sender is wired up its readiness must move to 'live' here,
     * and if one is removed this fails rather than leaving a toggle that lies.
     */
    const livePush = NOTIFICATION_CATEGORIES.filter((c) => c.channels.push === 'live').map((c) => c.key);
    /*
     * Every category that CAN be pushed now is. `calendar_reminders` calls `WebPushService`
     * directly and always has; the rest go through `NotificationDispatcher` from their own event
     * sites, which is what wiring a sender means in practice — the site asks for a channel and the
     * dispatcher decides whether it goes.
     *
     * `chat_mentions` is the one absentee, and deliberately: there is no mention detection yet, so
     * there is no event to push. It is a feature to build, not a call to add.
     */
    expect(livePush).toEqual([
      'calendar_reminders', 'listing_expiry', 'lawyer_details',
      'document_review', 'transaction_approvals', 'inbox_new_mail',
      // The six CRM lead and campaign events, all dispatched from their own event sites.
      'lead_new', 'lead_assigned', 'lead_meta', 'lead_task_due',
      'campaign_completed', 'campaign_failed',
      'chat_mentions',
    ]);

    /*
     * NOTHING PENDING. Every category has a sender on every channel it supports.
     *
     * Asserted as empty rather than deleted, so this stays the gate it has been all along: adding a
     * category, or a channel to one, fails here until something actually sends it. A toggle with
     * nothing behind it is worse than no toggle — somebody switches it off, keeps being notified,
     * and concludes the setting is broken.
     */
    const pending = NOTIFICATION_CATEGORIES.flatMap((c) =>
      NOTIFICATION_CHANNELS.filter((ch) => c.channels[ch] === 'pending').map((ch) => `${c.key}:${ch}`));
    expect(pending).toEqual([]);

    /*
     * The one deliberate gap, pinned so it cannot be "fixed" by accident: emailing somebody to tell
     * them they have an email is a loop nobody wants.
     */
    const unsupported = NOTIFICATION_CATEGORIES.flatMap((c) =>
      NOTIFICATION_CHANNELS.filter((ch) => c.channels[ch] === 'unsupported').map((ch) => `${c.key}:${ch}`));
    expect(unsupported).toEqual(['inbox_new_mail:email']);
  });
});
