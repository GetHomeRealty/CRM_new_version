import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { NotificationPreferenceService } from './notification-preference.service';

/**
 * The dispatcher: one place that decides what is actually sent.
 *
 * WHAT THESE TESTS ARE FOR. The value of a dispatcher is not that it can send — three senders
 * already existed — it is that the DECISION is made once, correctly, for every module. So what is
 * asserted here is the decision: whose preference is read, which channels are attempted, which are
 * skipped and why, and that a failure on one channel never becomes a failure of the caller's real
 * work.
 *
 * Real rows, rolled back. The two outbound senders are stubbed, because what matters is whether
 * they were CALLED — actually sending mail from a test run is exactly what `MAIL_REDIRECT_TO`
 * exists to prevent.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
const tag = (): string => `${Date.now()}-${(seq += 1)}`;

afterAll(async () => { await prisma.$disconnect(); });

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

interface Sent { to: string; subject: string }

/** A dispatcher whose outbound channels are observable. */
function build(tx: PrismaService, opts: { mailer?: boolean; push?: boolean; pushSends?: number } = {}) {
  const emails: Sent[] = [];
  const pushes: Array<{ userId: number; title: string }> = [];

  const mailer = opts.mailer === false ? null : {
    sendDirect: async (to: string, subject: string) => { emails.push({ to, subject }); },
  };
  const push = opts.push === false ? null : {
    configured: () => true,
    sendToUser: async (userId: number, payload: { title: string }) => {
      pushes.push({ userId, title: payload.title });
      return { sent: opts.pushSends ?? 1, failed: 0, removed: 0 };
    },
  };

  const moduleRef = {
    get: (type: { name: string }) => {
      if (type.name === 'MailerService') { if (!mailer) throw new Error('absent'); return mailer; }
      if (type.name === 'WebPushService') { if (!push) throw new Error('absent'); return push; }
      throw new Error('unknown provider');
    },
  };

  const dispatcher = new NotificationDispatcher(
    tx,
    new NotificationPreferenceService(tx),
    moduleRef as never,
  );
  return { dispatcher, emails, pushes };
}

async function makeUser(tx: PrismaService, over: Record<string, unknown> = {}): Promise<number> {
  const now = new Date();
  const t = tag();
  const row = await tx.users.create({
    data: {
      name: `ZZ Disp ${t}`, email: `zz-disp-${t}@probe.test`, username: `zzdisp${t.replace(/-/g, '')}`,
      role: 'agent', status: 'Active', password: 'x', created_at: now, updated_at: now, company_id: 1,
      ...over,
    },
    select: { id: true },
  });
  return row.id;
}

const REQUEST = {
  category: 'listing_expiry',
  title: 'A listing expires in 7 days',
  body: '12 Probe Street',
  link: '/desk/transactions/1',
};

// ============================================================================ the happy path
describe('delivering to every enabled channel', () => {
  it('sends in-app, email and push when nothing is muted', async () => {
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      const { dispatcher, emails, pushes } = build(tx);

      const result = await dispatcher.dispatch({ ...REQUEST, userId });

      expect(result.delivered.sort()).toEqual(['email', 'in_app', 'push']);
      expect(result.failed).toEqual([]);
      expect(emails).toHaveLength(1);
      expect(pushes).toHaveLength(1);

      const stored = await tx.notifications.findMany({ where: { user_id: userId } });
      expect(stored).toHaveLength(1);
      expect(stored[0].title).toBe(REQUEST.title);
      expect(stored[0].link).toBe(REQUEST.link);
      expect(stored[0].read_at).toBeNull();
    });
  });

  it('stamps the notification with the recipient\'s own brokerage', async () => {
    // The dispatcher runs from background sweeps with no tenant in context; the row must still land
    // in the right brokerage rather than wherever the caller happened to be.
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      const { dispatcher } = build(tx);
      await dispatcher.dispatch({ ...REQUEST, userId });

      const stored = await tx.notifications.findFirst({ where: { user_id: userId } });
      expect(stored?.company_id).toBe(1);
    });
  });
});

