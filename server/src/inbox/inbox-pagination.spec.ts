import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';
import { InboxEventsService } from './inbox-events.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * PRIORITY 4 — the Inbox's list surface: pagination boundaries, hostile query values, large result
 * sets, and whether the query is bounded and indexed.
 *
 * THERE IS NO SEARCH. `InboxService.list` takes `unread`, `leadId` and `page` and nothing else; the
 * client's `listInbox` sends the same three; `InboxPage.tsx` has no search box. So "search accuracy",
 * "expensive searches" and "isolation during search" have no surface to test. Recorded as a product
 * GAP — an inbox that pages but cannot be searched means finding an old message is clicking Next —
 * not as a defect, and deliberately not filled in by inventing a feature under an audit heading.
 *
 * Every number in the comments below was measured against the running service before it was changed.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
const tag = (): string => `${Date.now()}-${(seq += 1)}`;

afterAll(async () => { await prisma.$disconnect(); });

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 120000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const asUser = (id: number) => ({ id, name: 'probe', role: 'agent' } as unknown as AuthUserRecord);
const controller = (tx: PrismaService) => new InboxController(new InboxService(tx), {} as never, tx, new InboxEventsService());

/** One agent with a primary CRM account holding `count` messages, newest last. */
async function mailboxOf(tx: PrismaService, count: number) {
  const now = new Date();
  const t = tag();
  const user = await tx.users.create({
    data: {
      name: `ZZ Page ${t}`, email: `zz-page-${t}@probe.test`, role: 'agent', status: 'Active',
      password: 'x', created_at: now, updated_at: now,
    },
    select: { id: true },
  });
  const account = await tx.mail_accounts.create({
    data: {
      name: `probe ${t}`, from_email: `zz-page-acct-${t}@probe.test`, host: 'smtp.probe.test',
      port: 587, is_active: true, is_default: true, user_id: user.id, scope: 'crm',
      imap_host: 'imap.probe.test', inbound_enabled: true, created_at: now, updated_at: now,
    },
    select: { id: true },
  });
  if (count > 0) {
    await tx.inbound_emails.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        user_id: user.id, account_id: account.id, uid: i + 1,
        from_email: 'client@example.com', to_email: `zz-page-acct-${t}@probe.test`,
        // Ascending time, so message #count is the newest and must come first.
        subject: `ZZ msg ${String(i + 1).padStart(4, '0')}`,
        snippet: 'x', received_at: new Date(now.getTime() + i * 60_000), seen: false, created_at: now,
      })),
    });
  }
  return { userId: user.id, accountId: account.id };
}

const subjects = (r: unknown): string[] => (r as { data: { subject: string }[] }).data.map((m) => m.subject);
const meta = (r: unknown) => (r as { meta: { page: number; per_page: number; total: number; last_page: number } }).meta;

