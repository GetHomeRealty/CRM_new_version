import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CrmEventNotifier } from './crm-events.service';
import { NotificationDispatcher } from './notification-dispatcher.service';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  NotificationPreferenceService,
  type NotificationChannel,
} from './notification-preference.service';

/**
 * The six CRM lead and campaign notifications.
 *
 * These run against the REAL dispatcher and a real database, because what is being tested is not
 * that a method was called — it is that the right person is told, once, on the channels they chose,
 * with a link that goes to the right record. A stubbed dispatcher would prove none of that.
 *
 * The two outbound senders are stubbed: what matters is whether they were CALLED, and actually
 * sending mail from a test run is what `MAIL_REDIRECT_TO` exists to prevent.
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

function build(tx: PrismaService) {
  const emails: string[] = [];
  const pushes: number[] = [];
  const moduleRef = {
    get: (type: { name: string }) => {
      if (type.name === 'MailerService') return { sendDirect: async (to: string) => { emails.push(to); } };
      if (type.name === 'WebPushService') {
        return { configured: () => true, sendToUser: async (id: number) => { pushes.push(id); return { sent: 1, failed: 0, removed: 0 }; } };
      }
      throw new Error('absent');
    },
  };
  const dispatcher = new NotificationDispatcher(tx, new NotificationPreferenceService(tx), moduleRef as never);
  // The real transaction, so the notifier's template resolution runs against real rows rather
  // than being stubbed out — these tests then cover the templated path as well as the dispatch.
  return { notifier: new CrmEventNotifier(dispatcher, tx), emails, pushes, prefs: new NotificationPreferenceService(tx) };
}

async function makeUser(tx: PrismaService): Promise<{ id: number; name: string }> {
  const now = new Date();
  const t = tag();
  return tx.users.create({
    data: {
      name: `ZZ Crm ${t}`, email: `zz-crm-${t}@probe.test`, username: `zzcrm${t.replace(/-/g, '')}`,
      role: 'agent', status: 'Active', password: 'x', created_at: now, updated_at: now,    },
    select: { id: true, name: true },
  });
}

const LEAD = { id: 4242, first_name: 'John', last_name: 'Smith', email: 'john@example.test' };

const stored = (tx: PrismaService, userId: number) =>
  tx.notifications.findMany({ where: { user_id: userId }, orderBy: { id: 'asc' } });

// ============================================================================ categories
describe('the six CRM categories', () => {
  it('exist, and every channel of each has a sender', () => {
    /*
     * Guards the honesty of the settings screen. A category whose cell says "on" while nothing sends
     * it is worse than no toggle: somebody switches it off, keeps being notified, and concludes the
     * setting is broken.
     */
    const keys = ['lead_new', 'lead_assigned', 'lead_meta', 'lead_task_due', 'campaign_completed', 'campaign_failed'];

    /*
     * Built into one object and compared once. jest's `expect` takes a SINGLE argument, unlike
     * Playwright's — a per-case message passed beside the value throws "Expect takes at most one
     * argument", which reads like a broken assertion rather than a misused matcher. Putting the
     * identity in the value gives the same diagnosis from the diff.
     */
    const actual: Record<string, string> = {};
    const expected: Record<string, string> = {};
    for (const key of keys) {
      const category = NOTIFICATION_CATEGORIES.find((c) => c.key === key);
      for (const channel of NOTIFICATION_CHANNELS) {
        actual[`${key}:${channel}`] = category?.channels[channel] ?? 'MISSING CATEGORY';
        expected[`${key}:${channel}`] = 'live';
      }
    }
    expect(actual).toEqual(expected);
  });
});