// ============================================================================ preferences
describe('honouring the preference', () => {
  it('skips a channel the person muted, and still uses the others', async () => {
    /*
     * THE WHOLE POINT OF THE DISPATCHER. One decision, applied to every channel — rather than each
     * module remembering to check, which is the gate that eventually gets forgotten.
     */
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      const prefs = new NotificationPreferenceService(tx);
      await prefs.set(userId, 'listing_expiry', 'email', false);

      const { dispatcher, emails } = build(tx);
      const result = await dispatcher.dispatch({ ...REQUEST, userId });

      expect(emails).toHaveLength(0);
      expect(result.skipped).toContainEqual({ channel: 'email', reason: 'muted' });
      expect(result.delivered.sort()).toEqual(['in_app', 'push']);
    });
  });

  it('sends nothing at all when every channel is muted', async () => {
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      const prefs = new NotificationPreferenceService(tx);
      for (const channel of ['in_app', 'email', 'push'] as const) {
        await prefs.set(userId, 'listing_expiry', channel, false);
      }

      const { dispatcher, emails, pushes } = build(tx);
      const result = await dispatcher.dispatch({ ...REQUEST, userId });

      expect(result.delivered).toEqual([]);
      expect(emails).toHaveLength(0);
      expect(pushes).toHaveLength(0);
      expect(await tx.notifications.count({ where: { user_id: userId } })).toBe(0);
    });
  });

  it('reads ONE person\'s preference, not another\'s', async () => {
    await inRollback(async (tx) => {
      const muted = await makeUser(tx);
      const other = await makeUser(tx);
      await new NotificationPreferenceService(tx).set(muted, 'listing_expiry', 'email', false);

      const { dispatcher, emails } = build(tx);
      await dispatcher.dispatch({ ...REQUEST, userId: other });

      expect(emails).toHaveLength(1);
    });
  });

  it('distinguishes "muted" from "this category has no such channel"', async () => {
    /*
     * Reported separately because they mean different things to whoever reads the result: one is a
     * choice somebody made, the other is a limitation of the system. Collapsing them would make a
     * missing sender look like a user preference.
     */
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      const { dispatcher, emails } = build(tx);

      // `inbox_new_mail` cannot be delivered by email — emailing to say you have email.
      const result = await dispatcher.dispatch({ ...REQUEST, category: 'inbox_new_mail', userId });

      expect(emails).toHaveLength(0);
      expect(result.skipped).toContainEqual({ channel: 'email', reason: 'unsupported' });
    });
  });

  it('defaults to sending when the person has expressed no preference', async () => {
    // Failing open: a notification somebody meant to mute is an annoyance; a swallowed closing
    // reminder is a missed closing.
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      const { dispatcher } = build(tx);
      const result = await dispatcher.dispatch({ ...REQUEST, userId });
      expect(result.delivered.length).toBe(3);
    });
  });
});

// ============================================================================ channel restriction
describe('asking for specific channels', () => {
  it('attempts ONLY the channels named', async () => {
    /*
     * WHAT THIS PROTECTS. Several event sites already send their own email and push, with their own
     * delivery rows and retry handling — the calendar reminder sweep and the listing/lawyer sweep
     * both do. They call the dispatcher for the channel they do NOT already cover. Without this
     * restriction each of those notifications would go out TWICE, and the duplicate would look like
     * a bug in the sweep rather than in the wiring.
     */
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      const { dispatcher, emails, pushes } = build(tx);

      const result = await dispatcher.dispatch({ ...REQUEST, userId, channels: ['in_app'] });

      expect(result.delivered).toEqual(['in_app']);
      expect(emails).toHaveLength(0);
      expect(pushes).toHaveLength(0);
      expect(await tx.notifications.count({ where: { user_id: userId } })).toBe(1);
    });
  });

  it('asks for push alone without writing an in-app row', async () => {
    // The sweep's case: the in-app row is its own `transaction_reminders` claim, not ours.
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      const { dispatcher, emails, pushes } = build(tx);

      const result = await dispatcher.dispatch({ ...REQUEST, userId, channels: ['push'] });

      expect(result.delivered).toEqual(['push']);
      expect(pushes).toHaveLength(1);
      expect(emails).toHaveLength(0);
      expect(await tx.notifications.count({ where: { user_id: userId } })).toBe(0);
    });
  });

  it('still obeys a mute — naming a channel asks, it does not force', async () => {
    /*
     * The important limit on this option. A call site saying "send push" must not override somebody
     * who turned push off; the preference is the person's decision and no caller outranks it.
     */
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      await new NotificationPreferenceService(tx).set(userId, 'listing_expiry', 'push', false);

      const { dispatcher, pushes } = build(tx);
      const result = await dispatcher.dispatch({ ...REQUEST, userId, channels: ['push'] });

      expect(pushes).toHaveLength(0);
      expect(result.delivered).toEqual([]);
      expect(result.skipped).toContainEqual({ channel: 'push', reason: 'muted' });
    });
  });

  it('an empty or absent list means every channel', async () => {
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      const { dispatcher } = build(tx);

      expect((await dispatcher.dispatch({ ...REQUEST, userId, channels: [] })).delivered).toHaveLength(3);
      expect((await dispatcher.dispatch({ ...REQUEST, userId })).delivered).toHaveLength(3);
    });
  });
});

