import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { MailAccountService } from './mail-account.service';

/**
 * CRM-036: connecting a mailbox must not silently re-point where mail is sent from.
 *
 * THE AUDIT'S OPEN QUESTION, WHICH IT COULD NOT ANSWER FROM OUTSIDE. It established from the
 * shipped bundle that the Add form hard-codes `is_default: true`, and said the severity depended on
 * something the code had to settle: whether one person adding an account displaces the BROKERAGE's
 * sender or only their own. It is only their own — `makeSoleDefault` clears the previous default
 * where `user_id` AND `scope` both match, so it cannot reach a colleague's account or the
 * brokerage mailbox (`user_id: null`).
 *
 * THAT BOUNDARY IS WHAT THESE TESTS PIN, because it is the whole of the severity. The form now
 * asks before setting the default; if this scoping ever widened, that question would become the
 * wrong one to ask, and the fix on the screen would be worth nothing.
 *
 * THE FIRST ACCOUNT IN AN AREA IS STILL PROMOTED AUTOMATICALLY, so an area never ends up with no
 * sender — which is why leaving the new checkbox unticked is safe rather than a way to break
 * sending.
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

function svc(tx: PrismaService) {
  // Only the crypt dependency is reached, and only when a password is supplied.
  return new MailAccountService(tx, { encryptString: (v: string) => v } as never);
}

async function makeUser(tx: PrismaService) {
  const t = tag();
  const now = new Date();
  return tx.users.create({
    data: {
      name: `ZZ Mail ${t}`, email: `zz-mail-${t}@probe.invalid`, username: `zzmail${t.replace(/-/g, '')}`,
      // ADMIN, not agent: an agent may hold one account per area (CRM-018), so the cases below
      // that add a SECOND one would be refused by that limit rather than exercising the default.
      role: 'admin', status: 'Active', password: 'x', created_at: now, updated_at: now,
    },
    select: { id: true },
  });
}

async function addAccount(tx: PrismaService, userId: number, scope: 'crm' | 'desk', isDefault: boolean) {
  const t = tag();
  return svc(tx).storeForUser(userId, {
    name: `ZZ acct ${t}`, from_email: `zz-acct-${t}@probe.invalid`, username: 'u', password: 'p',
    host: 'smtp.probe.invalid', port: 587, encryption: 'tls', is_default: isDefault,
  }, scope) as Promise<{ id: number }>;
}

const defaultsOf = (tx: PrismaService, userId: number, scope: string) =>
  tx.mail_accounts.findMany({ where: { user_id: userId, scope, is_default: true }, select: { id: true } });

describe('adding a mailbox changes only this person’s sender', () => {
  it('promotes the first account in an area even when not asked to', async () => {
    // Otherwise unticking the new checkbox would leave the area with no sender at all.
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const first = await addAccount(tx, user.id, 'crm', false);
      expect((await defaultsOf(tx, user.id, 'crm')).map((a) => a.id)).toEqual([first.id]);
    });
  });

  it('leaves the existing default alone when the second is added without asking for it', async () => {
    // THE DEFECT: the form sent `is_default: true` regardless, so this silently moved.
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const first = await addAccount(tx, user.id, 'crm', false);
      await addAccount(tx, user.id, 'crm', false);
      expect((await defaultsOf(tx, user.id, 'crm')).map((a) => a.id)).toEqual([first.id]);
    });
  });

  it('moves the default when that IS what was asked for', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      await addAccount(tx, user.id, 'crm', false);
      const second = await addAccount(tx, user.id, 'crm', true);
      expect((await defaultsOf(tx, user.id, 'crm')).map((a) => a.id)).toEqual([second.id]);
    });
  });

  it('cannot displace another user’s default', async () => {
    // The audit's open question, settled: the blast radius is one person.
    await inRollback(async (tx) => {
      const mine = await makeUser(tx);
      const theirs = await makeUser(tx);
      const theirAccount = await addAccount(tx, theirs.id, 'crm', true);

      await addAccount(tx, mine.id, 'crm', true);

      expect((await defaultsOf(tx, theirs.id, 'crm')).map((a) => a.id)).toEqual([theirAccount.id]);
    });
  });

  it('cannot displace the brokerage mailbox', async () => {
    await inRollback(async (tx) => {
      const now = new Date();
      const brokerage = await tx.mail_accounts.create({
        data: {
          user_id: null, scope: 'crm', is_default: true, is_active: true,
          name: 'ZZ brokerage', from_email: `zz-brokerage-${tag()}@probe.invalid`,
          host: 'smtp.probe.invalid', port: 587, username: 'u', password: 'p',
          created_at: now, updated_at: now,
        },
      });
      const user = await makeUser(tx);
      await addAccount(tx, user.id, 'crm', true);

      const still = await tx.mail_accounts.findUnique({ where: { id: brokerage.id }, select: { is_default: true } });
      expect(still?.is_default).toBe(true);
    });
  });

  it('keeps the two areas independent', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const crm = await addAccount(tx, user.id, 'crm', true);
      await addAccount(tx, user.id, 'desk', true);
      expect((await defaultsOf(tx, user.id, 'crm')).map((a) => a.id)).toEqual([crm.id]);
    });
  });
});
