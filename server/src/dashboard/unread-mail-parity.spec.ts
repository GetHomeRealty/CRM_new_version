import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { AreaDashboardService } from './area-dashboard.service';
import { PermissionService } from '../auth/permission.service';
import { MailboxService } from '../inbox/mailbox.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * The "unread mail" card must show a number the Inbox can actually produce.
 *
 * THE DEFECT, measured on real data rather than imagined. The card counted every unread
 * `inbound_emails` row whose account was CRM-scoped. The Inbox screen shows ONE mailbox — the
 * active default — and only mail still in the inbox folder. For user 10108 the card read **416**
 * while the Inbox held **50**; the missing **366** sat in a mailbox that was non-default AND
 * `is_active = false`, which the account switcher will not offer and the default lookup will not
 * choose. The number could not be reached by clicking it. Another user's card read 1,428 against an
 * Inbox showing nothing at all, their only account being disabled.
 *
 * WHY THIS FILE ASSERTS EQUALITY RATHER THAN A LITERAL. Both sides now resolve through
 * `mailbox-scope.ts`, so the guarantee worth defending is that they AGREE — not that either equals
 * some number written here. A future change to what "the Inbox shows" should move both together;
 * these tests fail the moment it moves only one. A test asserting `toBe(50)` would have passed
 * happily while the card and the screen disagreed, which is exactly how this got shipped.
 *
 * Every case runs inside a rolled-back transaction, so nothing here touches real data.
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
afterAll(async () => { await prisma.$disconnect(); });

const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };

/** The card. */
const cardUnread = async (tx: PrismaService, user: AuthUserRecord): Promise<number> =>
  (await new AreaDashboardService(tx, new PermissionService()).crm(user)).inbox.unread;

/**
 * What the Inbox screen itself reports, through the real service — not a re-query.
 *
 * `MailerService` is stubbed inert: this file is about which rows are counted, and nothing here
 * should reach a mail server.
 */
const inboxUnread = async (tx: PrismaService, user: AuthUserRecord): Promise<number> => {
  const svc = new MailboxService(tx, { sendDirect: async () => undefined } as never);
  const page = await svc.folder(user.id, 'crm', 'inbox', {});
  return Number((page as { meta: { unread?: number }; unread?: number }).unread
    ?? (page as { meta: { unread?: number } }).meta?.unread ?? 0);
};

async function makeUser(tx: PrismaService): Promise<AuthUserRecord> {
  const now = new Date();
  const t = tag();
  const u = await tx.users.create({
    data: { name: `Unread ${t}`, email: `unread-${t}@example.test`, role: 'agent', status: 'Active', password: 'x', created_at: now, updated_at: now },
  });
  return u as unknown as AuthUserRecord;
}

async function makeAccount(
  tx: PrismaService,
  userId: number,
  over: { is_default?: boolean; is_active?: boolean; scope?: string | null } = {},
) {
  const now = new Date();
  const t = tag();
  return tx.mail_accounts.create({
    data: {
      name: `MB ${t}`, from_email: `mb-${t}@example.test`, username: `mb-${t}@example.test`,
      host: 'smtp.example.test', port: 587, encryption: 'tls',
      user_id: userId, scope: over.scope === undefined ? 'crm' : over.scope,
      is_default: over.is_default ?? false,
      is_active: over.is_active ?? true,
      created_at: now, updated_at: now,
    },
  });
}

/** One received message. `state` places it in the inbox, the archive or the trash. */
async function makeMail(
  tx: PrismaService,
  userId: number,
  accountId: number,
  opts: { seen?: boolean; state?: 'inbox' | 'archived' | 'trashed' } = {},
) {
  const now = new Date();
  const t = tag();
  return tx.inbound_emails.create({
    data: {
      user_id: userId, account_id: accountId,
      // IMAP UID — unique per account in reality; the sequence keeps them distinct here.
      uid: (seq += 1),
      message_id: `<${t}@example.test>`, subject: `Msg ${t}`,
      from_email: `sender-${t}@example.test`, body_text: 'x',
      received_at: now, seen: opts.seen ?? false,
      archived_at: opts.state === 'archived' ? now : null,
      deleted_at: opts.state === 'trashed' ? now : null,
      created_at: now,
    },
  });
}

// =================================================================================================