// ============================================================================ recipients
describe('who gets told', () => {
  it('does not notify a deactivated account', async () => {
    // The same rule `AuthService.loadUser` applies: somebody deactivated stops getting mail about
    // deals they can no longer open.
    await inRollback(async (tx) => {
      const userId = await makeUser(tx, { status: 'Inactive' });
      const { dispatcher, emails } = build(tx);

      const result = await dispatcher.dispatch({ ...REQUEST, userId });

      expect(result.delivered).toEqual([]);
      expect(emails).toHaveLength(0);
      expect(await tx.notifications.count({ where: { user_id: userId } })).toBe(0);
    });
  });

  it('does not fall over on a user who does not exist', async () => {
    await inRollback(async (tx) => {
      const { dispatcher } = build(tx);
      await expect(dispatcher.dispatch({ ...REQUEST, userId: -1 })).resolves.toMatchObject({ delivered: [] });
      await expect(dispatcher.dispatch({ ...REQUEST, userId: 999_999_999 })).resolves.toMatchObject({ delivered: [] });
    });
  });

  it('skips email for somebody with no address rather than failing', async () => {
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      await tx.users.update({ where: { id: userId }, data: { email: '' } });

      const { dispatcher, emails } = build(tx);
      const result = await dispatcher.dispatch({ ...REQUEST, userId });

      expect(emails).toHaveLength(0);
      expect(result.skipped).toContainEqual({ channel: 'email', reason: 'no_address' });
      // The other channels still went.
      expect(result.delivered).toContain('in_app');
    });
  });

  it('notifies several people independently', async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx);
      const b = await makeUser(tx);
      const { dispatcher, emails } = build(tx);

      const results = await dispatcher.dispatchMany([a, b, a], REQUEST);

      // Deduplicated: the same person named twice is told once.
      expect(results).toHaveLength(2);
      expect(emails).toHaveLength(2);
    });
  });
});

// ============================================================================ failure handling
describe('when a channel fails', () => {
  it('reports it without failing the others, and never throws at the caller', async () => {
    /*
     * A notification is a side effect of somebody's real work. A closing must not fail because a
     * mail server was briefly unreachable.
     */
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      const { dispatcher } = build(tx);
      // Replace the mailer with one that throws.
      (dispatcher as unknown as { moduleRef: { get: (t: { name: string }) => unknown } }).moduleRef = {
        get: (type: { name: string }) => {
          if (type.name === 'MailerService') return { sendDirect: async () => { throw new Error('smtp refused'); } };
          if (type.name === 'WebPushService') return { configured: () => true, sendToUser: async () => ({ sent: 1, failed: 0, removed: 0 }) };
          throw new Error('unknown');
        },
      };

      const result = await dispatcher.dispatch({ ...REQUEST, userId });

      expect(result.failed).toContainEqual({ channel: 'email', error: 'smtp refused' });
      expect(result.delivered.sort()).toEqual(['in_app', 'push']);
    });
  });

  it('skips a channel whose sender is not installed', async () => {
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      const { dispatcher } = build(tx, { mailer: false, push: false });

      const result = await dispatcher.dispatch({ ...REQUEST, userId });

      expect(result.delivered).toEqual(['in_app']);
      expect(result.skipped).toContainEqual({ channel: 'email', reason: 'not_configured' });
      expect(result.skipped).toContainEqual({ channel: 'push', reason: 'not_configured' });
    });
  });

  it('reports push as skipped when nobody has a subscribed browser', async () => {
    // `sendToUser` never throws and answers `sent: 0`; that is not a failure, it is nobody to reach.
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      const { dispatcher } = build(tx, { pushSends: 0 });

      const result = await dispatcher.dispatch({ ...REQUEST, userId });

      expect(result.delivered).not.toContain('push');
      expect(result.failed).toEqual([]);
    });
  });
});

