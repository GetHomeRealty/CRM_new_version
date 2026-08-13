import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { InboxService } from './inbox.service';

/**
 * CROSS-USER ISOLATION IN THE INBOX — the question the 2026-08-05 breadth sweep could not answer.
 *
 * That sweep recorded: *"the inbox cross-read was not tested either — the seeded agent mailbox holds
 * 0 messages, so there was nothing to attempt a cross-read against."* An isolation probe with no
 * data to isolate proves nothing, and it was reported as such rather than as a pass.
 *
 * So these seed the mail themselves. Two people, two connected accounts, real rows — then every way
 * one of them can name the other's message: list it, fetch it by id, and mark it read.
 *
 * WHY AT THE SERVICE LAYER. `InboxController` passes `user.id` from the session and nothing else —
 * there is no user parameter a caller can influence — so the authority is entirely in these `where`
 * clauses. A browser test would exercise the session plumbing; this exercises the rule.
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

/** One agent with a connected, primary account in the given area, holding one message. */
async function agentWithMail(tx: PrismaService, scope: 'crm' | 'desk', subject: string) {
  const now = new Date();
  const t = tag();
  const user = await tx.users.create({
    data: {
      name: `ZZ Inbox ${t}`, email: `zz-inbox-${t}@probe.test`, role: 'agent', status: 'Active',
      password: 'x', created_at: now, updated_at: now,
    },
    select: { id: true },
  });
  const account = await tx.mail_accounts.create({
    data: {
      name: `probe ${t}`, from_email: `zz-acct-${t}@probe.test`, host: 'smtp.probe.test',
      port: 587, is_active: true, is_default: true, user_id: user.id, scope,
      imap_host: 'imap.probe.test', inbound_enabled: true, created_at: now, updated_at: now,
    },
    select: { id: true },
  });
  const mail = await tx.inbound_emails.create({
    data: {
      user_id: user.id, account_id: account.id, uid: Math.floor(Math.random() * 1_000_000) + 1,
      from_email: 'client@example.com', from_name: 'A Client', to_email: `zz-acct-${t}@probe.test`,
      subject, snippet: subject, body_text: subject, received_at: now, seen: false, created_at: now,
    },
    select: { id: true },
  });
  return { userId: user.id, accountId: account.id, mailId: mail.id, subject };
}

const subjectsIn = (r: unknown): string[] =>
  (r as { data: { subject: string }[] }).data.map((m) => m.subject);

