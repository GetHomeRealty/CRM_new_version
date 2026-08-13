import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { NotificationCenterService } from './notification-center.service';
import { NotificationsService } from './notifications.service';
import type { ResourceUser } from '../transactions/transaction.resource';

/**
 * The Notification Centre, against REAL ROWS.
 *
 * WHY THIS FILE EXISTS AND THE E2E ONE IS NOT ENOUGH. `e2e/tests/notification-center.spec.ts` runs
 * against a test database that contains no notifications at all — measured, not assumed: zero
 * DocReview logs, zero reviews, zero in-app reminders. Every filtering and marking assertion there
 * passes over an EMPTY array, which means it would pass just as happily if the merge returned
 * nothing, filtered wrongly, or ignored `unread` entirely. It proves the endpoints answer and are
 * authorised; it proves nothing about the behaviour.
 *
 * This file seeds each of the four sources in both states — read and unread — and asserts the
 * merge, the filters, the count and the marking against them.
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

const centre = (tx: PrismaService) => new NotificationCenterService(
  tx,
  new NotificationsService(tx),
  // The review and reminder feeds are queried directly by the Centre for history; only `markSeen`
  // is delegated, so these stubs are enough and keep the test about the Centre.
  { markSeen: async () => ({ ok: true }) } as never,
  { markSeen: async () => ({ ok: true }) } as never,
);

const AGENT: ResourceUser = { id: 9001, role: 'agent', name: 'ZZ Centre Agent' };
const OTHER: ResourceUser = { id: 9002, role: 'agent', name: 'ZZ Other Agent' };

/** A deal owned by `agentName`, with one of each notification kind in the state asked for. */
async function seedDeal(
  tx: PrismaService,
  agentName: string,
  opts: { docRead?: boolean; reviewRead?: boolean; reminderRead?: boolean } = {},
) {
  const now = new Date();
  const t = tag();

  const txn = await tx.transactions.create({
    data: {
      trade_no: `ZZ-${t}`, type: 'Sale', agent: agentName,
      property: `${t} Probe Street`, created_at: now, updated_at: now,    },
    select: { id: true, trade_no: true },
  });

  await tx.audit_logs.create({
    data: {
      transaction_id: txn.id, source: 'DocReview', action: 'Document reviewed',
      details: 'Your purchase agreement was reviewed', who: 'Reviewer',
      handled: opts.docRead === true, created_at: now, updated_at: now,
    },
  });

  await tx.transaction_reviews.create({
    data: {
      transaction_id: txn.id, decision: 'Rejected', agent_name: agentName,
      field_label: 'Purchase price', reason: 'Does not match the agreement',
      agent_seen_at: opts.reviewRead === true ? now : null,
      created_at: now,    },
  });

  await tx.transaction_reminders.create({
    data: {
      transaction_id: txn.id, kind: 'listing-expiry', scheduled_for: now,
      delivery_method: 'in-app', delivery_status: 'sent', recipient: agentName,
      subject: 'Listing expires in 7 days',
      seen_at: opts.reminderRead === true ? now : null,
      created_at: now,    },
  });

  return txn;
}

// ============================================================================ the merge
describe('the merged feed', () => {
  it('shows all three of an agent\'s sources on one list', async () => {
    await inRollback(async (tx) => {
      const deal = await seedDeal(tx, AGENT.name);
      const feed = await centre(tx).feed(AGENT, { filter: 'all', limit: 100 });

      const mine = feed.items.filter((i) => i.transaction_id === deal.id);
      expect(mine.map((i) => i.source).sort()).toEqual(['doc-review', 'reminder', 'review-decision']);
      // Every row is addressable and openable — the two things the screen does with it.
      for (const item of mine) {
        expect(item.key).toBe(`${item.source}:${deal.id}`);
        expect(item.link).toBe(`/desk/transactions/${deal.id}`);
      }
    });
  });

  it('carries the detail a person needs to recognise the deal', async () => {
    await inRollback(async (tx) => {
      const deal = await seedDeal(tx, AGENT.name);
      const feed = await centre(tx).feed(AGENT, { filter: 'all', limit: 100 });

      const review = feed.items.find((i) => i.transaction_id === deal.id && i.source === 'review-decision');
      expect(review?.trade_no).toBe(deal.trade_no);
      expect(review?.property).toContain('Probe Street');
      expect(review?.summary).toContain('Purchase price');
      expect(review?.title).toBe('A change was rejected');
    });
  });
});