// ============================================================================ 1. new lead
describe('new lead', () => {
  it('notifies the recipient, with a link to the lead', async () => {
    await inRollback(async (tx) => {
      const owner = await makeUser(tx);
      const creator = await makeUser(tx);
      const { notifier } = build(tx);

      await notifier.leadCreated({ ...LEAD, source: 'website' }, owner.id, creator.id);

      const rows = await stored(tx, owner.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].category).toBe('lead_new');
      // The real route: App.tsx registers { screen: 'lead', paths: ['', ':id'] } under /crm.
      expect(rows[0].link).toBe(`/crm/lead/${LEAD.id}`);
      expect(rows[0].title).toBe('New lead');
      expect(rows[0].body).toContain('John Smith');
    });
  });

  it('does NOT notify somebody about a lead they typed in themselves', async () => {
    // They are looking at the thing they just created; a notification about it is noise.
    await inRollback(async (tx) => {
      const me = await makeUser(tx);
      const { notifier } = build(tx);

      await notifier.leadCreated(LEAD, me.id, me.id);

      expect(await stored(tx, me.id)).toHaveLength(0);
    });
  });

  it('is idempotent — a re-run does not tell anybody twice', async () => {
    await inRollback(async (tx) => {
      const owner = await makeUser(tx);
      const { notifier } = build(tx);

      await notifier.leadCreated(LEAD, owner.id, null);
      await notifier.leadCreated(LEAD, owner.id, null);

      expect(await stored(tx, owner.id)).toHaveLength(1);
    });
  });

  it('does nothing when there is no recipient', async () => {
    await inRollback(async (tx) => {
      const { notifier } = build(tx);
      await expect(notifier.leadCreated(LEAD, null, 1)).resolves.toBeUndefined();
      await expect(notifier.leadCreated(LEAD, undefined, 1)).resolves.toBeUndefined();
    });
  });
});

// ============================================================================ 2. assignment
describe('lead assigned', () => {
  it('notifies the new assignee and names who did it', async () => {
    await inRollback(async (tx) => {
      const assignee = await makeUser(tx);
      const actor = await makeUser(tx);
      const { notifier } = build(tx);

      await notifier.leadAssigned(LEAD, assignee.id, actor.id, 'Priya Raman');

      const rows = await stored(tx, assignee.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].category).toBe('lead_assigned');
      expect(rows[0].body).toContain('John Smith');
      expect(rows[0].body).toContain('Priya Raman');
      expect(rows[0].link).toBe(`/crm/lead/${LEAD.id}`);
    });
  });

  it('does not notify somebody who assigned a lead to themselves', async () => {
    await inRollback(async (tx) => {
      const me = await makeUser(tx);
      const { notifier } = build(tx);
      await notifier.leadAssigned(LEAD, me.id, me.id, me.name);
      expect(await stored(tx, me.id)).toHaveLength(0);
    });
  });

  it('does not notify the PREVIOUS assignee', async () => {
    /*
     * "This is no longer yours" is a different message that nobody asked for. Only the person
     * receiving the work is told.
     */
    await inRollback(async (tx) => {
      const previous = await makeUser(tx);
      const next = await makeUser(tx);
      const { notifier } = build(tx);

      await notifier.leadAssigned(LEAD, next.id, null, 'Someone');

      expect(await stored(tx, next.id)).toHaveLength(1);
      expect(await stored(tx, previous.id)).toHaveLength(0);
    });
  });

  it('re-announcing the same assignment does not notify twice', async () => {
    // The second line of defence. The call site checks that the assignee changed; this is what
    // catches a retry that gets past it.
    await inRollback(async (tx) => {
      const assignee = await makeUser(tx);
      const { notifier } = build(tx);

      await notifier.leadAssigned(LEAD, assignee.id, null, 'A');
      await notifier.leadAssigned(LEAD, assignee.id, null, 'A');

      expect(await stored(tx, assignee.id)).toHaveLength(1);
    });
  });
});

// ============================================================================ 3. Meta
describe('Meta lead arrived', () => {
  it('notifies the owner once', async () => {
    await inRollback(async (tx) => {
      const owner = await makeUser(tx);
      const { notifier } = build(tx);

      await notifier.metaLeadArrived(LEAD, owner.id, 'fb-lead-777', 'Spring Buyers');

      const rows = await stored(tx, owner.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].category).toBe('lead_meta');
      expect(rows[0].body).toContain('Spring Buyers');
    });
  });

  it('the scheduler and the webhook cannot both notify for one submission', async () => {
    /*
     * THE TEST THIS EVENT EXISTS FOR. The same Meta submission can reach this application twice —
     * once from the scheduled poll and once from the webhook — and neither path knows about the
     * other. The key is Meta's own submission id, so whichever arrives second is dropped
     * deterministically, with no dependence on ordering or timing.
     */
    await inRollback(async (tx) => {
      const owner = await makeUser(tx);
      const { notifier } = build(tx);

      await notifier.metaLeadArrived(LEAD, owner.id, 'fb-lead-777', 'via scheduler');
      await notifier.metaLeadArrived({ ...LEAD, id: 9999 }, owner.id, 'fb-lead-777', 'via webhook');

      expect(await stored(tx, owner.id)).toHaveLength(1);
    });
  });

  it('does nothing without a Meta submission id', async () => {
    // Without the id there is no idempotency, so it is refused rather than sent unguarded.
    await inRollback(async (tx) => {
      const owner = await makeUser(tx);
      const { notifier } = build(tx);
      await notifier.metaLeadArrived(LEAD, owner.id, '');
      expect(await stored(tx, owner.id)).toHaveLength(0);
    });
  });
});

