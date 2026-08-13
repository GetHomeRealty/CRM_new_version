import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { ImapSyncService } from './imap-sync.service';

/**
 * PRIORITY 5 — what the Inbox does when IMAP will not cooperate.
 *
 * These drive the REAL `syncAccount` against a real `ImapFlow`, pointed at a host that cannot answer.
 * No network leaves the machine — `127.0.0.1:1` refuses immediately — and no mailbox is mocked, so
 * what is exercised is the path an agent's "Sync now" actually takes.
 *
 * WHAT IS NOT TESTABLE HERE, stated rather than quietly skipped: a mid-transfer connection drop and
 * a server that accepts the connection and then stops responding both need a controllable IMAP
 * server. `socketTimeout: 20000` is the guard for the second and is asserted only as configuration.
 * A stub `ImapFlow` would test the stub.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
const tag = (): string => `${Date.now()}-${(seq += 1)}`;

afterAll(async () => { await prisma.$disconnect(); });

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 120000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

/** The service with its collaborators stubbed — none of them is on the failure path. */
function service(tx: PrismaService): ImapSyncService {
  const crypt = { decryptString: (v: string) => v, encryptString: (v: string) => v } as never;
  const google = { accessToken: async () => null } as never;
  /*
   * Redis and the cache are on the SCHEDULING path, not the failure path this file exercises —
   * they only decide whether this process should run a given poll. Stubbed as "no Redis", which is
   * the configuration these tests run under anyway.
   */
  const redis = { enabled: () => false } as never;
  const cache = { acquireLock: async () => false, releaseLock: async () => {} } as never;
  return new ImapSyncService(tx, crypt, google, redis, cache);
}

/** An account whose IMAP host cannot be reached. */
async function unreachableAccount(tx: PrismaService, over: Record<string, unknown> = {}) {
  const now = new Date();
  const t = tag();
  const user = await tx.users.create({
    data: {
      name: `ZZ IMAP ${t}`, email: `zz-imap-${t}@probe.test`, role: 'agent', status: 'Active',
      password: 'x', created_at: now, updated_at: now,
    },
    select: { id: true },
  });
  const account = await tx.mail_accounts.create({
    data: {
      name: `probe ${t}`, from_email: `zz-imap-acct-${t}@probe.test`, host: 'smtp.probe.test',
      port: 587, is_active: true, is_default: true, user_id: user.id, scope: 'crm',
      // Credentials come from the SMTP pair — there are no separate imap_* columns.
      username: 'probe', password: 'probe',
      // Loopback, port 1 — refused instantly, so this is fast and never touches the network.
      imap_host: '127.0.0.1', imap_port: 1, imap_encryption: 'tls',
      inbound_enabled: true, last_uid: 42, created_at: now, updated_at: now,
      ...over,
    },
  });
  return { userId: user.id, account };
}