// ============================================================================ read vs unread
describe('read and unread', () => {
  it('separates them, and history shows what the bells forgot', async () => {
    /*
     * THE CAPABILITY THE BELLS NEVER HAD. `TransactionReviewService.notifications` and
     * `ReminderSweepService.notifications` both hard-code "not yet seen", so a notification vanishes
     * the moment it is read. The Centre has to be able to show it again, which is why it queries
     * those two tables itself.
     */
    await inRollback(async (tx) => {
      const unreadDeal = await seedDeal(tx, AGENT.name);
      const readDeal = await seedDeal(tx, AGENT.name, { docRead: true, reviewRead: true, reminderRead: true });
      const svc = centre(tx);

      const unread = await svc.feed(AGENT, { filter: 'unread', limit: 100 });
      expect(unread.items.every((i) => i.unread)).toBe(true);
      expect(unread.items.some((i) => i.transaction_id === unreadDeal.id)).toBe(true);
      expect(unread.items.some((i) => i.transaction_id === readDeal.id)).toBe(false);

      const history = await svc.feed(AGENT, { filter: 'read', limit: 100 });
      expect(history.items.every((i) => !i.unread)).toBe(true);
      expect(history.items.some((i) => i.transaction_id === readDeal.id)).toBe(true);
    });
  });

  it('counts only unread on the badge', async () => {
    // A badge that counted read items would never reach zero, and people stop believing it.
    await inRollback(async (tx) => {
      await seedDeal(tx, AGENT.name);
      await seedDeal(tx, AGENT.name, { docRead: true, reviewRead: true, reminderRead: true });
      const svc = centre(tx);

      const count = await svc.unreadCount(AGENT);
      const unread = await svc.feed(AGENT, { filter: 'unread', limit: 100 });

      // The badge and the list must never disagree — that is the classic notification bug.
      expect(count.unread).toBe(unread.total);
      const summed = Object.values(count.by_source).reduce((a, b) => a + b, 0);
      expect(summed).toBe(count.unread);
    });
  });
});

// ============================================================================ filtering
describe('filtering and searching', () => {
  it('narrows to one kind', async () => {
    await inRollback(async (tx) => {
      const deal = await seedDeal(tx, AGENT.name);
      const feed = await centre(tx).feed(AGENT, { filter: 'all', source: 'reminder', limit: 100 });

      expect(feed.items.every((i) => i.source === 'reminder')).toBe(true);
      expect(feed.items.some((i) => i.transaction_id === deal.id)).toBe(true);
    });
  });

  it('searches the deal number, the address and the message', async () => {
    await inRollback(async (tx) => {
      const deal = await seedDeal(tx, AGENT.name);
      const svc = centre(tx);

      // Collected and asserted together: jest's `expect` takes ONE argument (unlike Playwright's),
      // so the per-case message has to be in the value rather than beside it.
      const found: Record<string, boolean> = {};
      for (const needle of [deal.trade_no, 'Probe Street', 'Purchase price']) {
        const feed = await svc.feed(AGENT, { filter: 'all', search: needle, limit: 100 });
        found[needle] = feed.items.some((i) => i.transaction_id === deal.id);
      }
      expect(found).toEqual({ [deal.trade_no]: true, 'Probe Street': true, 'Purchase price': true });

      const nothing = await svc.feed(AGENT, { filter: 'all', search: 'zzz-no-such-thing', limit: 100 });
      expect(nothing.items.some((i) => i.transaction_id === deal.id)).toBe(false);
    });
  });

  it('paginates without losing or repeating rows', async () => {
    await inRollback(async (tx) => {
      for (let i = 0; i < 3; i += 1) await seedDeal(tx, AGENT.name);
      const svc = centre(tx);

      const all = await svc.feed(AGENT, { filter: 'all', limit: 100 });
      const first = await svc.feed(AGENT, { filter: 'all', limit: 2, offset: 0 });
      const second = await svc.feed(AGENT, { filter: 'all', limit: 2, offset: 2 });

      expect(first.items).toHaveLength(2);
      expect(first.total).toBe(all.total);
      // No overlap between consecutive pages.
      const overlap = first.items.filter((a) => second.items.some((b) => b.key === a.key));
      expect(overlap).toEqual([]);
    });
  });

  it('caps an absurd page size', async () => {
    await inRollback(async (tx) => {
      await seedDeal(tx, AGENT.name);
      const feed = await centre(tx).feed(AGENT, { filter: 'all', limit: 100_000 });
      expect(feed.limit).toBeLessThanOrEqual(NotificationCenterService.MAX_LIMIT);
    });
  });
});