// ============================================================================ 4. task due
describe('lead task due', () => {
  it('notifies the assignee, naming the task and the lead', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { notifier } = build(tx);

      await notifier.leadTaskDue(
        { id: 11, title: 'Call about the offer', due_at: new Date('2026-08-06T00:00:00Z') },
        LEAD, user.id, '2026-08-06',
      );

      const rows = await stored(tx, user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].category).toBe('lead_task_due');
      expect(rows[0].body).toContain('Call about the offer');
      expect(rows[0].body).toContain('John Smith');
      expect(rows[0].link).toBe(`/crm/lead/${LEAD.id}`);
    });
  });

  it('a sweep running repeatedly on the same day notifies once', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { notifier } = build(tx);
      const task = { id: 11, title: 'Call', due_at: new Date('2026-08-06T00:00:00Z') };

      for (let i = 0; i < 4; i += 1) await notifier.leadTaskDue(task, LEAD, user.id, '2026-08-06');

      expect(await stored(tx, user.id)).toHaveLength(1);
    });
  });

  it('a genuinely separate occurrence notifies again', async () => {
    // The occurrence is part of the key, so a task due again on another date is not a duplicate.
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { notifier } = build(tx);
      const task = { id: 11, title: 'Call', due_at: new Date('2026-08-06T00:00:00Z') };

      await notifier.leadTaskDue(task, LEAD, user.id, '2026-08-06');
      await notifier.leadTaskDue(task, LEAD, user.id, '2026-08-13');

      expect(await stored(tx, user.id)).toHaveLength(2);
    });
  });
});

// ============================================================================ 5/6. campaigns
describe('campaign finished', () => {
  it('tells the owner what was sent', async () => {
    await inRollback(async (tx) => {
      const owner = await makeUser(tx);
      const { notifier } = build(tx);

      await notifier.campaignCompleted({ id: 7, name: 'August Buyer Follow-Up' }, owner.id,
        { recipients: 500, sent: 498, failed: 2 });

      const rows = await stored(tx, owner.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].category).toBe('campaign_completed');
      expect(rows[0].body).toContain('August Buyer Follow-Up');
      expect(rows[0].body).toContain('498');
      expect(rows[0].body).toContain('500');
      expect(rows[0].body).toContain('2 could not be delivered');
      /*
       * A query parameter, not a path segment. `App.tsx` registers campaigns as `paths: ['']` —
       * the index alone — so `/crm/campaigns/7` matched no route in the SPA. This assertion passed
       * for as long as the link was broken, which is why the dead notification link survived: the
       * test proved the string the code produced, never that it led anywhere.
       */
      expect(rows[0].link).toBe('/crm/campaigns?open=7');
    });
  });

  it('reads cleanly when nothing failed', async () => {
    await inRollback(async (tx) => {
      const owner = await makeUser(tx);
      const { notifier } = build(tx);
      await notifier.campaignCompleted({ id: 7, name: 'Clean Run' }, owner.id, { recipients: 10, sent: 10, failed: 0 });
      expect((await stored(tx, owner.id))[0].body).not.toContain('could not be delivered');
    });
  });
});

