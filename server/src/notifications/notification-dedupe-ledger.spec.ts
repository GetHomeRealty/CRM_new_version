import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../email/mailer.service';
import { WebPushService } from '../calendar/web-push.service';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { NotificationPreferenceService, type NotificationChannel } from './notification-preference.service';

/**
 * EVERY CHANNEL IS DEDUPED, AND NO CHANNEL'S PREFERENCE DECIDES WHETHER DEDUPE HAPPENS.
 *
 * ================================================================================================
 * THE TWO DEFECTS THIS FILE EXISTS FOR. Idempotency used to be a side effect of the unique index on
 * `notifications(user_id, dedupe_key)` — so the IN-APP row was the record of "already sent".
 *
 *   MUTING IN-APP DISABLED DEDUPLICATION. A muted channel writes no in-app row, so nothing recorded
 *   that the notification had happened. Somebody who turned off in-app and kept email therefore
 *   received it again on every single pass — punished for switching off the channel that happened
 *   to be doing the bookkeeping. At the follow-up sweep's cadence that is forty-eight emails a day.
 *
 *   EMAIL AND PUSH WERE NOT DEDUPED AT ALL. Only `sendInApp` ever consulted the key. Any sweep that
 *   legitimately re-selects a row — a follow-up still overdue because nobody has done it — re-sent
 *   on both of those every time it ran, for as long as the row stayed selectable.
 *
 * `notification_deliveries` records one row per (recipient, category, occurrence, channel), claimed
 * BEFORE the send and written for every channel INCLUDING muted ones. These tests are written so
 * that reverting to the in-app row fails them.
 * ================================================================================================
 *
 * THE SENDERS ARE STUBS, THE LEDGER IS REAL. What is being tested is which sends are ATTEMPTED, so
 * the mailer and push service only need to count calls — but the claim is a database uniqueness
 * race, and stubbing that would test nothing at all.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx as unknown as PrismaService);
      throw new Error(ROLLBACK);
    }, { timeout: 120_000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };

/** Counts what each channel was asked to send. */
function senders() {
  const emails: string[] = [];
  const pushes: number[] = [];
  const mailer = { sendDirect: async (to: string) => { emails.push(to); return true; } };
  const push = {
    configured: () => true,
    sendToUser: async (userId: number) => { pushes.push(userId); return { sent: 1 }; },
  };
  const moduleRef = {
    get: (type: unknown) => {
      if (type === MailerService) return mailer;
      if (type === WebPushService) return push;
      throw new Error('not provided');
    },
  };
  return { emails, pushes, moduleRef };
}

function dispatcher(tx: PrismaService, moduleRef: unknown) {
  return new NotificationDispatcher(tx, new NotificationPreferenceService(tx), moduleRef as never);
}

async function makeUser(tx: PrismaService): Promise<number> {
  const now = new Date();
  const u = await tx.users.create({
    data: {
      name: `Ledger user ${tag()}`, email: `ledger-${tag()}@example.test`,
      role: 'agent', status: 'Active', password: 'x', created_at: now, updated_at: now,
    },
  });
  return u.id;
}

/** Turn a channel off for a category, the way the Settings screen does. */
async function mute(tx: PrismaService, userId: number, category: string, channels: NotificationChannel[]) {
  for (const channel of channels) {
    await tx.notification_preferences.create({
      data: { user_id: userId, category, channel, enabled: false, created_at: new Date(), updated_at: new Date() },
    });
  }
}

const CATEGORY = 'lead_task_due';

/** One notification about one occurrence. Called repeatedly to stand in for repeated sweep passes. */
const request = (userId: number, key = 'lead-task-due:99:2026-08-15') => ({
  category: CATEGORY,
  userId,
  title: 'Follow-up due',
  body: 'A follow-up is due.',
  dedupeKey: key,
});

const ledgerRows = (tx: PrismaService, userId: number) =>
  tx.notification_deliveries.findMany({
    where: { user_id: userId },
    select: { channel: true, status: true, dedupe_key: true, category: true },
    orderBy: { channel: 'asc' },
  });

describe('a muted in-app channel no longer disables deduplication', () => {
  /**
   * THE HEADLINE CASE. In-app off, email on — the configuration that was being re-sent for ever.
   */
  it('emails a recipient who muted in-app exactly once, across repeated passes', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      await mute(tx, user, CATEGORY, ['in_app']);
      const { emails, moduleRef } = senders();
      const d = dispatcher(tx, moduleRef);

      // Six passes stands in for three hours of the follow-up sweep.
      for (let i = 0; i < 6; i += 1) await d.dispatch(request(user));

      expect(emails).toHaveLength(1);
      // And nothing was written to `notifications`, which is exactly why the old rule failed here.
      expect(await tx.notifications.count({ where: { user_id: user } })).toBe(0);
      // The ledger holds the record instead — including for the channel that was muted.
      expect(await ledgerRows(tx, user)).toEqual([
        { channel: 'email', status: 'sent', dedupe_key: 'lead-task-due:99:2026-08-15', category: CATEGORY },
        { channel: 'in_app', status: 'muted', dedupe_key: 'lead-task-due:99:2026-08-15', category: CATEGORY },
        { channel: 'push', status: 'sent', dedupe_key: 'lead-task-due:99:2026-08-15', category: CATEGORY },
      ]);
    });
  });

  /**
   * The inverse, and the one that would starve a scheduler rather than spam a person: with every
   * channel muted there is nothing to deliver, but the occurrence must still be recorded as handled
   * or a sweep reading the ledger will select it again for ever.
   */
  it('records the occurrence even when every channel is muted', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      await mute(tx, user, CATEGORY, ['in_app', 'email', 'push']);
      const { emails, pushes, moduleRef } = senders();

      const result = await dispatcher(tx, moduleRef).dispatch(request(user));

      expect(result.delivered).toEqual([]);
      expect(emails).toHaveLength(0);
      expect(pushes).toHaveLength(0);
      // Three rows, all `muted` — the trace a scheduler needs.
      const rows = await ledgerRows(tx, user);
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.status === 'muted')).toBe(true);
    });
  });
});

