import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { GmailConnectService } from './gmail-connect.service';
import { LaravelCryptService } from '../common/laravel-crypt.service';

/**
 * Connecting a Google account that is NOT on the brokerage's Workspace domain.
 *
 * WHY THIS SUITE EXISTS. An agent connecting a personal Gmail was stopped by Google with
 * "Access blocked: Get Home Realty can only be used within its organization", `Error 403:
 * org_internal`. That refusal comes from the OAuth consent screen's User Type in the Google Cloud
 * console, and it happens on GOOGLE'S OWN PAGE - before the browser is ever redirected back here.
 * No application code runs, and none of it can. So there is nothing in this repository to "fix",
 * and the point of these tests is the opposite of a fix: they pin that the application is already
 * domain-agnostic, so that when the console setting is corrected the connect works, and so that
 * nobody later adds a domain check believing one used to be needed.
 *
 * WHAT WOULD BREAK IT, and what these tests would catch: a hard-coded `@gethomerealty.ca`
 * comparison anywhere on the connect path, an `hd` parameter on the authorization URL (asserted
 * absent in `oauth-account-picker.spec.ts`), or storage keyed on anything other than the CRM user.
 *
 * NOTHING HERE REACHES GOOGLE. The token exchange is represented by the object Google would have
 * returned; every assertion is about what this application then stores.
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

const crypt = new LaravelCryptService({ get: () => process.env.APP_KEY } as never);
const svc = (tx: PrismaService) => new GmailConnectService(tx, crypt);

const googleTokens = (refresh?: string) => ({
  access_token: `at-${tag()}`,
  ...(refresh ? { refresh_token: refresh } : {}),
  expires_in: 3600,
});

async function makeUser(tx: PrismaService, role = 'admin') {
  const now = new Date();
  const t = tag();
  return tx.users.create({
    data: { name: `Ext ${t}`, email: `ext-${t}@example.test`, role, status: 'Active', password: 'x', created_at: now, updated_at: now },
  });
}

const accountsOf = (tx: PrismaService, userId: number) =>
  tx.mail_accounts.findMany({ where: { user_id: userId }, orderBy: { id: 'asc' } });

describe('the application accepts any Google account, whatever its domain', () => {
  it('A — a Workspace address on the brokerage domain connects', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      await svc(tx).upsert(u.id, googleTokens('1//workspace-refresh'), 'agent@gethomerealty.ca', 'crm');

      const [acct] = await accountsOf(tx, u.id);
      expect(acct.from_email).toBe('agent@gethomerealty.ca');
      expect(acct.encryption).toBe('oauth');
    });
  });

  it('B — an external @gmail.com address connects, and is stored identically', async () => {
    /*
     * THE CASE THE CONSOLE SETTING BLOCKS. Nothing about this address is treated differently here:
     * same row shape, same sentinel, same host. If this ever diverges from case A, a domain rule has
     * crept onto the connect path.
     */
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      await svc(tx).upsert(u.id, googleTokens('1//external-refresh'), 'someone@gmail.com', 'crm');

      const [acct] = await accountsOf(tx, u.id);
      expect(acct.from_email).toBe('someone@gmail.com');
      expect(acct.encryption).toBe('oauth');
      expect(acct.host).toBe('smtp.gmail.com');
      expect(acct.imap_host).toBe('imap.gmail.com');
      expect(acct.is_active).toBe(true);
      expect(acct.scope).toBe('crm');
    });
  });

  it('C — another external Google domain connects too', async () => {
    // Not every non-Workspace Google account is @gmail.com; a Google account on any domain is one.
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      await svc(tx).upsert(u.id, googleTokens('1//other-refresh'), 'broker@someotherdomain.example', 'crm');

      const [acct] = await accountsOf(tx, u.id);
      expect(acct.from_email).toBe('broker@someotherdomain.example');
    });
  });

  it('stores the refresh token encrypted, never in the clear', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      const secret = '1//a-real-looking-refresh-token';
      await svc(tx).upsert(u.id, googleTokens(secret), 'vault@gmail.com', 'crm');

      const [acct] = await accountsOf(tx, u.id);
      expect(acct.password).not.toContain(secret);
      expect(crypt.decryptString(acct.password as string)).toBe(secret);
    });
  });

  it('D — reconnecting an existing external mailbox keeps the one row', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      await svc(tx).upsert(u.id, googleTokens('1//first'), 'repeat@gmail.com', 'crm');
      await svc(tx).upsert(u.id, googleTokens('1//second'), 'repeat@gmail.com', 'crm');

      const rows = await accountsOf(tx, u.id);
      expect(rows).toHaveLength(1);
      expect(crypt.decryptString(rows[0].password as string)).toBe('1//second');
    });
  });

  it('D — a reconnect that returns no new token keeps the credential it had', async () => {
    // Google omits the refresh token when consent is already standing. Covered in depth by
    // `gmail-reconnect-honesty.spec.ts`; repeated here for the external address.
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      await svc(tx).upsert(u.id, googleTokens('1//kept'), 'standing@gmail.com', 'crm');
      await svc(tx).upsert(u.id, googleTokens(), 'standing@gmail.com', 'crm');

      const rows = await accountsOf(tx, u.id);
      expect(rows).toHaveLength(1);
      expect(crypt.decryptString(rows[0].password as string)).toBe('1//kept');
    });
  });

  it('E — a response with no email address is refused, and stores nothing', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      await expect(svc(tx).upsert(u.id, googleTokens('1//x'), null, 'crm')).rejects.toThrow(/did not return an email/i);
      expect(await accountsOf(tx, u.id)).toHaveLength(0);
    });
  });

  it('E — a first connect with no refresh token is refused, and stores nothing', async () => {
    /*
     * A partial record is the failure worth preventing: an account row with no usable credential
     * looks connected on the screen and can never send.
     */
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      await expect(svc(tx).upsert(u.id, googleTokens(), 'notoken@gmail.com', 'crm'))
        .rejects.toThrow(/did not return a refresh token/i);
      expect(await accountsOf(tx, u.id)).toHaveLength(0);
    });
  });

  it('G — connecting an external mailbox cannot touch another user', async () => {
    await inRollback(async (tx) => {
      const mine = await makeUser(tx);
      const theirs = await makeUser(tx);
      await svc(tx).upsert(theirs.id, googleTokens('1//theirs'), 'shared@gmail.com', 'crm');
      const before = (await accountsOf(tx, theirs.id))[0];

      // The SAME address, connected while signed in as somebody else.
      await svc(tx).upsert(mine.id, googleTokens('1//mine'), 'shared@gmail.com', 'crm');

      const after = (await accountsOf(tx, theirs.id))[0];
      expect(after.id).toBe(before.id);
      expect(after.password).toBe(before.password);
      expect(after.user_id).toBe(theirs.id);

      const ours = await accountsOf(tx, mine.id);
      expect(ours).toHaveLength(1);
      expect(ours[0].user_id).toBe(mine.id);
      expect(ours[0].id).not.toBe(before.id);
    });
  });

  it('the connected mailbox belongs to the area it was connected in', async () => {
    // A row with no scope shows in neither CRM nor Transaction Desk, so the connect would appear
    // to do nothing at all.
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      await svc(tx).upsert(u.id, googleTokens('1//crm'), 'areas@gmail.com', 'crm');
      await svc(tx).upsert(u.id, googleTokens('1//desk'), 'areas@gmail.com', 'desk');

      const rows = await accountsOf(tx, u.id);
      expect(rows.map((r) => r.scope).sort()).toEqual(['crm', 'desk']);
      // Same address on both sides is two independent connections, not one shared row.
      expect(new Set(rows.map((r) => r.id)).size).toBe(2);
    });
  });

  it('the first account in an area becomes the default sender, and a later one does not', async () => {
    // Pinned, not changed: this is the existing primary-sender rule and must survive the console fix.
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      await svc(tx).upsert(u.id, googleTokens('1//one'), 'first@gmail.com', 'desk');
      const first = (await accountsOf(tx, u.id))[0];
      expect(first.is_default).toBe(true);

      // A second address in the SAME area is only reachable for a role that may hold more than one.
      await tx.mail_accounts.create({
        data: {
          name: 'second@gmail.com', from_email: 'second@gmail.com', username: 'second@gmail.com',
          host: 'smtp.gmail.com', port: 587, encryption: 'oauth', password: crypt.encryptString('1//two'),
          is_active: true, is_default: false, user_id: u.id, scope: 'desk',
          created_at: new Date(), updated_at: new Date(),
        },
      });
      const rows = await accountsOf(tx, u.id);
      expect(rows.filter((r) => r.is_default)).toHaveLength(1);
      expect(rows.find((r) => r.is_default)!.id).toBe(first.id);
    });
  });
});