describe('campaign failed', () => {
  it('tells the owner plainly, without technical detail', async () => {
    /*
     * THE IMPORTANT ASSERTION. A campaign owner cannot act on an SMTP response or a server path, and
     * it must not reach their inbox or their phone. The technical reason is logged instead.
     */
    await inRollback(async (tx) => {
      const owner = await makeUser(tx);
      const { notifier } = build(tx);

      await notifier.campaignFailed(
        { id: 7, name: 'August Buyer Follow-Up' }, owner.id, 'delivery-aborted',
        'Error: connect ECONNREFUSED 10.0.0.4:587\n    at TCPConnectWrap /srv/app/dist/mailer.js:82',
      );

      const rows = await stored(tx, owner.id);
      expect(rows).toHaveLength(1);
      const text = `${rows[0].title} ${rows[0].body}`;
      expect(text).toContain('August Buyer Follow-Up');
      for (const leak of ['ECONNREFUSED', '10.0.0.4', '/srv/app', 'TCPConnectWrap', 'Error:', '587']) {
        expect(text).not.toContain(leak);
      }
    });
  });

  it('two different terminal outcomes are two notifications', async () => {
    await inRollback(async (tx) => {
      const owner = await makeUser(tx);
      const { notifier } = build(tx);

      await notifier.campaignFailed({ id: 7, name: 'C' }, owner.id, 'no-recipients-reached');
      await notifier.campaignFailed({ id: 7, name: 'C' }, owner.id, 'delivery-aborted');

      expect(await stored(tx, owner.id)).toHaveLength(2);
    });
  });

  it('the same terminal outcome reported twice is one notification', async () => {
    await inRollback(async (tx) => {
      const owner = await makeUser(tx);
      const { notifier } = build(tx);

      await notifier.campaignFailed({ id: 7, name: 'C' }, owner.id, 'delivery-aborted');
      await notifier.campaignFailed({ id: 7, name: 'C' }, owner.id, 'delivery-aborted');

      expect(await stored(tx, owner.id)).toHaveLength(1);
    });
  });
});

// ============================================================================ channel matrix
describe('channel preferences are honoured for every new category', () => {
  const CATEGORIES = ['lead_new', 'lead_assigned', 'lead_meta', 'lead_task_due', 'campaign_completed', 'campaign_failed'];

  /** Fire the event that belongs to a category, so each is exercised through its own method. */
  async function fire(notifier: CrmEventNotifier, category: string, userId: number) {
    switch (category) {
      case 'lead_new': return notifier.leadCreated(LEAD, userId, null);
      case 'lead_assigned': return notifier.leadAssigned(LEAD, userId, null, 'A');
      case 'lead_meta': return notifier.metaLeadArrived(LEAD, userId, `fb-${userId}`);
      case 'lead_task_due': return notifier.leadTaskDue({ id: 1, title: 'T', due_at: new Date() }, LEAD, userId, '2026-08-06');
      case 'campaign_completed': return notifier.campaignCompleted({ id: 1, name: 'C' }, userId, { recipients: 1, sent: 1, failed: 0 });
      default: return notifier.campaignFailed({ id: 1, name: 'C' }, userId, 'x');
    }
  }

  it.each(CATEGORIES)('%s delivers on every channel when nothing is muted', async (category) => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { notifier, emails, pushes } = build(tx);

      await fire(notifier, category, user.id);

      expect(await stored(tx, user.id)).toHaveLength(1);   // in-app
      expect(emails).toHaveLength(1);
      expect(pushes).toEqual([user.id]);
    });
  });

  it.each(CATEGORIES)('%s honours a muted channel and leaves the others working', async (category) => {
    /*
     * The property the per-channel model exists for, asserted for every new category rather than
     * assumed from the platform: muting email must not silence in-app or push.
     */
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { notifier, emails, pushes, prefs } = build(tx);
      await prefs.set(user.id, category, 'email', false);

      await fire(notifier, category, user.id);

      expect(emails).toHaveLength(0);
      expect(await stored(tx, user.id)).toHaveLength(1);
      expect(pushes).toEqual([user.id]);
    });
  });

  it.each(CATEGORIES)('%s sends nothing at all when every channel is muted', async (category) => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { notifier, emails, pushes, prefs } = build(tx);
      for (const channel of NOTIFICATION_CHANNELS) await prefs.set(user.id, category, channel, false);

      await fire(notifier, category, user.id);

      expect(await stored(tx, user.id)).toHaveLength(0);
      expect(emails).toHaveLength(0);
      expect(pushes).toHaveLength(0);
    });
  });

  it('a mixed selection delivers exactly the chosen channels', async () => {
    // In-app ON / Email OFF / Push ON — the combination the brief calls out.
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { notifier, emails, pushes, prefs } = build(tx);
      await prefs.set(user.id, 'lead_assigned', 'email', false);

      await notifier.leadAssigned(LEAD, user.id, null, 'A');

      expect(await stored(tx, user.id)).toHaveLength(1);
      expect(emails).toHaveLength(0);
      expect(pushes).toEqual([user.id]);
    });
  });

  it('in-app OFF / email ON / push OFF delivers only the email', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { notifier, emails, pushes, prefs } = build(tx);
      for (const channel of ['in_app', 'push'] as NotificationChannel[]) {
        await prefs.set(user.id, 'lead_new', channel, false);
      }

      await notifier.leadCreated(LEAD, user.id, null);

      expect(await stored(tx, user.id)).toHaveLength(0);
      expect(emails).toHaveLength(1);
      expect(pushes).toHaveLength(0);
    });
  });

  it('defaults to delivering when the person has never expressed a preference', async () => {
    // Deterministic on absence: no row means on. Nobody goes quiet because a feature shipped.
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { prefs } = build(tx);
      for (const category of CATEGORIES) {
        const choices = await prefs.channelsFor(user.id, category);
        expect(choices).toEqual({ in_app: true, email: true, push: true });
      }
    });
  });
});

