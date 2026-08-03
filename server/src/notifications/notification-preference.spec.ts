import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { NotificationPreferenceService, NOTIFICATION_CATEGORIES } from './notification-preference.service';

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
    data: { name: `Notif User ${t}`, email: `notif-${t}@example.test`, role: 'agent', status: 'Active', password: 'x', company_id: 1, created_at: now, updated_at: now },
  });
  return u.id;
}

describe('notification preferences', () => {
  it('defaults to enabled when nothing has been chosen', async () => {
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      for (const c of NOTIFICATION_CATEGORIES) {
        expect(await svc(tx).isEnabled(userId, c.key)).toBe(true);
      }
    });
  });

  it('lists every category as enabled for a user who has never set one', async () => {
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      const { categories } = await svc(tx).list(userId);
      expect(categories).toHaveLength(NOTIFICATION_CATEGORIES.length);
      expect(categories.every((c) => c.enabled)).toBe(true);
    });
  });

  it('stores an opt-out and reports it', async () => {
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      await svc(tx).set(userId, 'calendar_reminders', false);

      expect(await svc(tx).isEnabled(userId, 'calendar_reminders')).toBe(false);
      // Muting one category must not touch any other.
      expect(await svc(tx).isEnabled(userId, 'listing_expiry')).toBe(true);
    });
  });

  it('turns a category back on', async () => {
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      await svc(tx).set(userId, 'calendar_reminders', false);
      await svc(tx).set(userId, 'calendar_reminders', true);
      expect(await svc(tx).isEnabled(userId, 'calendar_reminders')).toBe(true);
    });
  });

  it('keeps one person’s choices out of another’s', async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx);
      const b = await makeUser(tx);
      await svc(tx).set(a, 'calendar_reminders', false);

      expect(await svc(tx).isEnabled(a, 'calendar_reminders')).toBe(false);
      expect(await svc(tx).isEnabled(b, 'calendar_reminders')).toBe(true);
    });
  });

  it('saves the whole screen in one call', async () => {
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      const { categories } = await svc(tx).setMany(userId, {
        calendar_reminders: false,
        inbox_new_mail: false,
        listing_expiry: true,
      });

      const byKey = new Map(categories.map((c) => [c.key, c.enabled]));
      expect(byKey.get('calendar_reminders')).toBe(false);
      expect(byKey.get('inbox_new_mail')).toBe(false);
      expect(byKey.get('listing_expiry')).toBe(true);
      // Untouched categories stay on rather than being written as false.
      expect(byKey.get('lawyer_details')).toBe(true);
    });
  });

  it('rejects an unknown category rather than silently storing it', async () => {
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      // A typo that saved nothing but reported success would be the worst outcome: the user
      // believes they are muted and keeps being notified.
      await expect(svc(tx).set(userId, 'not_a_real_category', false)).rejects.toThrow();
    });
  });

  it('fails open — an unknown key is treated as enabled, never as muted', async () => {
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      // Reading is deliberately more forgiving than writing: a missed closing reminder costs far
      // more than one that should have been muted.
      expect(await svc(tx).isEnabled(userId, 'category_removed_in_a_later_release')).toBe(true);
    });
  });

  it('exposes which categories actually have a push sender', async () => {
    // Guards the honesty of the screen: if a sender is wired up, its readiness must move to
    // 'live' here, and if one is removed this fails rather than leaving a toggle that lies.
    const live = NOTIFICATION_CATEGORIES.filter((c) => c.readiness === 'live').map((c) => c.key);
    expect(live).toEqual(['calendar_reminders']);
  });
});