describe('email and push are deduped independently and durably', () => {
  it('sends each channel exactly once however many times the same occurrence is dispatched', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { emails, pushes, moduleRef } = senders();
      const d = dispatcher(tx, moduleRef);

      for (let i = 0; i < 5; i += 1) await d.dispatch(request(user));

      expect(emails).toHaveLength(1);
      expect(pushes).toHaveLength(1);
      expect(await tx.notifications.count({ where: { user_id: user } })).toBe(1);
    });
  });

  it('reports the repeats as duplicates rather than as deliveries', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { moduleRef } = senders();
      const d = dispatcher(tx, moduleRef);

      const first = await d.dispatch(request(user));
      const second = await d.dispatch(request(user));

      expect(first.delivered.sort()).toEqual(['email', 'in_app', 'push']);
      expect(second.delivered).toEqual([]);
      expect(second.skipped.map((s) => s.reason)).toEqual(['duplicate', 'duplicate', 'duplicate']);
    });
  });

  /**
   * The behaviour that must SURVIVE. A key identifies an OCCURRENCE, so the same task falling due on
   * a later date is a different notification and must arrive.
   */
  it('sends again for a different occurrence of the same entity', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { emails, moduleRef } = senders();
      const d = dispatcher(tx, moduleRef);

      await d.dispatch(request(user, 'lead-task-due:99:2026-08-15'));
      await d.dispatch(request(user, 'lead-task-due:99:2026-08-22'));

      expect(emails).toHaveLength(2);
    });
  });

  it('does not let one recipient suppress another', async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx);
      const b = await makeUser(tx);
      const { emails, moduleRef } = senders();
      const d = dispatcher(tx, moduleRef);

      await d.dispatch(request(a));
      await d.dispatch(request(b));

      expect(emails).toHaveLength(2);
    });
  });

  /**
   * `notifications` is unique on (user_id, dedupe_key) with no category, so two categories sharing
   * one occurrence string collided there. The ledger includes the category in its identity.
   */
  it('does not let two categories collide on one occurrence string', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { emails, moduleRef } = senders();
      const d = dispatcher(tx, moduleRef);

      await d.dispatch({ ...request(user), category: 'lead_task_due' });
      await d.dispatch({ ...request(user), category: 'lead_assigned' });

      expect(emails).toHaveLength(2);
      expect(new Set((await ledgerRows(tx, user)).map((r) => r.category)))
        .toEqual(new Set(['lead_task_due', 'lead_assigned']));
    });
  });
});

describe('the rules that must not change', () => {
  /**
   * No key means no deduplication and no ledger row — which is right for something that genuinely
   * happens once. Every existing caller that passes no key must behave exactly as it did.
   */
  it('does not dedupe, or record anything, when the caller passes no key', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { emails, moduleRef } = senders();
      const d = dispatcher(tx, moduleRef);

      const req = { category: 'campaign_completed', userId: user, title: 'Campaign finished' };
      await d.dispatch(req);
      await d.dispatch(req);

      expect(emails).toHaveLength(2);
      expect(await ledgerRows(tx, user)).toEqual([]);
    });
  });

  /**
   * A FAILED SEND KEEPS ITS CLAIM. Deliberate, and the same choice the CRM greeting sweeps make: a
   * notification that arrives twice is the outcome people report as a fault, and a missing one is
   * visible in the ledger with its reason. Releasing the claim would turn one transient SMTP error
   * into a repeat send on every later pass.
   */
  it('does not retry a channel whose send threw, and records why', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { moduleRef } = senders();
      // Replace the mailer with one that always throws.
      const failing = {
        get: (type: unknown) => {
          if (type === MailerService) {
            return { sendDirect: async () => { throw new Error('smtp: connection refused'); } };
          }
          return (moduleRef.get as (t: unknown) => unknown)(type);
        },
      };
      const d = dispatcher(tx, failing);

      const first = await d.dispatch(request(user));
      expect(first.failed.map((f) => f.channel)).toEqual(['email']);

      const second = await d.dispatch(request(user));
      expect(second.failed).toEqual([]);
      expect(second.skipped.map((s) => s.reason)).toEqual(['duplicate', 'duplicate', 'duplicate']);

      const email = (await ledgerRows(tx, user)).find((r) => r.channel === 'email');
      expect(email!.status).toBe('failed');
    });
  });

  /**
   * The claim is a database uniqueness decision precisely so that two processes cannot both win it.
   * These run on one connection, so this is not true parallelism — but it does exercise the
   * ON CONFLICT path rather than a read-then-write, which is the part that would be wrong.
   */
  it('resolves concurrent dispatches of one occurrence to a single send', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { emails, moduleRef } = senders();
      const d = dispatcher(tx, moduleRef);

      await Promise.all([d.dispatch(request(user)), d.dispatch(request(user)), d.dispatch(request(user))]);

      expect(emails).toHaveLength(1);
      expect(await tx.notification_deliveries.count({ where: { user_id: user } })).toBe(3);
    });
  });
});

afterAll(async () => { await prisma.$disconnect(); });