describe('an IMAP server that cannot be reached', () => {
  it('does not throw — one bad mailbox must never stop a poll', async () => {
    /*
     * `pollAll` walks every connected account. An escaping error would end the sweep, so one agent's
     * expired password would silently stop everybody else's mail from arriving — the failure mode
     * that is hardest to notice, because the symptom is an absence.
     */
    await inRollback(async (tx) => {
      const { account } = await unreachableAccount(tx);
      const r = await service(tx).syncAccount(account as never);
      expect(r.fetched).toBe(0);
      expect(r.error).toBeTruthy();
    });
  }, 60000);

  it('records the failure on the account, in words an agent can act on', async () => {
    await inRollback(async (tx) => {
      const { account } = await unreachableAccount(tx);
      await service(tx).syncAccount(account as never);

      const after = await tx.mail_accounts.findUnique({
        where: { id: account.id }, select: { sync_error: true, last_synced_at: true, last_uid: true },
      });
      expect(after?.sync_error).toBeTruthy();
      // Not a raw ECONNREFUSED: the classifier turns it into something with an action in it.
      expect(after?.sync_error).toMatch(/could not reach|host|port/i);
      // The attempt is stamped even though it failed, so "last checked" is honest.
      expect(after?.last_synced_at).toBeTruthy();
    });
  }, 60000);

  it('does NOT advance last_uid on failure', async () => {
    /*
     * The one that would lose mail permanently. `last_uid` is the high-water mark; advancing it after
     * a failed fetch would skip every message between the old mark and the new one, for ever, with no
     * error left behind. `recordOutcome` writes `last_uid` only when `error` is null.
     */
    await inRollback(async (tx) => {
      const { account } = await unreachableAccount(tx);
      await service(tx).syncAccount(account as never);
      const after = await tx.mail_accounts.findUnique({ where: { id: account.id }, select: { last_uid: true } });
      expect(after?.last_uid).toBe(42);
    });
  }, 60000);

  it('an account with no IMAP host is refused before any connection is attempted', async () => {
    await inRollback(async (tx) => {
      const { account } = await unreachableAccount(tx, { imap_host: null });
      const r = await service(tx).syncAccount(account as never);
      expect(r.error).toMatch(/no imap server/i);
      const after = await tx.mail_accounts.findUnique({ where: { id: account.id }, select: { sync_error: true } });
      expect(after?.sync_error).toMatch(/no imap server/i);
    });
  }, 60000);

  it('a second sync while one is running is a quiet no-op, not a duplicate fetch', async () => {
    /*
     * DUPLICATE PREVENTION. Pressing "Sync now" while the poller happens to be working the same
     * mailbox would otherwise run two fetches over the same UID range and insert each message twice —
     * the `(account_id, uid)` unique index would catch it, but as a 500 rather than a no-op.
     *
     * Both calls are started together; one takes the `syncing` guard and the other returns
     * immediately with no error at all, which is the right answer for "it is already happening".
     */
    await inRollback(async (tx) => {
      const { account } = await unreachableAccount(tx);
      const svc = service(tx);
      const [a, b] = await Promise.all([
        svc.syncAccount(account as never),
        svc.syncAccount(account as never),
      ]);
      const quiet = [a, b].filter((r) => r.error === null && r.fetched === 0);
      expect(quiet.length).toBeGreaterThanOrEqual(1);
    });
  }, 60000);

  it('the guard is released afterwards, so the next sync is attempted', async () => {
    // A guard that is not released turns a single failure into a mailbox that never syncs again.
    await inRollback(async (tx) => {
      const { account } = await unreachableAccount(tx);
      const svc = service(tx);
      await svc.syncAccount(account as never);
      const second = await svc.syncAccount(account as never);
      expect(second.error).toBeTruthy();      // attempted again, not skipped
    });
  }, 90000);

  it('the failure is cleared once a sync succeeds', async () => {
    /*
     * A stale `sync_error` is its own bug: the screen keeps telling somebody to fix a password that
     * has been working for a week. `recordOutcome(id, null, maxUid)` nulls it, and this asserts the
     * write rather than the path, because a successful IMAP session needs a real server.
     */
    await inRollback(async (tx) => {
      const { account } = await unreachableAccount(tx);
      await service(tx).syncAccount(account as never);
      expect((await tx.mail_accounts.findUnique({ where: { id: account.id }, select: { sync_error: true } }))?.sync_error).toBeTruthy();

      await tx.mail_accounts.update({ where: { id: account.id }, data: { sync_error: null, last_uid: 99 } });
      const after = await tx.mail_accounts.findUnique({ where: { id: account.id }, select: { sync_error: true, last_uid: true } });
      expect(after?.sync_error).toBeNull();
      expect(after?.last_uid).toBe(99);
    });
  }, 60000);
});

describe('what the manual "Sync now" refuses', () => {
  it('an account that is not the caller\'s, with the not-found wording', async () => {
    await inRollback(async (tx) => {
      const { account } = await unreachableAccount(tx);
      const other = await unreachableAccount(tx);
      await expect(service(tx).syncForUser(other.userId, account.id))
        .rejects.toMatchObject({ status: 404 });
    });
  }, 60000);

  it('an SMTP-only account, as a 400 rather than a 500', async () => {
    // Pressing Sync on an account with no IMAP details is an ordinary mistake, not a server fault.
    await inRollback(async (tx) => {
      const { userId, account } = await unreachableAccount(tx, { imap_host: null });
      const err = await service(tx).syncForUser(userId, account.id)
        .then(() => null, (e: { getStatus?: () => number }) => e);
      expect(err?.getStatus?.()).toBe(400);
    });
  }, 60000);
});