describe('the card and the Inbox agree', () => {
  it('counts unread in the active default mailbox, and the two match', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const mb = await makeAccount(tx, user.id, { is_default: true, is_active: true });
      for (let i = 0; i < 4; i += 1) await makeMail(tx, user.id, mb.id, { seen: false });
      await makeMail(tx, user.id, mb.id, { seen: true });   // read — counted by neither

      expect(await cardUnread(tx, user)).toBe(4);
      expect(await inboxUnread(tx, user)).toBe(4);
    });
  });

  it('REPRODUCES THE DEFECT: a disabled second mailbox does not inflate the card', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      // The shape found on real data — user 10108, scaled down.
      const primary = await makeAccount(tx, user.id, { is_default: true, is_active: true });
      const disabled = await makeAccount(tx, user.id, { is_default: false, is_active: false });

      for (let i = 0; i < 5; i += 1) await makeMail(tx, user.id, primary.id, { seen: false });
      for (let i = 0; i < 36; i += 1) await makeMail(tx, user.id, disabled.id, { seen: false });

      // Before the fix this read 41. The 36 belong to a mailbox nothing in the UI can open.
      expect(await cardUnread(tx, user)).toBe(5);
      expect(await inboxUnread(tx, user)).toBe(5);
    });
  });

  it('ignores a disabled mailbox even when it is the one marked default', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      // `is_default` alone is not enough — the default lookups all require `is_active: true`.
      const deadDefault = await makeAccount(tx, user.id, { is_default: true, is_active: false });
      const live = await makeAccount(tx, user.id, { is_default: false, is_active: true });

      for (let i = 0; i < 7; i += 1) await makeMail(tx, user.id, deadDefault.id, { seen: false });
      for (let i = 0; i < 2; i += 1) await makeMail(tx, user.id, live.id, { seen: false });

      // Falls through to the first ACTIVE account, which is what the Inbox opens on.
      expect(await cardUnread(tx, user)).toBe(2);
      expect(await inboxUnread(tx, user)).toBe(2);
    });
  });

  it('reports 0 — not the disabled mailbox\'s backlog — when every account is disabled', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const off = await makeAccount(tx, user.id, { is_default: true, is_active: false });
      for (let i = 0; i < 9; i += 1) await makeMail(tx, user.id, off.id, { seen: false });

      // The case that read 1,428 for a user whose Inbox showed nothing at all.
      expect(await cardUnread(tx, user)).toBe(0);
      expect(await inboxUnread(tx, user)).toBe(0);
    });
  });

  it('reports 0 when the user has no mailbox at all', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      expect(await cardUnread(tx, user)).toBe(0);
      expect(await inboxUnread(tx, user)).toBe(0);
    });
  });
});

describe('the folder matters, not just the mailbox', () => {
  it('excludes archived and trashed unread, which the Inbox does not list', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const mb = await makeAccount(tx, user.id, { is_default: true, is_active: true });

      for (let i = 0; i < 3; i += 1) await makeMail(tx, user.id, mb.id, { seen: false });
      await makeMail(tx, user.id, mb.id, { seen: false, state: 'archived' });
      await makeMail(tx, user.id, mb.id, { seen: false, state: 'trashed' });

      expect(await cardUnread(tx, user)).toBe(3);
      expect(await inboxUnread(tx, user)).toBe(3);
    });
  });
});

describe('scoping that must not regress', () => {
  it('never counts another user\'s unread mail', async () => {
    await inRollback(async (tx) => {
      const mine = await makeUser(tx);
      const theirs = await makeUser(tx);
      const myBox = await makeAccount(tx, mine.id, { is_default: true, is_active: true });
      const theirBox = await makeAccount(tx, theirs.id, { is_default: true, is_active: true });

      await makeMail(tx, mine.id, myBox.id, { seen: false });
      for (let i = 0; i < 6; i += 1) await makeMail(tx, theirs.id, theirBox.id, { seen: false });

      expect(await cardUnread(tx, mine)).toBe(1);
      expect(await cardUnread(tx, theirs)).toBe(6);
    });
  });

  it('leaves a Transaction Desk mailbox out of the CRM card', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const crm = await makeAccount(tx, user.id, { is_default: true, is_active: true, scope: 'crm' });
      const desk = await makeAccount(tx, user.id, { is_default: true, is_active: true, scope: 'desk' });

      await makeMail(tx, user.id, crm.id, { seen: false });
      for (let i = 0; i < 4; i += 1) await makeMail(tx, user.id, desk.id, { seen: false });

      expect(await cardUnread(tx, user)).toBe(1);
    });
  });

  it('counts a mailbox that pre-dates the CRM/Desk split (scope NULL)', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const legacy = await makeAccount(tx, user.id, { is_default: true, is_active: true, scope: null });
      for (let i = 0; i < 3; i += 1) await makeMail(tx, user.id, legacy.id, { seen: false });

      expect(await cardUnread(tx, user)).toBe(3);
      expect(await inboxUnread(tx, user)).toBe(3);
    });
  });
});

describe('counting only', () => {
  it('reading the card removes nothing and marks nothing read', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const primary = await makeAccount(tx, user.id, { is_default: true, is_active: true });
      const disabled = await makeAccount(tx, user.id, { is_default: false, is_active: false });
      await makeMail(tx, user.id, primary.id, { seen: false });
      const excluded = await makeMail(tx, user.id, disabled.id, { seen: false });
      const archived = await makeMail(tx, user.id, primary.id, { seen: false, state: 'archived' });

      const before = await tx.inbound_emails.count({ where: { user_id: user.id } });
      await cardUnread(tx, user);
      const after = await tx.inbound_emails.count({ where: { user_id: user.id } });

      expect(after).toBe(before);
      /*
       * The point of the requirement: mail dropped from the COUNT is still a row, still unread and
       * still readable. Excluding the disabled mailbox from a tile is a display decision, and it
       * must never look like a deletion.
       */
      const still = await tx.inbound_emails.findUnique({ where: { id: excluded.id } });
      expect(still).not.toBeNull();
      expect(still!.seen).toBe(false);
      expect((await tx.inbound_emails.findUnique({ where: { id: archived.id } }))!.seen).toBe(false);
    });
  });
});
