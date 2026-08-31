import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { GmailConnectService } from './gmail-connect.service';
import { LaravelCryptService } from '../common/laravel-crypt.service';

/**
 * A reconnect must not report a repair that did not happen.
 *
 * THE DEFECT. `upsert` cleared `sync_error` and set `is_active: true` on every reconnect —
 * including the branch where Google returned NO refresh token. Google omits it whenever consent is
 * already standing, and the row then keeps the credential it already had: possibly the exact one
 * Google had revoked. The screen showed a freshly connected mailbox with no error, the next poll
 * failed again minutes later, and the natural response was to reconnect once more. That loop can
 * run for days without the underlying grant ever changing.
 *
 * OBSERVED, not hypothesised. On this deployment `precon@gethomerealty.ca` was reconnected at
 * 05:42 and Google rejected the stored credential with `invalid_grant` the same morning — a token
 * "stored 0 days ago" and already dead, which is only possible if the reconnect never replaced it.
 *
 * THE RULE THESE TESTS PIN. Clearing the error is a claim about the credential, so it is allowed
 * only when the credential actually changed. Everything else — re-enabling the account, bumping
 * `updated_at` — is unchanged, because those are true either way.
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

/** Google's answer to the token exchange. `refresh_token` is absent on a repeat consent. */
const googleTokens = (refresh?: string) => ({
  access_token: `at-${tag()}`,
  ...(refresh ? { refresh_token: refresh } : {}),
  expires_in: 3600,
});

async function makeUser(tx: PrismaService) {
  const now = new Date();
  const t = tag();
  return tx.users.create({
    data: { name: `Gm ${t}`, email: `gm-${t}@example.test`, role: 'agent', status: 'Active', password: 'x', created_at: now, updated_at: now },
  });
}

/** An already-connected Gmail mailbox holding an encrypted refresh token. */
async function existingAccount(tx: PrismaService, userId: number, address: string, syncError: string | null) {
  const now = new Date();
  return tx.mail_accounts.create({
    data: {
      name: address, from_email: address, username: address,
      host: 'smtp.gmail.com', port: 587, encryption: 'oauth',
      password: crypt.encryptString('1//old-and-possibly-revoked'),
      sync_error: syncError, is_active: false, is_default: true,
      user_id: userId, scope: 'crm', created_at: now, updated_at: new Date('2026-08-21T07:37:00Z'),
    },
  });
}

// =================================================================================================

describe('a reconnect that received NO new token', () => {
  it('THE DEFECT: does not clear an existing failure', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const addr = `preserved-${tag()}@example.test`;
      const before = await existingAccount(tx, user.id, addr, 'Google refused this mailbox (invalid_grant).');

      // Google omits the refresh token because consent was already standing.
      await svc(tx).upsert(user.id, googleTokens() as never, addr, 'crm');

      const after = await tx.mail_accounts.findUnique({ where: { id: before.id } });
      // The credential did not change, so the account must not claim to be fixed.
      expect(after!.password).toBe(before.password);
      expect(after!.sync_error).not.toBeNull();
      expect(after!.sync_error).toMatch(/myaccount\.google\.com/);
    });
  });

  it('says the one thing that actually resolves it', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const addr = `advice-${tag()}@example.test`;
      const acc = await existingAccount(tx, user.id, addr, 'Google refused this mailbox (invalid_grant).');

      await svc(tx).upsert(user.id, googleTokens() as never, addr, 'crm');

      const msg = (await tx.mail_accounts.findUnique({ where: { id: acc.id } }))!.sync_error!;
      // Signing in again cannot mint a refresh token while the grant already exists — so the
      // message must send the user to remove the app's access, not around the loop again.
      expect(msg).toMatch(/Third-party apps/i);
      expect(msg).toMatch(/connect the mailbox again/i);
    });
  });

  it('still re-enables the account and records the attempt', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const addr = `enable-${tag()}@example.test`;
      const acc = await existingAccount(tx, user.id, addr, 'Google refused this mailbox (invalid_grant).');

      await svc(tx).upsert(user.id, googleTokens() as never, addr, 'crm');

      const after = await tx.mail_accounts.findUnique({ where: { id: acc.id } });
      // Those two are true whether or not the token changed, so they are still done.
      expect(after!.is_active).toBe(true);
      expect(after!.updated_at!.getTime()).toBeGreaterThan(acc.updated_at!.getTime());
    });
  });

  it('leaves a HEALTHY preserved account completely alone', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const addr = `healthy-${tag()}@example.test`;
      const acc = await existingAccount(tx, user.id, addr, null);   // no prior failure

      await svc(tx).upsert(user.id, googleTokens() as never, addr, 'crm');

      const after = await tx.mail_accounts.findUnique({ where: { id: acc.id } });
      // Nothing changed about the credential, so nothing is claimed in either direction — and no
      // error is invented for a mailbox that was working.
      expect(after!.sync_error).toBeNull();
      expect(after!.password).toBe(acc.password);
      expect(after!.is_active).toBe(true);
    });
  });
});

describe('a reconnect that DID receive a new token', () => {
  it('replaces the credential and clears the failure — the repair really happened', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const addr = `replaced-${tag()}@example.test`;
      const acc = await existingAccount(tx, user.id, addr, 'Google refused this mailbox (invalid_grant).');

      await svc(tx).upsert(user.id, googleTokens('1//brand-new-token') as never, addr, 'crm');

      const after = await tx.mail_accounts.findUnique({ where: { id: acc.id } });
      expect(after!.password).not.toBe(acc.password);
      expect(crypt.decryptString(after!.password!)).toBe('1//brand-new-token');
      expect(after!.sync_error).toBeNull();       // earned, this time
      expect(after!.is_active).toBe(true);
    });
  });
});

describe('what a first-time connect still does', () => {
  it('refuses when Google returns no refresh token and there is nothing to fall back on', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      // No existing row, no refresh token — storing this would create an account that can never
      // authenticate, so it is refused outright rather than saved broken.
      await expect(svc(tx).upsert(user.id, googleTokens() as never, `first-${tag()}@example.test`, 'crm'))
        .rejects.toThrow(/did not return a refresh token/i);
    });
  });
});