// ============================================================================ idempotency
describe('not telling somebody the same thing twice', () => {
  it('drops a duplicate in-app notification with the same key', async () => {
    /*
     * What makes a retried job safe. A sweep re-running after a partial failure re-dispatches
     * everything, and without this the person finds two copies of every notification.
     */
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      const { dispatcher } = build(tx);

      const first = await dispatcher.dispatch({ ...REQUEST, userId, dedupeKey: 'listing-41-day-7' });
      const second = await dispatcher.dispatch({ ...REQUEST, userId, dedupeKey: 'listing-41-day-7' });

      expect(first.delivered).toContain('in_app');
      expect(second.delivered).not.toContain('in_app');
      expect(second.skipped).toContainEqual({ channel: 'in_app', reason: 'duplicate' });
      expect(await tx.notifications.count({ where: { user_id: userId } })).toBe(1);
    });
  });

  it('a duplicate does not poison the caller\'s transaction', async () => {
    /*
     * THE BUG THIS FILE CAUGHT. In PostgreSQL a unique violation ABORTS THE ENCLOSING TRANSACTION —
     * every later statement fails with 25P02, "current transaction is aborted". The first version of
     * `sendInApp` used `create` inside a try/catch, which handled the error but not the abort, so a
     * module that created a record and notified in one transaction would have had its REAL WORK
     * rolled back by a harmless duplicate notification.
     *
     * This is that scenario: work, a duplicate dispatch, then more work in the same transaction.
     */
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      const { dispatcher } = build(tx);

      await dispatcher.dispatch({ ...REQUEST, userId, dedupeKey: 'same-key' });
      await dispatcher.dispatch({ ...REQUEST, userId, dedupeKey: 'same-key' });

      // The transaction must still be usable — a read AND a write after the collision.
      await expect(tx.notifications.count({ where: { user_id: userId } })).resolves.toBe(1);
      const later = await makeUser(tx);
      expect(later).toBeGreaterThan(0);
    });
  });

  it('two people may hold the same key', async () => {
    // The key is per-person: one event notifying a whole team is not a duplicate.
    await inRollback(async (tx) => {
      const a = await makeUser(tx);
      const b = await makeUser(tx);
      const { dispatcher } = build(tx);

      await dispatcher.dispatch({ ...REQUEST, userId: a, dedupeKey: 'listing-41-day-7' });
      await dispatcher.dispatch({ ...REQUEST, userId: b, dedupeKey: 'listing-41-day-7' });

      expect(await tx.notifications.count({ where: { user_id: { in: [a, b] } } })).toBe(2);
    });
  });

  it('without a key, nothing is deduplicated', async () => {
    // Two genuinely separate events with the same wording are still two notifications.
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      const { dispatcher } = build(tx);

      await dispatcher.dispatch({ ...REQUEST, userId });
      await dispatcher.dispatch({ ...REQUEST, userId });

      expect(await tx.notifications.count({ where: { user_id: userId } })).toBe(2);
    });
  });
});

// ============================================================================ content
describe('what the message says', () => {
  it('uses the caller\'s own subject and body when given', async () => {
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      const { dispatcher, emails } = build(tx);

      await dispatcher.dispatch({
        ...REQUEST, userId,
        email: { subject: 'Your listing at 12 Probe Street expires soon', html: '<p>Custom</p>' },
      });

      expect(emails[0].subject).toBe('Your listing at 12 Probe Street expires soon');
    });
  });

  it('escapes the title, so a record cannot inject markup into an email', async () => {
    /*
     * Titles come from records people typed into — a property address, a document name. They are
     * data, not HTML, and the default body must treat them that way.
     */
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      const captured: string[] = [];
      const dispatcher = new NotificationDispatcher(
        tx,
        new NotificationPreferenceService(tx),
        {
          get: (type: { name: string }) => {
            if (type.name === 'MailerService') {
              return { sendDirect: async (_to: string, _s: string, html: string) => { captured.push(html); } };
            }
            throw new Error('absent');
          },
        } as never,
      );

      await dispatcher.dispatch({
        ...REQUEST, userId,
        title: '<script>alert(1)</script> 12 Probe Street',
      });

      expect(captured[0]).not.toContain('<script>');
      expect(captured[0]).toContain('&lt;script&gt;');
    });
  });
});