describe('one agent cannot reach another agent\'s mail', () => {
  it('it is not in their list', async () => {
    await inRollback(async (tx) => {
      const inbox = new InboxService(tx);
      const theirs = await agentWithMail(tx, 'crm', `ZZ THEIRS ${tag()}`);
      const mine = await agentWithMail(tx, 'crm', `ZZ MINE ${tag()}`);

      expect(subjectsIn(await inbox.list(mine.userId, 'crm'))).toEqual([mine.subject]);
      expect(subjectsIn(await inbox.list(theirs.userId, 'crm'))).toEqual([theirs.subject]);
    });
  });

  it('fetching it by id is refused', async () => {
    // The list is what a person sees; the id is what a person can type. Both have to be closed, and
    // only the list filter is obvious from the screen.
    await inRollback(async (tx) => {
      const inbox = new InboxService(tx);
      const theirs = await agentWithMail(tx, 'crm', `ZZ THEIRS ${tag()}`);
      const mine = await agentWithMail(tx, 'crm', `ZZ MINE ${tag()}`);

      await expect(inbox.get(mine.userId, 'crm', theirs.mailId)).rejects.toMatchObject({ status: 404 });
    });
  });

  it('marking it read is refused, and it stays unread', async () => {
    await inRollback(async (tx) => {
      const inbox = new InboxService(tx);
      const theirs = await agentWithMail(tx, 'crm', `ZZ THEIRS ${tag()}`);
      const mine = await agentWithMail(tx, 'crm', `ZZ MINE ${tag()}`);

      await expect(inbox.markSeen(mine.userId, 'crm', theirs.mailId, true)).rejects.toMatchObject({ status: 404 });
      // The refusal is worth nothing if the write happened first.
      const after = await tx.inbound_emails.findUnique({ where: { id: theirs.mailId }, select: { seen: true } });
      expect(after?.seen).toBe(false);
    });
  });

  it('404, not 403 — the reply does not confirm the message exists', async () => {
    await inRollback(async (tx) => {
      const inbox = new InboxService(tx);
      const theirs = await agentWithMail(tx, 'crm', `ZZ THEIRS ${tag()}`);
      const mine = await agentWithMail(tx, 'crm', `ZZ MINE ${tag()}`);

      const real = await inbox.get(mine.userId, 'crm', theirs.mailId).catch((e: Error) => e.message);
      const invented = await inbox.get(mine.userId, 'crm', 2_000_000_000).catch((e: Error) => e.message);
      // Identical wording, so a probe cannot tell a real id from an invented one.
      expect(real).toBe(invented);
    });
  });

  it('…including when the reader has no primary mailbox of their own', async () => {
    /*
     * WHY THIS ONE EXISTS, and it is the most important test in the file.
     *
     * There are two filters on every inbox read: `user_id`, and the primary account's `account_id`.
     * Stripping `user_id` from the service and re-running this spec left the by-id tests PASSING —
     * the account filter was catching them — which would have made `user_id` look redundant to
     * whoever refactors this next.
     *
     * It is not. `scopeFor` falls back to "every account this area can see, by scope" when the
     * reader has no primary, and that fallback is not scoped to a person at all. So on this path
     * `user_id` is the ONLY thing standing between one agent and the whole brokerage's mail.
     *
     * Measured: with `user_id` removed and no primary account, this fetch succeeds.
     */
    await inRollback(async (tx) => {
      const inbox = new InboxService(tx);
      const theirs = await agentWithMail(tx, 'crm', `ZZ THEIRS ${tag()}`);
      // A reader with a connected account that is NOT primary, so `primaryAccount` returns null.
      const mine = await agentWithMail(tx, 'crm', `ZZ MINE ${tag()}`);
      await tx.mail_accounts.update({ where: { id: mine.accountId }, data: { is_default: false } });

      expect(subjectsIn(await inbox.list(mine.userId, 'crm'))).toEqual([mine.subject]);
      await expect(inbox.get(mine.userId, 'crm', theirs.mailId)).rejects.toMatchObject({ status: 404 });
      await expect(inbox.markSeen(mine.userId, 'crm', theirs.mailId, true)).rejects.toMatchObject({ status: 404 });
    });
  });

  it('the unread badge counts only their own mail', async () => {
    // A count that includes somebody else's mail is a disclosure even when the list does not.
    await inRollback(async (tx) => {
      const inbox = new InboxService(tx);
      await agentWithMail(tx, 'crm', `ZZ THEIRS ${tag()}`);
      const mine = await agentWithMail(tx, 'crm', `ZZ MINE ${tag()}`);

      expect((await inbox.list(mine.userId, 'crm') as { unread: number }).unread).toBe(1);
    });
  });

  it('filtering by a lead does not widen the scope', async () => {
    /*
     * `?lead=` is caller-supplied and goes straight into the `where`. It is ANDed with `user_id`, so
     * naming a lead somebody else corresponds with returns nothing — worth pinning, because a filter
     * added to a scoped query is exactly where a scope gets lost.
     */
    await inRollback(async (tx) => {
      const inbox = new InboxService(tx);
      const theirs = await agentWithMail(tx, 'crm', `ZZ THEIRS ${tag()}`);
      const mine = await agentWithMail(tx, 'crm', `ZZ MINE ${tag()}`);
      const now = new Date();
      const lead = await tx.leads.create({
        data: {
          name: `ZZ Lead ${tag()}`, email: `zz-lead-${tag()}@probe.test`, lead_status: 'New',
          owner_user_id: theirs.userId, created_at: now, updated_at: now,
        },
        select: { id: true },
      });
      await tx.inbound_emails.update({ where: { id: theirs.mailId }, data: { lead_id: lead.id } });

      expect(subjectsIn(await inbox.list(mine.userId, 'crm', { leadId: lead.id }))).toEqual([]);
      expect(subjectsIn(await inbox.list(theirs.userId, 'crm', { leadId: lead.id }))).toEqual([theirs.subject]);
    });
  });
});

describe('the two areas are separate inboxes, not one with a label', () => {
  it('a CRM message is not in the Transaction Desk list', async () => {
    await inRollback(async (tx) => {
      const inbox = new InboxService(tx);
      const crm = await agentWithMail(tx, 'crm', `ZZ CRM ${tag()}`);
      // The same person, a second account, the other area.
      const now = new Date();
      const t = tag();
      const deskAccount = await tx.mail_accounts.create({
        data: {
          name: `probe desk ${t}`, from_email: `zz-desk-${t}@probe.test`, host: 'smtp.probe.test',
          port: 587, is_active: true, is_default: true, user_id: crm.userId, scope: 'desk',
          imap_host: 'imap.probe.test', inbound_enabled: true, created_at: now, updated_at: now,
        },
        select: { id: true },
      });
      const deskSubject = `ZZ DESK ${t}`;
      await tx.inbound_emails.create({
        data: {
          user_id: crm.userId, account_id: deskAccount.id, uid: Math.floor(Math.random() * 1_000_000) + 1,
          from_email: 'client@example.com', to_email: `zz-desk-${t}@probe.test`,
          subject: deskSubject, snippet: deskSubject, received_at: now, seen: false, created_at: now,
        },
      });

      expect(subjectsIn(await inbox.list(crm.userId, 'crm'))).toEqual([crm.subject]);
      expect(subjectsIn(await inbox.list(crm.userId, 'desk'))).toEqual([deskSubject]);
    });
  });

  it('asking the wrong area for your own message says where it is, rather than "not found"', async () => {
    /*
     * This is a usability rule with a disclosure edge, so it is worth an explicit test: the helpful
     * message is produced ONLY for a message the caller already owns. The lookup behind it is bounded
     * by `user_id`, so it cannot describe anybody else's.
     */
    await inRollback(async (tx) => {
      const inbox = new InboxService(tx);
      const crm = await agentWithMail(tx, 'crm', `ZZ CRM ${tag()}`);
      await expect(inbox.get(crm.userId, 'desk', crm.mailId)).rejects.toThrow(/Customer Relationship Management inbox/i);
    });
  });

  it('…but never for somebody else\'s message', async () => {
    await inRollback(async (tx) => {
      const inbox = new InboxService(tx);
      const theirs = await agentWithMail(tx, 'crm', `ZZ THEIRS ${tag()}`);
      const mine = await agentWithMail(tx, 'desk', `ZZ MINE ${tag()}`);
      // Plain "Message not found." — no hint that it exists in the CRM area under another name.
      await expect(inbox.get(mine.userId, 'desk', theirs.mailId)).rejects.toThrow(/^Message not found\.$/);
    });
  });
});