// ============================================================================ isolation
describe('whose notifications these are', () => {
  it('one agent never sees another\'s', async () => {
    /*
     * THE ONE THAT MATTERS MOST. A merged feed is exactly where an ownership condition gets dropped,
     * and the failure is silent — one agent quietly reading another's deals, with nothing to show
     * that it is happening.
     */
    await inRollback(async (tx) => {
      const theirs = await seedDeal(tx, OTHER.name);
      const feed = await centre(tx).feed(AGENT, { filter: 'all', limit: 100 });

      expect(feed.items.some((i) => i.transaction_id === theirs.id)).toBe(false);
      expect((await centre(tx).unreadCount(AGENT)).unread).toBe(
        (await centre(tx).feed(AGENT, { filter: 'unread', limit: 100 })).total,
      );
    });
  });

  it('an agent is never handed the administrator feed', async () => {
    await inRollback(async (tx) => {
      const deal = await seedDeal(tx, AGENT.name);
      await tx.audit_logs.create({
        data: {
          transaction_id: deal.id, source: 'Agent', action: 'Updated', field: 'Purchase price',
          who: AGENT.name, handled: false, created_at: new Date(), updated_at: new Date(),
        },
      });

      const feed = await centre(tx).feed(AGENT, { filter: 'all', limit: 100 });
      expect(feed.items.some((i) => i.source === 'agent-change')).toBe(false);
    });
  });

  it('gives nothing at all to a caller with no identity', async () => {
    await inRollback(async (tx) => {
      await seedDeal(tx, AGENT.name);
      expect(await centre(tx).feed(null, { filter: 'all' })).toMatchObject({ items: [], total: 0, unread: 0 });
      expect((await centre(tx).unreadCount(null)).unread).toBe(0);
    });
  });
});

// ============================================================================ marking
describe('marking read', () => {
  it('a reminder marked read leaves the unread list and appears in history', async () => {
    await inRollback(async (tx) => {
      const deal = await seedDeal(tx, AGENT.name);
      const svc = new NotificationCenterService(
        tx,
        new NotificationsService(tx),
        { markSeen: async () => ({ ok: true }) } as never,
        // The real marker, so the row actually changes rather than a stub reporting success.
        {
          markSeen: async (name: string, txnId: number) => {
            await tx.transaction_reminders.updateMany({
              where: { transaction_id: txnId, recipient: name, delivery_method: 'in-app', seen_at: null },
              data: { seen_at: new Date() },
            });
            return { ok: true };
          },
        } as never,
      );

      expect((await svc.feed(AGENT, { filter: 'unread', limit: 100 }))
        .items.some((i) => i.key === `reminder:${deal.id}`)).toBe(true);

      await svc.markRead(AGENT, 'reminder', deal.id);

      expect((await svc.feed(AGENT, { filter: 'unread', limit: 100 }))
        .items.some((i) => i.key === `reminder:${deal.id}`)).toBe(false);
      expect((await svc.feed(AGENT, { filter: 'read', limit: 100 }))
        .items.some((i) => i.key === `reminder:${deal.id}`)).toBe(true);
    });
  });

  it('refuses a source it does not recognise', async () => {
    await inRollback(async (tx) => {
      const deal = await seedDeal(tx, AGENT.name);
      expect(await centre(tx).markRead(AGENT, 'not-a-source' as never, deal.id)).toEqual({ ok: false });
    });
  });

  it('does nothing for a caller with no identity', async () => {
    await inRollback(async (tx) => {
      const deal = await seedDeal(tx, AGENT.name);
      expect(await centre(tx).markRead(null, 'reminder', deal.id)).toEqual({ ok: false });
      expect(await centre(tx).markAllRead(null)).toMatchObject({ ok: false, marked: 0 });
    });
  });

  it('mark-all reports how many it could and could not clear', async () => {
    /*
     * Counted rather than reported as a flat success. A deal the person can no longer open cannot be
     * cleared, and saying "all read" while the badge stays lit is worse than saying so plainly.
     */
    await inRollback(async (tx) => {
      await seedDeal(tx, AGENT.name);
      const svc = new NotificationCenterService(
        tx,
        new NotificationsService(tx),
        { markSeen: async () => ({ ok: true }) } as never,
        { markSeen: async () => ({ ok: false }) } as never,   // this source refuses
      );

      const result = await svc.markAllRead(AGENT);
      expect(result.ok).toBe(true);
      expect(result.marked + result.failed).toBeGreaterThan(0);
      expect(result.failed).toBeGreaterThan(0);
    });
  });
});

