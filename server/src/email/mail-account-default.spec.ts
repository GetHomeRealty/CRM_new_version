import { PrismaClient } from '@prisma/client';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../prisma/prisma.service';
import { LaravelCryptService } from '../common/laravel-crypt.service';
import { MailAccountService } from './mail-account.service';

/**
 * Exactly one account is the primary, within one owner and one area.
 *
 * `setDefault` passed a hardcoded `null` owner to the filter that clears the previous primary, so
 * pointing it at an account belonging to a user left the old primary standing. Two rows then
 * carried `is_default`, and every screen that resolves the primary with `find(a => a.is_default)`
 * kept naming the first one — which is what makes "Set default" look like it does nothing.
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

const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };
// The real crypt service, reading APP_KEY from the environment exactly as the app does — these
// tests store and read account passwords, so a stub would exercise a different code path than
// production. The config stub returns nothing so it falls through to process.env, which is the
// same fallback the service already has.
const crypt = new LaravelCryptService({ get: () => undefined } as unknown as ConfigService);
const svc = (tx: PrismaService) => new MailAccountService(tx, crypt);

async function makeUser(tx: PrismaService): Promise<number> {
  const now = new Date();
  const t = tag();
  const u = await tx.users.create({
    data: { name: `Mail User ${t}`, email: `mail-${t}@example.test`, role: 'agent', status: 'Active', password: 'x', created_at: now, updated_at: now },
  });
  return u.id;
}

async function makeAccount(tx: PrismaService, over: Record<string, unknown>) {
  const now = new Date();
  const t = tag();
  return tx.mail_accounts.create({
    data: {
      name: `acct-${t}`, from_name: 'QA', from_email: `acct-${t}@example.test`,
      host: 'smtp.example.test', port: 587, username: `acct-${t}`, password: 'x',
      encryption: 'tls', is_active: true, is_default: false,      created_at: now, updated_at: now, ...over,
    },
  });
}

const defaultsFor = async (tx: PrismaService, ids: number[]) =>
  (await tx.mail_accounts.findMany({ where: { id: { in: ids }, is_default: true }, select: { id: true } })).map((r) => r.id);

describe('choosing the primary mail account', () => {
  it('clears the previous primary when the accounts belong to a user', async () => {
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      const one = await makeAccount(tx, { user_id: userId, scope: 'crm', is_default: true });
      const two = await makeAccount(tx, { user_id: userId, scope: 'crm' });

      await svc(tx).setDefault(two.id);

      expect(await defaultsFor(tx, [one.id, two.id])).toEqual([two.id]);
    });
  });

  it('still clears the previous primary for brokerage accounts', async () => {
    await inRollback(async (tx) => {
      const one = await makeAccount(tx, { user_id: null, scope: 'crm', is_default: true });
      const two = await makeAccount(tx, { user_id: null, scope: 'crm' });

      await svc(tx).setDefault(two.id);

      expect(await defaultsFor(tx, [one.id, two.id])).toEqual([two.id]);
    });
  });

  it('leaves the other area alone', async () => {
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      const crm = await makeAccount(tx, { user_id: userId, scope: 'crm', is_default: true });
      const desk = await makeAccount(tx, { user_id: userId, scope: 'desk', is_default: true });
      const desk2 = await makeAccount(tx, { user_id: userId, scope: 'desk' });

      await svc(tx).setDefault(desk2.id);

      const left = await defaultsFor(tx, [crm.id, desk.id, desk2.id]);
      expect(left).toContain(crm.id);     // the CRM primary is untouched
      expect(left).toContain(desk2.id);   // the new Desk primary
      expect(left).not.toContain(desk.id);
      expect(left).toHaveLength(2);
    });
  });

  it('does not disturb another user\'s primary in the same area', async () => {
    await inRollback(async (tx) => {
      const mine = await makeUser(tx);
      const theirs = await makeUser(tx);
      const theirDefault = await makeAccount(tx, { user_id: theirs, scope: 'crm', is_default: true });
      const myOne = await makeAccount(tx, { user_id: mine, scope: 'crm', is_default: true });
      const myTwo = await makeAccount(tx, { user_id: mine, scope: 'crm' });

      await svc(tx).setDefault(myTwo.id);

      const left = await defaultsFor(tx, [theirDefault.id, myOne.id, myTwo.id]);
      expect(left).toContain(theirDefault.id);
      expect(left).toContain(myTwo.id);
      expect(left).not.toContain(myOne.id);
    });
  });

  it('does not disturb the brokerage fallback when a user picks their own', async () => {
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      const brokerage = await makeAccount(tx, { user_id: null, scope: 'crm', is_default: true });
      const personal = await makeAccount(tx, { user_id: userId, scope: 'crm' });

      await svc(tx).setDefault(personal.id);

      const left = await defaultsFor(tx, [brokerage.id, personal.id]);
      expect(left).toContain(brokerage.id);
      expect(left).toContain(personal.id);
    });
  });
});

afterAll(async () => { await prisma.$disconnect(); });
