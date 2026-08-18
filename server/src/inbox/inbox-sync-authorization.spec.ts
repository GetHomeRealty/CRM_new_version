import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';
import { InboxEventsService } from './inbox-events.service';
import { NotFoundException } from '@nestjs/common';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * `POST /api/account/inbox/sync/:accountId` — the one Inbox write that takes an id belonging to
 * something other than a message.
 *
 * WHY AT THE CONTROLLER AND NOT IN THE BROWSER. The browser version of this test skipped: it sourced
 * a victim account from `GET /api/mail-accounts`, which lists only BROKERAGE accounts (`user_id:
 * null`) and returns `[]` in the fixture. A skip in an authorization suite reads as a pass in the
 * summary line, which is the worst place for one to hide. Here the account can simply be created.
 *
 * TWO SUSPICIONS, BOTH FROM READING `inbox.controller.ts`, both settled below by measurement:
 *
 *   1. The controller looks the account up with `findUnique({ where: { id } })` — NO user filter —
 *      to check its area, and its refusal message interpolates `account.from_email`. If a caller can
 *      reach that branch for somebody else's account, they learn that person's connected address.
 *   2. `ImapSyncService.syncForUser` filters `{ id, user_id }` correctly, but signals failure with a
 *      bare `throw new Error('Mail account not found.')`, which Nest renders as a 500 rather than a
 *      404.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
const tag = (): string => `${Date.now()}-${(seq += 1)}`;

afterAll(async () => { await prisma.$disconnect(); });

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const asUser = (id: number, name: string) => ({ id, name, role: 'agent' } as unknown as AuthUserRecord);

/** A mail account belonging to `ownerId`, in the given area. */
async function accountFor(tx: PrismaService, ownerId: number | null, scope: 'crm' | 'desk') {
  const now = new Date();
  const t = tag();
  return tx.mail_accounts.create({
    data: {
      name: `probe ${t}`, from_email: `zz-secret-${t}@private.test`, host: 'smtp.probe.test',
      port: 587, is_active: true, is_default: true, user_id: ownerId, scope,
      imap_host: 'imap.probe.test', inbound_enabled: true, created_at: now, updated_at: now,
    },
  });
}

async function agent(tx: PrismaService, label: string) {
  const now = new Date();
  const t = tag();
  return tx.users.create({
    data: {
      name: `ZZ ${label} ${t}`, email: `zz-${label}-${t}@probe.test`, role: 'agent', status: 'Active',
      password: 'x', created_at: now, updated_at: now,
    },
    select: { id: true, name: true },
  });
}

/** The controller, with the IMAP layer replaced by a spy so no network is touched. */
function controller(tx: PrismaService, calls: { userId: number; accountId: number }[]) {
  const imap = {
    syncForUser: async (userId: number, accountId: number) => {
      calls.push({ userId, accountId });
      // Mirrors `ImapSyncService.syncForUser` exactly, including its refusal TYPE — a stub that is
      // kinder than the code it stands in for would hide the very thing this file measured.
      const own = await tx.mail_accounts.findFirst({ where: { id: accountId, user_id: userId } });
      if (!own) throw new NotFoundException({ message: 'That email account no longer exists.' });
      return { fetched: 0, matched: 0, error: null };
    },
  } as never;
  return new InboxController(new InboxService(tx), imap, tx, new InboxEventsService());
}

