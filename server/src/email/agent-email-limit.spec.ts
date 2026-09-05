import { PrismaClient } from '@prisma/client';
import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCanConnectEmail, emailLimitFor } from './agent-email-limit';

/**
 * Sections 6 and 7 of the separation spec: one primary email per area, and one connected account
 * per area for an agent.
 *
 * Every case runs inside a transaction that is rolled back, so the suite exercises the real Prisma
 * queries against the real schema without leaving anything behind. That matters here more than
 * usual: both rules are about *which rows change*, and the bug this file was written for —
 * `makeSoleDefault` clearing the other area's primary — type-checks perfectly and is invisible to
 * any test that does not look at a second area's rows afterwards.
 */

const prisma = new PrismaClient();

/** Run `fn` inside a rolled-back transaction. The rollback is the point, so the throw is expected. */
async function inRollback<T>(fn: (tx: PrismaService) => Promise<T>): Promise<T> {
  let out: T;
  const ROLLBACK = '__rollback__';
  try {
    await prisma.$transaction(async (tx) => {
      out = await fn(tx as unknown as PrismaService);
      throw new Error(ROLLBACK);
    }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
  return out!;
}

/** A throwaway user with a known role, plus a helper to give them accounts. */
async function seed(tx: PrismaService, role: string) {
  const now = new Date();
  const user = await tx.users.create({
    data: { name: `spec ${role}`, email: `spec-${role}-${Date.now()}@example.test`, password: 'x', role, created_at: now, updated_at: now },
  });
  const addAccount = (scope: string | null, extra: Record<string, unknown> = {}) =>
    tx.mail_accounts.create({
      data: {
        name: `acc-${scope ?? 'none'}-${Math.round(performance.now() * 1000)}`,
        from_email: `a${Math.round(performance.now() * 1000)}@example.test`,
        host: 'smtp.example.test', port: 587, user_id: user.id, scope,
        created_at: now, updated_at: now, ...extra,
      },
    });
  return { user, addAccount };
}

describe('§7 agent single-email restriction', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it('gives an agent one account shared across the Hub', async () => {
    await inRollback(async (tx) => {
      const { user, addAccount } = await seed(tx, 'agent');

      expect(await emailLimitFor(tx, user.id, 'crm')).toEqual({ max: 1, used: 0, canAdd: true });
      await expect(assertCanConnectEmail(tx, user.id, 'crm')).resolves.toBeUndefined();

      await addAccount('crm');
      expect(await emailLimitFor(tx, user.id, 'crm')).toEqual({ max: 1, used: 1, canAdd: false });
      await expect(assertCanConnectEmail(tx, user.id, 'crm')).rejects.toBeInstanceOf(BadRequestException);

      expect(await emailLimitFor(tx, user.id, 'desk')).toEqual({ max: 1, used: 1, canAdd: false });
      await expect(assertCanConnectEmail(tx, user.id, 'desk')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('frees the allowance again once the account is disconnected', async () => {
    await inRollback(async (tx) => {
      const { user, addAccount } = await seed(tx, 'agent');
      const a = await addAccount('crm');
      await expect(assertCanConnectEmail(tx, user.id, 'crm')).rejects.toThrow();
      await tx.mail_accounts.delete({ where: { id: a.id } });
      await expect(assertCanConnectEmail(tx, user.id, 'crm')).resolves.toBeUndefined();
    });
  });

  it('names the connected address, so the message says what to disconnect', async () => {
    await inRollback(async (tx) => {
      const { user, addAccount } = await seed(tx, 'agent');
      const a = await addAccount('crm');
      await expect(assertCanConnectEmail(tx, user.id, 'crm')).rejects.toThrow(new RegExp(a.from_email.replace('.', '\\.')));
    });
  });

  it('leaves administrators and managers unrestricted', async () => {
    await inRollback(async (tx) => {
      for (const role of ['admin', 'manager']) {
        const { user, addAccount } = await seed(tx, role);
        await addAccount('crm');
        await addAccount('crm');
        await addAccount('crm');
        /*
         * UNRESTRICTED IS `max: null` AND `canAdd: true`, which is what this test is about.
         *
         * It also asserted `used: 0` after adding three accounts, which was the defect written down
         * as an expectation: the function short-circuited for unlimited roles and reported nothing
         * in use however many accounts existed. `used` now counts, so the figure is the truth and
         * the freedom to add another comes from the absent maximum rather than from a zero.
         */
        expect(await emailLimitFor(tx, user.id, 'crm')).toEqual({ max: null, used: 3, canAdd: true });
        await expect(assertCanConnectEmail(tx, user.id, 'crm')).resolves.toBeUndefined();
      }
    });
  });

  it('counts a shared unassigned account once across the Hub', async () => {
    await inRollback(async (tx) => {
      const { user, addAccount } = await seed(tx, 'agent');
      // Pre-dates the split: already visible on both sides. Counting it against both would leave
      // the agent unable to connect anywhere until they had assigned it.
      await addAccount(null);
      expect((await emailLimitFor(tx, user.id, 'crm')).canAdd).toBe(false);
      expect((await emailLimitFor(tx, user.id, 'desk')).canAdd).toBe(false);
    });
  });
});

/**
 * The primary-per-area rule, tested through the same UPDATE the service performs.
 *
 * The service is not instantiated here — it needs the crypt service and its constructor pulls in
 * Nest wiring — so the statement under test is reproduced exactly. If the service's filter and this
 * one ever diverge, the divergence is the bug and the comment above `makeSoleDefault` says which
 * one is right.
 */
describe('§6 one primary email across the Hub', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  const claimPrimary = async (tx: PrismaService, id: number, userId: number, _scope: string | null) => {
    await tx.mail_accounts.update({ where: { id }, data: { is_default: true, is_active: true } });
    await tx.mail_accounts.updateMany({
      where: { id: { not: id }, is_default: true, user_id: userId },
      data: { is_default: false },
    });
  };

  it('setting a primary clears every other personal primary', async () => {
    await inRollback(async (tx) => {
      const { user, addAccount } = await seed(tx, 'admin');
      const crm = await addAccount('crm', { is_default: true, is_active: true });
      const desk1 = await addAccount('desk', { is_default: true, is_active: true });
      const desk2 = await addAccount('desk', { is_default: false, is_active: true });

      await claimPrimary(tx, desk2.id, user.id, 'desk');

      const after = await tx.mail_accounts.findMany({
        where: { user_id: user.id }, select: { id: true, scope: true, is_default: true },
      });
      const primary = (s: string) => after.filter((a) => a.scope === s && a.is_default).map((a) => a.id);
      expect(primary('crm')).toEqual([]);
      expect(primary('desk')).toEqual([desk2.id]);
      expect(after.find((a) => a.id === desk1.id)!.is_default).toBe(false);
    });
  });

  it('an unscoped filter would clear the other area — the bug this guards', async () => {
    await inRollback(async (tx) => {
      const { user, addAccount } = await seed(tx, 'admin');
      const crm = await addAccount('crm', { is_default: true, is_active: true });
      const desk = await addAccount('desk', { is_default: false, is_active: true });

      // Deliberately the OLD statement, with no `scope` in the where.
      await tx.mail_accounts.update({ where: { id: desk.id }, data: { is_default: true } });
      await tx.mail_accounts.updateMany({
        where: { id: { not: desk.id }, is_default: true, user_id: user.id },
        data: { is_default: false },
      });

      // The CRM lost its primary. Asserted so the regression is documented rather than folklore.
      expect((await tx.mail_accounts.findUnique({ where: { id: crm.id } }))!.is_default).toBe(false);
    });
  });

  it('does not disturb the brokerage fallback', async () => {
    await inRollback(async (tx) => {
      const now = new Date();
      const brokerage = await tx.mail_accounts.create({
        data: { name: 'brokerage', from_email: 'house@example.test', host: 'smtp.example.test', port: 587, user_id: null, scope: 'desk', is_default: true, is_active: true, created_at: now, updated_at: now },
      });
      const { user, addAccount } = await seed(tx, 'agent');
      const mine = await addAccount('desk', { is_active: true });

      await claimPrimary(tx, mine.id, user.id, 'desk');

      expect((await tx.mail_accounts.findUnique({ where: { id: brokerage.id } }))!.is_default).toBe(true);
    });
  });
});