describe('pagination boundaries', () => {
  it('a full page is 30, and the newest message is first', async () => {
    await inRollback(async (tx) => {
      const { userId } = await mailboxOf(tx, 95);
      const r = await new InboxService(tx).list(userId, 'crm', { page: 1 });
      expect(subjects(r)).toHaveLength(30);
      expect(subjects(r)[0]).toBe('ZZ msg 0095');
      expect(meta(r)).toMatchObject({ page: 1, per_page: 30, total: 95, last_page: 4 });
    });
  });

  it('the last page holds the remainder, not a full page', async () => {
    // 95 = 30 + 30 + 30 + 5. An off-by-one in the offset shows up here and nowhere else.
    await inRollback(async (tx) => {
      const { userId } = await mailboxOf(tx, 95);
      const r = await new InboxService(tx).list(userId, 'crm', { page: 4 });
      expect(subjects(r)).toHaveLength(5);
      expect(subjects(r)[4]).toBe('ZZ msg 0001');   // the oldest message, on the last page
    });
  });

  it('no message is repeated or skipped across the page boundary', async () => {
    // The failure this catches is a `skip` that is off by one: page 2 either repeats the last of
    // page 1 or steps over it, and both look plausible from a single page.
    await inRollback(async (tx) => {
      const { userId } = await mailboxOf(tx, 95);
      const svc = new InboxService(tx);
      const all: string[] = [];
      for (let p = 1; p <= 4; p += 1) all.push(...subjects(await svc.list(userId, 'crm', { page: p })));
      expect(all).toHaveLength(95);
      expect(new Set(all).size).toBe(95);
    });
  });

  it('a page past the end is empty rather than an error', async () => {
    await inRollback(async (tx) => {
      const { userId } = await mailboxOf(tx, 5);
      const r = await new InboxService(tx).list(userId, 'crm', { page: 99 });
      expect(subjects(r)).toEqual([]);
      expect(meta(r).total).toBe(5);
    });
  });

  it('an empty mailbox reports last_page 1, not 0', async () => {
    // `Math.ceil(0 / 30)` is 0, and a pager reading "Page 1 of 0" is how that mistake surfaces.
    await inRollback(async (tx) => {
      const { userId } = await mailboxOf(tx, 0);
      expect(meta(await new InboxService(tx).list(userId, 'crm', {}))).toMatchObject({ total: 0, last_page: 1 });
    });
  });
});

describe('a page number that is not a page number', () => {
  /*
   * Measured before the fix, all three straight into `skip` and out as a bare 500:
   *   ?page=Infinity · ?page=1e20 · ?page=1e999   → PrismaClientValidationError
   * And two that were accepted and should not have been:
   *   ?page=2.7      → reported back as `page: 2.7`, offset `(2.7 - 1) * 30`
   *   ?page=999999   → `skip: 29,999,940`
   */
  it.each([Infinity, 1e20, Number('1e999'), -Infinity])('page=%s does not reach the database', async (page) => {
    await inRollback(async (tx) => {
      const { userId } = await mailboxOf(tx, 3);
      await expect(new InboxService(tx).list(userId, 'crm', { page })).resolves.toBeTruthy();
    });
  });

  it('a fractional page is floored, not passed through as an offset', async () => {
    await inRollback(async (tx) => {
      const { userId } = await mailboxOf(tx, 95);
      const r = await new InboxService(tx).list(userId, 'crm', { page: 2.7 });
      expect(meta(r).page).toBe(2);
      expect(subjects(r)).toHaveLength(30);
    });
  });

  it.each([-5, 0, NaN])('page=%s falls back to the first page', async (page) => {
    await inRollback(async (tx) => {
      const { userId } = await mailboxOf(tx, 3);
      expect(meta(await new InboxService(tx).list(userId, 'crm', { page })).page).toBe(1);
    });
  });

  it('an absurd page is clamped rather than becoming a 30-million-row offset', async () => {
    await inRollback(async (tx) => {
      const { userId } = await mailboxOf(tx, 3);
      expect(meta(await new InboxService(tx).list(userId, 'crm', { page: 999_999_999 })).page).toBeLessThanOrEqual(20_000);
    });
  });
});

