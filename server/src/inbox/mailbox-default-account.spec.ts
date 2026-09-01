import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { MailboxService } from './mailbox.service';
import { threadKeyFor } from './mailbox';

/**
 * THE MAIN INBOX SHOWS ONE MAILBOX — the default one — not every account merged together.
 *
 * WHAT WAS WRONG. Every folder was scoped with `account_id: { in: accountIds(user, area) }`, and
 * `accountIds` returns EVERY account the user has connected in that area. So an agent with their
 * own mailbox and the brokerage's saw both conversations interleaved, with no indication that two
 * mailboxes were involved and no way to look at either alone. `is_default` existed and was honoured
 * — by `sendingAccount`, and by the line that NAMES the list. The screen was therefore labelled
 * with the default account's address while listing everybody else's mail underneath it, which is
 * worse than not labelling it at all.
 *
 * WHAT MUST STAY TRUE, and is why the fix is not simply "filter by is_default":
 *
 *   OWNERSHIP IS A DIFFERENT QUESTION FROM DISPLAY. Opening one message still authorises against
 *   every account the user owns in the area. Narrowing that too would mean a message stopped being
 *   readable the moment it was not in the mailbox currently on screen — so switching accounts, or
 *   following a link to a message, would break.
 *
 *   NO DEFAULT MUST NOT MEAN "ALL". A brokerage that has never marked one gets a single mailbox,
 *   chosen deterministically, rather than a merge.
 *
 *   SYNC IS UNTOUCHED. Every connected account still collects mail; only what the list SHOWS is
 *   scoped. The other account's messages are still stored and still reachable by id.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx as unknown as PrismaService);
      throw new Error(ROLLBACK);
    }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

class StubMailer {
  async sendFromAccount() { return { messageId: `<x-${++seq}@spec.test>` }; }
}
const svc = (tx: PrismaService) => new MailboxService(tx, new StubMailer() as never);

async function makeUser(tx: PrismaService) {
  const stamp = `${Date.now()}-${++seq}`;
  return tx.users.create({
    data: {
      name: 'Default Box', email: `dflt-${stamp}@spec.test`, username: `dflt-${stamp}`,
      role: 'agent', status: 'Active', password: 'x', profile: '{}',
      created_at: new Date(), updated_at: new Date(),
    },
    select: { id: true },
  });
}

async function makeAccount(
  tx: PrismaService, userId: number, address: string,
  o: { isDefault?: boolean; isActive?: boolean; scope?: 'crm' | 'desk' | null } = {},
) {
  return tx.mail_accounts.create({
    data: {
      name: address, from_email: address, host: 'smtp.spec.test', port: 587,
      user_id: userId, scope: o.scope === undefined ? 'crm' : o.scope,
      is_active: o.isActive ?? true, is_default: o.isDefault ?? false,
      created_at: new Date(), updated_at: new Date(),
    },
    select: { id: true, from_email: true },
  });
}

async function receive(tx: PrismaService, userId: number, accountId: number, subject: string) {
  const messageId = `<in-${++seq}@spec.test>`;
  return tx.inbound_emails.create({
    data: {
      user_id: userId, account_id: accountId, uid: seq, message_id: messageId,
      from_email: 'sender@outside.test', from_name: 'Outside', to_email: 'me@spec.test',
      subject, snippet: subject, body_text: subject, received_at: new Date(), seen: false,
      thread_key: threadKeyFor({ messageId }), created_at: new Date(),
    },
    select: { id: true, thread_key: true },
  });
}

const subjects = (res: Record<string, unknown>): string[] =>
  ((res.data ?? []) as { subject: string }[]).map((r) => r.subject).sort();

/** Two mailboxes, one marked default, one message in each. */
async function twoMailboxes(tx: PrismaService) {
  const user = await makeUser(tx);
  const dflt = await makeAccount(tx, user.id, 'default@spec.test', { isDefault: true });
  const other = await makeAccount(tx, user.id, 'other@spec.test', { isDefault: false });
  const mine = await receive(tx, user.id, dflt.id, 'FROM DEFAULT');
  const theirs = await receive(tx, user.id, other.id, 'FROM OTHER');
  return { user, dflt, other, mine, theirs };
}