// ============================================================================ new-mail lines
/**
 * New mail is the one direct notification filtered by WHICH MAILBOX it came from.
 *
 * A person may have several addresses syncing — a working one, a shared enquiries box, an old
 * address kept for archive — and only the primary one is worth interrupting them for. The rule is
 * applied on read rather than only on write, so making a different address primary retires the old
 * mailbox's history at once instead of leaving it in the list until somebody clears it by hand.
 * Every assertion below is against real rows, inside a rollback.
 */
describe('new-mail notifications follow the primary mailbox', () => {
  /** A user with mailboxes, and one new-mail notification per mailbox. */
  async function seedMailboxes(tx: PrismaService, count: number, primaryIndex: number) {
    const now = new Date();
    const t = tag();

    const user = await tx.users.create({
      data: {
        name: `ZZ Mail ${t}`, email: `zz-mail-${t}@probe.test`, username: `zzmail${t.replace(/-/g, '')}`,
        role: 'agent', status: 'Active', password: 'x', created_at: now, updated_at: now,
      },
      select: { id: true, name: true },
    });

    const boxes: { id: number }[] = [];
    for (let i = 0; i < count; i += 1) {
      const box = await tx.mail_accounts.create({
        data: {
          name: `ZZ Box ${i} ${t}`, from_email: `zz-box-${i}-${t}@probe.test`,
          host: 'smtp.probe.test', port: 587, user_id: user.id, scope: 'crm',
          is_active: true, is_default: i === primaryIndex,
          created_at: now, updated_at: now,
        },
        select: { id: true },
      });
      boxes.push(box);

      await tx.notifications.create({
        data: {
          user_id: user.id, category: 'inbox_new_mail',
          title: `You have a new email (box ${i})`, body: `zz-box-${i}-${t}@probe.test`,
          link: '/crm/inbox', dedupe_key: `inbox-${box.id}-${100 + i}`,
          read_at: null, created_at: now,
        },
      });
    }

    return { user: { id: user.id, role: 'agent', name: user.name } as ResourceUser, boxes };
  }

  const mailTitles = (feed: { items: { title: string }[] }): string[] =>
    feed.items.filter((i) => i.title.startsWith('You have a new email')).map((i) => i.title);

  it('shows the primary mailbox and hides the others', async () => {
    await inRollback(async (tx) => {
      const { user } = await seedMailboxes(tx, 3, 1);
      const feed = await centre(tx).feed(user, { filter: 'all', limit: 100 });

      expect(mailTitles(feed)).toEqual(['You have a new email (box 1)']);
    });
  });

  it('follows the primary when it changes, without touching a stored row', async () => {
    /*
     * THE CASE THIS BLOCK EXISTS FOR. The line for box 0 was created while box 0 was primary and is
     * still in the table afterwards — the filter is what stops it being shown, so the switch takes
     * effect immediately, and reversing it brings the old one back rather than having destroyed it.
     */
    await inRollback(async (tx) => {
      const { user, boxes } = await seedMailboxes(tx, 2, 0);
      expect(mailTitles(await centre(tx).feed(user, { filter: 'all', limit: 100 })))
        .toEqual(['You have a new email (box 0)']);

      const stored = await tx.notifications.count({ where: { user_id: user.id } });

      // Hand the primary to the second mailbox, exactly as Settings does.
      await tx.mail_accounts.update({ where: { id: boxes[0].id }, data: { is_default: false } });
      await tx.mail_accounts.update({ where: { id: boxes[1].id }, data: { is_default: true } });

      expect(mailTitles(await centre(tx).feed(user, { filter: 'all', limit: 100 })))
        .toEqual(['You have a new email (box 1)']);
      // Nothing was deleted to achieve that.
      expect(await tx.notifications.count({ where: { user_id: user.id } })).toBe(stored);

      // And it is reversible, which a deletion would not have been.
      await tx.mail_accounts.update({ where: { id: boxes[1].id }, data: { is_default: false } });
      await tx.mail_accounts.update({ where: { id: boxes[0].id }, data: { is_default: true } });
      expect(mailTitles(await centre(tx).feed(user, { filter: 'all', limit: 100 })))
        .toEqual(['You have a new email (box 0)']);
    });
  });

  it('keeps the unread count and the list telling the same story', async () => {
    /*
     * A hidden line that still counted would light the badge with nothing behind it. Both the feed
     * and the count go through `collect`, and this is what holds them together.
     */
    await inRollback(async (tx) => {
      const { user } = await seedMailboxes(tx, 4, 2);

      const feed = await centre(tx).feed(user, { filter: 'unread', limit: 100 });
      const counts = await centre(tx).unreadCount(user);

      expect(mailTitles(feed)).toEqual(['You have a new email (box 2)']);
      expect(counts.by_source.direct).toBe(1);
      expect(counts.unread).toBe(feed.total);
    });
  });

  it('hides every one of them when no mailbox is primary', async () => {
    await inRollback(async (tx) => {
      const { user, boxes } = await seedMailboxes(tx, 2, 0);
      await tx.mail_accounts.update({ where: { id: boxes[0].id }, data: { is_default: false } });

      const feed = await centre(tx).feed(user, { filter: 'all', limit: 100 });
      expect(mailTitles(feed)).toEqual([]);
      expect((await centre(tx).unreadCount(user)).by_source.direct).toBe(0);
    });
  });

  it('keeps a primary in each area, because each is primary for its own side', async () => {
    await inRollback(async (tx) => {
      const { user, boxes } = await seedMailboxes(tx, 2, 0);
      // The second becomes the Transaction Desk's primary. Both are now primary somewhere.
      await tx.mail_accounts.update({
        where: { id: boxes[1].id }, data: { is_default: true, scope: 'desk' },
      });

      const feed = await centre(tx).feed(user, { filter: 'all', limit: 100 });
      expect(mailTitles(feed).sort())
        .toEqual(['You have a new email (box 0)', 'You have a new email (box 1)']);
    });
  });

  it('narrows new mail only — every other direct notification is untouched', async () => {
    await inRollback(async (tx) => {
      const { user } = await seedMailboxes(tx, 2, 0);
      await tx.notifications.create({
        data: {
          user_id: user.id, category: 'lead_assigned', title: 'A lead was assigned to you',
          body: null, link: '/crm/leads/1', dedupe_key: `lead-${tag()}`,
          read_at: null, created_at: new Date(),
        },
      });

      const feed = await centre(tx).feed(user, { filter: 'all', limit: 100 });
      expect(feed.items.some((i) => i.title === 'A lead was assigned to you')).toBe(true);
      expect(mailTitles(feed)).toEqual(['You have a new email (box 0)']);
    });
  });

  it('hides a new-mail line whose mailbox cannot be identified', async () => {
    /*
     * Every one the application writes carries `inbox-<account>-<uid>`. A row without it predates
     * the rule or came from a mailbox that no longer exists, and both are what was asked to stop
     * appearing — so an unreadable key is treated as "not the primary", not "show it anyway".
     */
    await inRollback(async (tx) => {
      const { user } = await seedMailboxes(tx, 1, 0);
      await tx.notifications.create({
        data: {
          user_id: user.id, category: 'inbox_new_mail', title: 'You have a new email (orphan)',
          body: null, link: '/crm/inbox', dedupe_key: null, read_at: null, created_at: new Date(),
        },
      });

      const feed = await centre(tx).feed(user, { filter: 'all', limit: 100 });
      expect(mailTitles(feed)).toEqual(['You have a new email (box 0)']);
    });
  });

  it('leaves a feed with no new-mail lines exactly as it was', async () => {
    /*
     * The guard that skips the mailbox lookup when there is nothing to filter, asserted through
     * behaviour rather than by counting queries.
     */
    await inRollback(async (tx) => {
      const deal = await seedDeal(tx, AGENT.name);
      const feed = await centre(tx).feed(AGENT, { filter: 'all', limit: 100 });
      expect(feed.items.some((i) => i.transaction_id === deal.id)).toBe(true);
    });
  });
});
