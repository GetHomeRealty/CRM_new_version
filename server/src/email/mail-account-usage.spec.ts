import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { emailLimitFor, assertCanConnectEmail } from './agent-email-limit';

/**
 * CRM-018: the mail-account usage figure has to be the number of accounts in use.
 *
 * WHAT WAS WRONG. `emailLimitFor` short-circuited for any role without a limit and returned
 * `used: 0` without counting, so an administrator with two CRM accounts and two Desk accounts was
 * told none were in use - at every scope.
 *
 * WHAT WAS NOT WRONG, stated exactly, because the report's premise was partly mistaken and the
 * correction matters to whoever reads this next: nothing was ever wrongly allowed or refused. The
 * short-circuit only ran when `max` was null, and with no maximum `canAdd` is true whatever `used`
 * says. The tester's worry - "if a limit were ever set, a usage stuck at zero would mean it never
 * bit" - could not happen: setting a limit makes `max` non-null, which is precisely the branch that
 * always counted.
 *
 * SO THE FIX IS TO COUNT, NOT TO DELETE. Its sibling CRM-014 removed a wrong figure because a
 * second answer to a question already answered elsewhere is a liability. This one is the only
 * answer to its question, and `canAdd` is derived from it, so it earns its place by being right.
 *
 * THE LIMIT IS PER AREA, which the original report got wrong and corrected: a role permitting one
 * account allows one for the CRM and one for the Transaction Desk, not one in total.
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

async function makeUser(tx: PrismaService, role: string) {
  const t = tag();
  const now = new Date();
  return tx.users.create({
    data: {
      name: `ZZ Limit ${t}`, email: `zz-limit-${t}@probe.test`, username: `zzlimit${t.replace(/-/g, '')}`,
      role, status: 'Active', password: 'x', created_at: now, updated_at: now,
    },
    select: { id: true },
  });
}

async function makeAccount(tx: PrismaService, userId: number, scope: string | null) {
  const t = tag();
  const now = new Date();
  return tx.mail_accounts.create({
    data: {
      user_id: userId, name: `ZZ acct ${t}`, from_email: `zz-acct-${t}@probe.test`,
      host: 'smtp.probe.test', port: 587, username: 'u', password: 'p',
      is_active: true, scope, created_at: now, updated_at: now,
    },
  });
}

describe('the mail-account usage figure', () => {
  it('counts the accounts an unlimited role actually has', async () => {
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin');
      await makeAccount(tx, admin.id, 'crm');
      await makeAccount(tx, admin.id, 'crm');
      await makeAccount(tx, admin.id, 'desk');

      // THE DEFECT: this read 0 at every scope.
      expect((await emailLimitFor(tx, admin.id, 'crm')).used).toBe(2);
      expect((await emailLimitFor(tx, admin.id, 'desk')).used).toBe(1);
    });
  });

  it('still lets an unlimited role add another', async () => {
    // The figure became truthful; it must not have become a ceiling.
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin');
      await makeAccount(tx, admin.id, 'crm');
      await makeAccount(tx, admin.id, 'crm');

      const limit = await emailLimitFor(tx, admin.id, 'crm');
      expect(limit.max).toBeNull();
      expect(limit.canAdd).toBe(true);
      await expect(assertCanConnectEmail(tx, admin.id, 'crm')).resolves.toBeUndefined();
    });
  });

  it('still enforces the limit on a role that has one', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx, 'agent');
      expect(await emailLimitFor(tx, agent.id, 'crm')).toMatchObject({ max: 1, used: 0, canAdd: true });

      await makeAccount(tx, agent.id, 'crm');
      expect(await emailLimitFor(tx, agent.id, 'crm')).toMatchObject({ max: 1, used: 1, canAdd: false });
      await expect(assertCanConnectEmail(tx, agent.id, 'crm')).rejects.toThrow();
    });
  });

  it('keeps the two areas independent', async () => {
    // One CRM account must not spend the Transaction Desk's allowance.
    await inRollback(async (tx) => {
      const agent = await makeUser(tx, 'agent');
      await makeAccount(tx, agent.id, 'crm');

      expect((await emailLimitFor(tx, agent.id, 'crm')).canAdd).toBe(false);
      expect((await emailLimitFor(tx, agent.id, 'desk')).canAdd).toBe(true);
    });
  });

  it('does not count an unscoped account against either area', async () => {
    // It pre-dates the split and shows on both sides; counting it twice would strand the agent.
    await inRollback(async (tx) => {
      const agent = await makeUser(tx, 'agent');
      await makeAccount(tx, agent.id, null);

      expect((await emailLimitFor(tx, agent.id, 'crm')).used).toBe(0);
      expect((await emailLimitFor(tx, agent.id, 'desk')).used).toBe(0);
    });
  });
});