// ============================================================================ isolation
describe('who receives what', () => {
  it('one person is never told about another person\'s lead', async () => {
    await inRollback(async (tx) => {
      const mine = await makeUser(tx);
      const theirs = await makeUser(tx);
      const { notifier } = build(tx);

      await notifier.leadCreated(LEAD, mine.id, null);

      expect(await stored(tx, mine.id)).toHaveLength(1);
      expect(await stored(tx, theirs.id)).toHaveLength(0);
    });
  });

  it('the recipient is decided server-side, from the event', async () => {
    /*
     * Nothing in these methods accepts a recipient from a request body — every call site passes an
     * id it read from the record itself. This asserts the shape that keeps that true: an id that is
     * not a real, active user produces nothing rather than a stray notification.
     */
    await inRollback(async (tx) => {
      const { notifier } = build(tx);
      await notifier.leadCreated(LEAD, 999_999_999, null);
      const orphan = await tx.notifications.findMany({ where: { user_id: 999_999_999 } });
      expect(orphan).toHaveLength(0);
    });
  });

  it('addresses the notification to the recipient and nobody else', async () => {
    // This asserted the row's `company_id` until multi-brokerage tenancy was removed. What survived
    // the column is the responsibility that always mattered: a notification is addressed to a
    // person, and `user_id` is what decides whose notification centre it turns up in.
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const other = await makeUser(tx);
      const { notifier } = build(tx);
      await notifier.leadCreated(LEAD, user.id, null);
      expect((await stored(tx, user.id)).map((r) => r.user_id)).toEqual([user.id]);
      expect(await stored(tx, other.id)).toEqual([]);
    });
  });
});

// ============================================================================ failure handling
describe('a notification never breaks the operation that caused it', () => {
  it('swallows a dispatcher failure', async () => {
    /*
     * A lead must not fail to save because a notification could not be delivered. The notifier
     * catches and logs; the caller sees a resolved promise either way.
     */
    const exploding = { dispatch: async () => { throw new Error('everything is on fire'); } } as never;
    /*
     * No Prisma either — deliberately. Template resolution must not be able to stop a notification
     * any more than the dispatcher can: with no database to read, `templated` falls back to the
     * dispatcher's own body rather than throwing into the caller, which is what this asserts.
     */
    const notifier = new CrmEventNotifier(exploding, null as never);

    await expect(notifier.leadCreated(LEAD, 1, null)).resolves.toBeUndefined();
    await expect(notifier.leadAssigned(LEAD, 1, null, 'A')).resolves.toBeUndefined();
    await expect(notifier.metaLeadArrived(LEAD, 1, 'fb-1')).resolves.toBeUndefined();
    await expect(notifier.leadTaskDue({ id: 1, title: 'T', due_at: new Date() }, LEAD, 1, 'd')).resolves.toBeUndefined();
    await expect(notifier.campaignCompleted({ id: 1, name: 'C' }, 1, { recipients: 1, sent: 1, failed: 0 })).resolves.toBeUndefined();
    await expect(notifier.campaignFailed({ id: 1, name: 'C' }, 1, 'x')).resolves.toBeUndefined();
  });
});