describe('the default Inbox shows the default account only', () => {
  it('lists the default mailbox and not the other one', async () => {
    await inRollback(async (tx) => {
      const { user } = await twoMailboxes(tx);
      const res = await svc(tx).folder(user.id, 'crm', 'inbox');
      expect(subjects(res)).toEqual(['FROM DEFAULT']);
      expect(res.meta).toMatchObject({ total: 1 });
    });
  });

  it('names the mailbox it is actually showing', async () => {
    await inRollback(async (tx) => {
      const { user } = await twoMailboxes(tx);
      const res = await svc(tx).folder(user.id, 'crm', 'inbox');
      expect((res.mailbox as { address?: string } | null)?.address).toBe('default@spec.test');
    });
  });

  it('counts unread for that mailbox alone', async () => {
    // The badge used to total every connected account, so it could not be cleared by reading
    // everything the list was willing to show.
    await inRollback(async (tx) => {
      const { user, other } = await twoMailboxes(tx);
      await receive(tx, user.id, other.id, 'ALSO FROM OTHER');
      const res = await svc(tx).folder(user.id, 'crm', 'inbox');
      expect(res.unread).toBe(1);
    });
  });

  it('does not leak the other account through search', async () => {
    await inRollback(async (tx) => {
      const { user } = await twoMailboxes(tx);
      const res = await svc(tx).folder(user.id, 'crm', 'inbox', { q: 'FROM' });
      expect(subjects(res)).toEqual(['FROM DEFAULT']);
    });
  });

  it('does not leak the other account through pagination', async () => {
    // The original defect is most visible deep in a list: page 1 could look right while page 2
    // carried another mailbox's mail.
    await inRollback(async (tx) => {
      const { user, dflt, other } = await twoMailboxes(tx);
      for (let i = 0; i < 60; i += 1) await receive(tx, user.id, i % 2 ? other.id : dflt.id, `BULK ${i}`);

      const seen: number[] = [];
      for (const page of [1, 2, 3]) {
        const res = await svc(tx).folder(user.id, 'crm', 'inbox', { page });
        seen.push(...((res.data ?? []) as { id: number }[]).map((r) => r.id));
      }
      const rows = await tx.inbound_emails.findMany({
        where: { id: { in: seen } }, select: { account_id: true },
      });
      expect([...new Set(rows.map((r) => r.account_id))]).toEqual([dflt.id]);
    });
  });

  it('scopes Sent, Drafts and Trash the same way', async () => {
    /*
     * Account scope has to be consistent across folders. An Inbox showing one mailbox beside a Sent
     * folder showing all of them is its own kind of wrong — the reader cannot tell which messages
     * belong together.
     */
    await inRollback(async (tx) => {
      const { user, dflt, other, theirs } = await twoMailboxes(tx);
      await tx.inbound_emails.update({ where: { id: theirs.id }, data: { deleted_at: new Date() } });
      const now = new Date();
      const rows: [number, string, string][] = [
        [dflt.id, 'SENT DEFAULT', 'sent'], [other.id, 'SENT OTHER', 'sent'],
        [dflt.id, 'DRAFT DEFAULT', 'draft'], [other.id, 'DRAFT OTHER', 'draft'],
      ];
      for (const [accountId, subject, status] of rows) {
        await tx.outbound_emails.create({
          data: {
            user_id: user.id, account_id: accountId, status, subject,
            to_emails: JSON.stringify(['someone@outside.test']),
            sent_at: status === 'sent' ? now : null, created_at: now, updated_at: now,
          },
        });
      }

      const m = svc(tx);
      expect(subjects(await m.folder(user.id, 'crm', 'sent'))).toEqual(['SENT DEFAULT']);
      expect(subjects(await m.folder(user.id, 'crm', 'drafts'))).toEqual(['DRAFT DEFAULT']);
      // The other account's deleted message must not appear in the default mailbox's Trash.
      expect(subjects(await m.folder(user.id, 'crm', 'trash'))).toEqual([]);
    });
  });
});

describe('choosing another mailbox', () => {
  it('shows that account when its id is given', async () => {
    await inRollback(async (tx) => {
      const { user, other } = await twoMailboxes(tx);
      const res = await svc(tx).folder(user.id, 'crm', 'inbox', { accountId: other.id });
      expect(subjects(res)).toEqual(['FROM OTHER']);
      expect((res.mailbox as { address?: string } | null)?.address).toBe('other@spec.test');
    });
  });

  it('refuses an account belonging to somebody else rather than falling back to everything', async () => {
    /*
     * The important half of the switcher. An unrecognised id must resolve to NOTHING — if it fell
     * through to "no explicit choice" it would quietly answer with the caller's own default mailbox,
     * and a probe for a colleague's account id would look indistinguishable from a normal request.
     */
    await inRollback(async (tx) => {
      const { user } = await twoMailboxes(tx);
      const stranger = await makeUser(tx);
      const theirBox = await makeAccount(tx, stranger.id, 'stranger@spec.test', { isDefault: true });
      await receive(tx, stranger.id, theirBox.id, 'NOT YOURS');

      const res = await svc(tx).folder(user.id, 'crm', 'inbox', { accountId: theirBox.id });
      expect(res.data).toEqual([]);
      expect(res.meta).toMatchObject({ total: 0 });
    });
  });

  it('still lets a message from another of your own mailboxes be opened', async () => {
    // Display scope is narrower than ownership scope, deliberately. Reading remains permitted for
    // every account the user owns in this area.
    await inRollback(async (tx) => {
      const { user, theirs } = await twoMailboxes(tx);
      await expect(svc(tx).message(user.id, 'crm', theirs.id)).resolves.toMatchObject({ id: theirs.id });
    });
  });
});