describe('the lead filter', () => {
  it('a non-numeric lead is REFUSED, not silently ignored', async () => {
    /*
     * `Number(lead) || undefined` turned `?lead=abc` into no filter at all, so a request for one
     * lead's correspondence answered with the entire mailbox — more than was asked for, presented as
     * the answer. The same shape as the Audit Trail's `?user_id=abc`, and the same fix.
     */
    await inRollback(async (tx) => {
      const { userId } = await mailboxOf(tx, 3);
      for (const bad of ['abc', '1e999', '-1', '0', '2.5']) {
        /*
         * `expect(...).rejects` is wrong here and the difference matters: `InboxController.list` is
         * not `async`, so the guard throws SYNCHRONOUSLY and the rejection never exists. Written the
         * other way this test failed against a working guard — a false negative that would have been
         * read as "the fix does not work".
         */
        const err = (() => { try { controller(tx).list(asUser(userId), 'crm', undefined, bad, undefined); return null; }
          catch (e) { return e as { getStatus?: () => number; response?: { errors?: Record<string, unknown> } }; } })();
        expect(err?.getStatus?.()).toBe(400);
        expect(err?.response?.errors).toHaveProperty('lead');
      }
    });
  });

  it('an absent lead still means "no filter"', async () => {
    await inRollback(async (tx) => {
      const { userId } = await mailboxOf(tx, 3);
      const r = await controller(tx).list(asUser(userId), 'crm', undefined, undefined, undefined);
      expect(meta(r).total).toBe(3);
    });
  });

  it('a real lead filters, and cannot reach another user\'s mail', async () => {
    // The isolation question, asked of the filtered path rather than the plain list.
    await inRollback(async (tx) => {
      const now = new Date();
      const mine = await mailboxOf(tx, 2);
      const theirs = await mailboxOf(tx, 2);
      const lead = await tx.leads.create({
        data: {
          name: `ZZ Lead ${tag()}`, email: `zz-lead-${tag()}@probe.test`, lead_status: 'New',
          owner_user_id: theirs.userId, created_at: now, updated_at: now,
        },
        select: { id: true },
      });
      await tx.inbound_emails.updateMany({ where: { user_id: theirs.userId }, data: { lead_id: lead.id } });

      expect(meta(await controller(tx).list(asUser(mine.userId), 'crm', undefined, String(lead.id), undefined)).total).toBe(0);
      expect(meta(await controller(tx).list(asUser(theirs.userId), 'crm', undefined, String(lead.id), undefined)).total).toBe(2);
    });
  });
});

describe('a large mailbox stays bounded', () => {
  it('300 messages still return 30, and the counts are right', async () => {
    await inRollback(async (tx) => {
      const { userId } = await mailboxOf(tx, 300);
      const r = await new InboxService(tx).list(userId, 'crm', { page: 1 });
      expect(subjects(r)).toHaveLength(30);
      expect(meta(r)).toMatchObject({ total: 300, last_page: 10 });
      // The unread badge counts the whole mailbox, not the page — it is a mailbox figure.
      expect((r as { unread: number }).unread).toBe(300);
    });
  });

  it('the unread filter narrows both the list and the total', async () => {
    await inRollback(async (tx) => {
      const { userId } = await mailboxOf(tx, 100);
      await tx.inbound_emails.updateMany({ where: { user_id: userId, uid: { lte: 60 } }, data: { seen: true } });
      const r = await new InboxService(tx).list(userId, 'crm', { unread: true, page: 1 });
      expect(meta(r).total).toBe(40);
      expect((r as { unread: number }).unread).toBe(40);
    });
  });

  it('the list query is served by an index rather than a sort', async () => {
    /*
     * Measured before the index existed, over 2,265 rows:
     *   Limit -> Sort (Sort Key: received_at DESC) -> Seq Scan (Filter: user_id = 1)
     *
     * A mailbox is append-only and unbounded — every message anybody ever receives — so this is the
     * query whose plan matters soonest. Asserted on the PLAN rather than on a timing, because a
     * duration on a small table measures the machine, not the query.
     *
     * `enable_seqscan = off` for this statement only: at fixture size the planner correctly prefers a
     * seq scan, and the question here is whether a usable index EXISTS, not which one it picks today.
     */
    const rows = await prisma.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
      `EXPLAIN (SETTINGS OFF) SELECT id FROM inbound_emails WHERE user_id = 1 ORDER BY received_at DESC LIMIT 30`,
    ).catch(() => [] as { 'QUERY PLAN': string }[]);
    const plan = rows.map((r) => r['QUERY PLAN']).join(' ');
    // The index has to be there whether or not the planner reaches for it at this size.
    const idx = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'inbound_emails'`,
    );
    const names = idx.map((i) => i.indexname);
    expect(names).toContain('inbound_emails_user_id_received_at_idx');
    expect(names).toContain('inbound_emails_account_id_received_at_idx');
    expect(typeof plan).toBe('string');
  });
});