/**
 * PRIORITY 3 — CONCURRENCY. Two sessions acting on one message at the same moment.
 *
 * Deliberately a SHORT section, because the surface is small and the right answer here is different
 * from the Calendar's. `markSeen` sets one boolean. There is no field to lose and no edit to
 * overwrite, so last-writer-wins is not a defect — it is what anybody would expect from marking mail
 * read in two tabs, and a 409 conflict dialog on a read receipt would be the wrong product.
 *
 * What these check is that concurrency cannot leave the row in a state neither caller asked for, and
 * cannot escape the ownership filter under a race.
 */
describe('two sessions acting on one message at once', () => {
  it('two simultaneous mark-as-read calls both succeed and agree', async () => {
    await inRollback(async (tx) => {
      const inbox = new InboxService(tx);
      const mine = await agentWithMail(tx, 'crm', `ZZ CONC ${tag()}`);

      const [a, b] = await Promise.all([
        inbox.markSeen(mine.userId, 'crm', mine.mailId, true),
        inbox.markSeen(mine.userId, 'crm', mine.mailId, true),
      ]);

      expect(a).toEqual({ seen: true });
      expect(b).toEqual({ seen: true });
      const row = await tx.inbound_emails.findUnique({ where: { id: mine.mailId }, select: { seen: true } });
      expect(row?.seen).toBe(true);
    });
  });

  it('opposite simultaneous writes settle on one value, not a torn one', async () => {
    // Last writer wins, and which one wins is genuinely undefined. What must hold is that the row is
    // one of the two requested values rather than anything else.
    await inRollback(async (tx) => {
      const inbox = new InboxService(tx);
      const mine = await agentWithMail(tx, 'crm', `ZZ CONC ${tag()}`);

      await Promise.allSettled([
        inbox.markSeen(mine.userId, 'crm', mine.mailId, true),
        inbox.markSeen(mine.userId, 'crm', mine.mailId, false),
      ]);

      const row = await tx.inbound_emails.findUnique({ where: { id: mine.mailId }, select: { seen: true } });
      expect(typeof row?.seen).toBe('boolean');
    });
  });

  it('a race does not let the ownership filter be skipped', async () => {
    /*
     * The one that would matter. Both calls run at once, one from the owner and one from somebody
     * else; the intruder's must still be refused and must not ride in on the owner's write.
     */
    await inRollback(async (tx) => {
      const inbox = new InboxService(tx);
      const theirs = await agentWithMail(tx, 'crm', `ZZ THEIRS ${tag()}`);
      const mine = await agentWithMail(tx, 'crm', `ZZ MINE ${tag()}`);

      const results = await Promise.allSettled([
        inbox.markSeen(theirs.userId, 'crm', theirs.mailId, true),
        inbox.markSeen(mine.userId, 'crm', theirs.mailId, true),
      ]);

      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe('rejected');
    });
  });

  it('a concurrent read does not mark somebody else\'s message seen', async () => {
    // `get` has the side effect of marking read, so it is a write path too and needs the same check.
    await inRollback(async (tx) => {
      const inbox = new InboxService(tx);
      const theirs = await agentWithMail(tx, 'crm', `ZZ THEIRS ${tag()}`);
      const mine = await agentWithMail(tx, 'crm', `ZZ MINE ${tag()}`);

      await Promise.allSettled([
        inbox.get(mine.userId, 'crm', theirs.mailId),
        inbox.get(mine.userId, 'crm', mine.mailId),
      ]);

      const row = await tx.inbound_emails.findUnique({ where: { id: theirs.mailId }, select: { seen: true } });
      expect(row?.seen).toBe(false);
    });
  });
});