describe('when no account is marked default', () => {
  it('shows ONE mailbox rather than merging them', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const first = await makeAccount(tx, user.id, 'first@spec.test', { isDefault: false });
      const second = await makeAccount(tx, user.id, 'second@spec.test', { isDefault: false });
      await receive(tx, user.id, first.id, 'FROM FIRST');
      await receive(tx, user.id, second.id, 'FROM SECOND');

      const res = await svc(tx).folder(user.id, 'crm', 'inbox');
      expect(subjects(res)).toEqual(['FROM FIRST']);
    });
  });

  it('skips an inactive account when choosing', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const off = await makeAccount(tx, user.id, 'off@spec.test', { isDefault: false, isActive: false });
      const live = await makeAccount(tx, user.id, 'live@spec.test', { isDefault: false });
      await receive(tx, user.id, off.id, 'FROM OFF');
      await receive(tx, user.id, live.id, 'FROM LIVE');

      expect(subjects(await svc(tx).folder(user.id, 'crm', 'inbox'))).toEqual(['FROM LIVE']);
    });
  });

  it('falls back to a default with no area before picking arbitrarily', async () => {
    // Mirrors `sendingAccount`, so what you read and what you send from are the same mailbox.
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const unscoped = await makeAccount(tx, user.id, 'unscoped@spec.test', { isDefault: true, scope: null });
      const scoped = await makeAccount(tx, user.id, 'scoped@spec.test', { isDefault: false, scope: 'crm' });
      await receive(tx, user.id, unscoped.id, 'FROM UNSCOPED');
      await receive(tx, user.id, scoped.id, 'FROM SCOPED');

      expect(subjects(await svc(tx).folder(user.id, 'crm', 'inbox'))).toEqual(['FROM UNSCOPED']);
    });
  });

  it('an empty mailbox list is still an empty answer, not everything', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const res = await svc(tx).folder(user.id, 'crm', 'inbox');
      expect(res.data).toEqual([]);
    });
  });
});

describe('threads stay within one mailbox', () => {
  it('does not merge two accounts copied on the same conversation', async () => {
    /*
     * `thread_key` comes from the mail headers, so two of this user's mailboxes copied on the same
     * exchange carry the SAME key. Gathering every permitted account merged them into one thread,
     * with the same exchange appearing twice under two different addresses.
     */
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const dflt = await makeAccount(tx, user.id, 'default@spec.test', { isDefault: true });
      const other = await makeAccount(tx, user.id, 'other@spec.test');

      const messageId = `<shared-${++seq}@spec.test>`;
      const key = threadKeyFor({ messageId });
      // `threadKeyFor` is nullable by contract — it returns null when a message carries no
      // usable header. This fixture always supplies a message id, so a null here means the
      // helper changed under the test rather than the test being wrong about types.
      if (!key) throw new Error('threadKeyFor returned null for a message that has an id');
      const boxes: [number, string][] = [[dflt.id, 'COPY IN DEFAULT'], [other.id, 'COPY IN OTHER']];
      for (const [accountId, subject] of boxes) {
        await tx.inbound_emails.create({
          data: {
            user_id: user.id, account_id: accountId, uid: ++seq, message_id: `${accountId}${messageId}`,
            from_email: 'sender@outside.test', to_email: 'me@spec.test', subject, snippet: subject,
            body_text: subject, received_at: new Date(), seen: false, thread_key: key,
            created_at: new Date(),
          },
        });
      }

      const res = await svc(tx).thread(user.id, 'crm', key);
      const msgs = (res.messages ?? []) as { subject: string }[];
      expect(msgs.map((m) => m.subject)).toEqual(['COPY IN DEFAULT']);
    });
  });
});

afterAll(async () => { await prisma.$disconnect(); });
