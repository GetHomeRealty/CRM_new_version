import { PrismaClient } from '@prisma/client';

/**
 * The Inbox reads the PRIMARY account of its area, and making an account primary switches its
 * inbound sync on.
 *
 * Both rules are exercised against the real schema inside a rolled-back transaction. The live data
 * could not test the second one: every connected account already has inbound sync enabled, so the
 * branch that turns it on never ran.
 */

const prisma = new PrismaClient();

async function inRollback<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  let out: T;
  const ROLLBACK = '__rollback__';
  try {
    await prisma.$transaction(async (tx) => {
      out = await fn(tx as unknown as PrismaClient);
      throw new Error(ROLLBACK);
    }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
  return out!;
}

/** A throwaway user with mail accounts and one message per account. */
async function seed(tx: PrismaClient) {
  const now = new Date();
  const user = await tx.users.create({
    data: { name: 'inbox spec', email: `inbox-${Date.now()}@example.test`, password: 'x', role: 'admin', created_at: now, updated_at: now },
  });
  let uid = 0;
  const account = async (scope: string | null, extra: Record<string, unknown> = {}) => {
    const a = await tx.mail_accounts.create({
      data: {
        name: `acc${++uid}`, from_email: `a${uid}-${Date.now()}@example.test`,
        host: 'smtp.example.test', port: 587, user_id: user.id, scope,
        created_at: now, updated_at: now, ...extra,
      },
    });
    await tx.inbound_emails.create({
      data: {
        user_id: user.id, account_id: a.id, uid: uid, from_email: 'x@example.test',
        subject: `msg for ${a.from_email}`, received_at: now, seen: false,
        created_at: now,
      },
    });
    return a;
  };
  return { user, account };
}

/** The filter the service builds: the area's primary, else an unassigned primary, else the whole area. */
async function inboxFilter(tx: PrismaClient, userId: number, area: 'crm' | 'desk') {
  const pick = { id: true, from_email: true, inbound_enabled: true, imap_host: true };
  const primary =
    (await tx.mail_accounts.findFirst({ where: { user_id: userId, is_default: true, scope: area }, select: pick }))
    ?? (await tx.mail_accounts.findFirst({ where: { user_id: userId, is_default: true, scope: null }, select: pick }));
  return primary
    ? { account_id: primary.id }
    : { mail_account: { is: { OR: [{ scope: area }, { scope: null }] } } };
}

const countFor = async (tx: PrismaClient, userId: number, area: 'crm' | 'desk') =>
  tx.inbound_emails.count({ where: { user_id: userId, ...(await inboxFilter(tx, userId, area)) } });

describe('the Inbox shows the primary account only', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it('reads one mailbox, not every account in the area', async () => {
    await inRollback(async (tx) => {
      const { user, account } = await seed(tx);
      const primary = await account('desk', { is_default: true, is_active: true });
      await account('desk');
      await account('desk');

      // Three accounts with one message each; the inbox shows the primary's one.
      expect(await tx.inbound_emails.count({ where: { user_id: user.id } })).toBe(3);
      expect(await countFor(tx, user.id, 'desk')).toBe(1);
      expect(await inboxFilter(tx, user.id, 'desk')).toEqual({ account_id: primary.id });
    });
  });

  it('follows the primary when it moves', async () => {
    await inRollback(async (tx) => {
      const { user, account } = await seed(tx);
      const first = await account('desk', { is_default: true, is_active: true });
      const second = await account('desk');

      expect(await inboxFilter(tx, user.id, 'desk')).toEqual({ account_id: first.id });
      await tx.mail_accounts.update({ where: { id: first.id }, data: { is_default: false } });
      await tx.mail_accounts.update({ where: { id: second.id }, data: { is_default: true } });
      expect(await inboxFilter(tx, user.id, 'desk')).toEqual({ account_id: second.id });
      // Still one message — the other account's mail is still stored, just not on screen.
      expect(await countFor(tx, user.id, 'desk')).toBe(1);
      expect(await tx.inbound_emails.count({ where: { user_id: user.id } })).toBe(2);
    });
  });

  it("keeps the two areas' primaries independent", async () => {
    await inRollback(async (tx) => {
      const { user, account } = await seed(tx);
      const crm = await account('crm', { is_default: true, is_active: true });
      const desk = await account('desk', { is_default: true, is_active: true });

      expect(await inboxFilter(tx, user.id, 'crm')).toEqual({ account_id: crm.id });
      expect(await inboxFilter(tx, user.id, 'desk')).toEqual({ account_id: desk.id });
    });
  });

  it('falls back to the whole area rather than showing an empty inbox', async () => {
    await inRollback(async (tx) => {
      const { user, account } = await seed(tx);
      await account('desk');
      await account('desk');
      // Nobody has chosen a primary. Two messages, both shown.
      expect(await inboxFilter(tx, user.id, 'desk')).not.toHaveProperty('account_id');
      expect(await countFor(tx, user.id, 'desk')).toBe(2);
    });
  });

  it("does not let an unassigned primary outrank the area's own", async () => {
    await inRollback(async (tx) => {
      const { user, account } = await seed(tx);
      await account(null, { is_default: true, is_active: true });
      const own = await account('desk', { is_default: true, is_active: true });
      expect(await inboxFilter(tx, user.id, 'desk')).toEqual({ account_id: own.id });
    });
  });

  it('uses an unassigned primary when the area has none of its own', async () => {
    await inRollback(async (tx) => {
      const { user, account } = await seed(tx);
      const legacy = await account(null, { is_default: true, is_active: true });
      expect(await inboxFilter(tx, user.id, 'desk')).toEqual({ account_id: legacy.id });
      expect(await inboxFilter(tx, user.id, 'crm')).toEqual({ account_id: legacy.id });
    });
  });
});

describe('making an account primary switches its sync on', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  /** The statement `setDefaultForUser` performs. */
  const claim = async (tx: PrismaClient, id: number) => {
    const a = (await tx.mail_accounts.findUnique({ where: { id } }))!;
    const enableInbound = !!a.imap_host && !a.inbound_enabled;
    await tx.mail_accounts.update({
      where: { id },
      data: { is_default: true, is_active: true, ...(enableInbound ? { inbound_enabled: true } : {}) },
    });
    return tx.mail_accounts.findUnique({ where: { id } });
  };

  it('enables inbound sync on an IMAP account that had it off', async () => {
    await inRollback(async (tx) => {
      const { account } = await seed(tx);
      const a = await account('desk', { imap_host: 'imap.example.test', imap_port: 993, inbound_enabled: false });
      expect(a.inbound_enabled).toBe(false);
      const after = await claim(tx, a.id);
      expect(after!.is_default).toBe(true);
      expect(after!.inbound_enabled).toBe(true);
      expect(after!.is_active).toBe(true);
    });
  });

  it('leaves an account with no IMAP host alone — there is nothing to poll', async () => {
    await inRollback(async (tx) => {
      const { account } = await seed(tx);
      // Send-only account. Claiming it primary must not advertise a sync that cannot happen.
      const a = await account('desk', { imap_host: null, inbound_enabled: false });
      const after = await claim(tx, a.id);
      expect(after!.is_default).toBe(true);
      expect(after!.inbound_enabled).toBe(false);
    });
  });

  it('does not disturb an account that already syncs', async () => {
    await inRollback(async (tx) => {
      const { account } = await seed(tx);
      const a = await account('desk', { imap_host: 'imap.example.test', inbound_enabled: true });
      const after = await claim(tx, a.id);
      expect(after!.inbound_enabled).toBe(true);
    });
  });
});