describe('a sync cannot be triggered on somebody else\'s mail account', () => {
  it('the same-area case is refused, and does not sync', async () => {
    await inRollback(async (tx) => {
      const calls: { userId: number; accountId: number }[] = [];
      const victim = await agent(tx, 'victim');
      const attacker = await agent(tx, 'attacker');
      const acct = await accountFor(tx, victim.id, 'crm');

      const err = await controller(tx, calls)
        .sync(asUser(attacker.id, attacker.name), acct.id, 'crm')
        .then(() => null, (e: Error) => e);

      expect(err).toBeTruthy();
      /*
       * REFUSED BEFORE THE SYNC IS EVEN ATTEMPTED.
       *
       * Before the fix this assertion read `toEqual([{ userId, accountId }])` — the request reached
       * `syncForUser`, which refused it there. That was safe but late: the controller had already
       * read the row, and the wrong-area branch above it was handing out the owner's address. Now
       * the controller's own lookup is scoped to the caller, so nothing downstream is asked at all.
       */
      expect(calls).toEqual([]);
    });
  });

  it('and the refusal does NOT disclose the other user\'s email address', async () => {
    /*
     * Suspicion 1. The wrong-area branch is the one that interpolates `from_email`, and it is
     * reachable by anyone signed in, because the lookup above it has no user filter.
     */
    await inRollback(async (tx) => {
      const calls: { userId: number; accountId: number }[] = [];
      const victim = await agent(tx, 'victim');
      const attacker = await agent(tx, 'attacker');
      // The victim's account is in the CRM area; the attacker asks from the Transaction Desk.
      const acct = await accountFor(tx, victim.id, 'crm');

      const err = await controller(tx, calls)
        .sync(asUser(attacker.id, attacker.name), acct.id, 'desk')
        .then(() => null, (e: Error & { response?: unknown }) => e);

      expect(err).toBeTruthy();
      const said = JSON.stringify((err as { response?: unknown })?.response ?? err?.message ?? '');
      expect(said).not.toContain(acct.from_email);
      // It must not reach the sync either — a refusal that still ran the work is not a refusal.
      expect(calls).toEqual([]);
    });
  });

  it('a cross-user sync is a 404, not a 500', async () => {
    /*
     * Suspicion 2. A bare `Error` becomes an Internal Server Error, which is a poor contract for a
     * routine "not yours" and a probe oracle besides: it separates ids that reached the service from
     * ids the controller rejected first.
     */
    await inRollback(async (tx) => {
      const calls: { userId: number; accountId: number }[] = [];
      const victim = await agent(tx, 'victim');
      const attacker = await agent(tx, 'attacker');
      const acct = await accountFor(tx, victim.id, 'crm');

      const err = await controller(tx, calls)
        .sync(asUser(attacker.id, attacker.name), acct.id, 'crm')
        .then(() => null, (e: { getStatus?: () => number }) => e);

      expect(err?.getStatus?.()).toBe(404);
    });
  });

  it('an account id that never existed is refused the same way', async () => {
    // Identical treatment, so the reply cannot be used to tell a real account id from an invented
    // one — the same reason the Calendar answers 404 rather than 403.
    await inRollback(async (tx) => {
      const calls: { userId: number; accountId: number }[] = [];
      const attacker = await agent(tx, 'attacker');

      const err = await controller(tx, calls)
        .sync(asUser(attacker.id, attacker.name), 2_000_000_000, 'crm')
        .then(() => null, (e: { getStatus?: () => number }) => e);

      expect(err?.getStatus?.()).toBe(404);
    });
  });

  it('a brokerage account (user_id null) is not one an agent may sync either', async () => {
    await inRollback(async (tx) => {
      const calls: { userId: number; accountId: number }[] = [];
      const attacker = await agent(tx, 'attacker');
      const acct = await accountFor(tx, null, 'crm');

      const err = await controller(tx, calls)
        .sync(asUser(attacker.id, attacker.name), acct.id, 'crm')
        .then(() => null, (e: { getStatus?: () => number }) => e);

      expect(err?.getStatus?.()).toBe(404);
    });
  });

  it('…while the owner CAN sync their own account', async () => {
    // The guard rail: everything above would also pass if sync were simply broken for everyone.
    await inRollback(async (tx) => {
      const calls: { userId: number; accountId: number }[] = [];
      const owner = await agent(tx, 'owner');
      const acct = await accountFor(tx, owner.id, 'crm');

      const r = await controller(tx, calls).sync(asUser(owner.id, owner.name), acct.id, 'crm');

      expect(calls).toEqual([{ userId: owner.id, accountId: acct.id }]);
      expect(r).toBeTruthy();
    });
  });
});
