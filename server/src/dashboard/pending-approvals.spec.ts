import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { AreaDashboardService } from './area-dashboard.service';
import { PermissionService } from '../auth/permission.service';
import { PENDING_APPROVAL } from '../transactions/transaction-filters';
import { transactionScopeWhere } from '../common/transaction-scope';
import type { AuthUserRecord } from '../auth/auth.types';
import type { ResourceUser } from '../transactions/transaction.resource';

/**
 * PENDING APPROVALS — the Desk dashboard tile, and the list it opens.
 *
 * THE PROPERTY THAT MATTERS IS AGREEMENT. A tile whose number does not match the length of the
 * list it links to is worse than no tile, because the reader trusts it. So these tests do not
 * assert the count and the filter separately against hand-written expectations; wherever it is
 * meaningful they assert the two against EACH OTHER, on the same data, as the same user.
 *
 * Everything runs inside a transaction that is rolled back, so the suite leaves no rows behind.
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

const dash = (tx: PrismaService) => new AreaDashboardService(tx, new PermissionService());
const asUser = (role: string, id: number, name: string) =>
  ({ id, name, role, user_permissions: [] } as unknown as AuthUserRecord);

/** The count the tile shows. */
const tileCount = async (tx: PrismaService, u: AuthUserRecord): Promise<number> =>
  (await dash(tx).desk(u)).approvals.pending;

/**
 * How many deals the list returns under `?approvals=pending`, for the same person.
 *
 * Counted with the same query the list runs — scope AND the shared clause — rather than through
 * `TransactionsService`, which would drag in commission loading and serialisation that have
 * nothing to do with what is being asserted. The two inputs are what the list composes, so this
 * measures the same thing the screen does.
 */
const listCount = async (tx: PrismaService, u: AuthUserRecord): Promise<number> => {
  return tx.transactions.count({
    where: { AND: [{ deleted_at: null }, transactionScopeWhere(u as unknown as ResourceUser), PENDING_APPROVAL] },
  });
};

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

async function deal(tx: PrismaService, agentName: string): Promise<number> {
  const now = new Date();
  const t = tag();
  const row = await tx.transactions.create({
    data: {
      trade_no: `ZZ${t}`.slice(0, 20), agent: agentName, type: 'Residential Buying',
      property: `ZZ Approvals ${t}`, created_at: now, updated_at: now,
    },
    select: { id: true },
  });
  return row.id;
}

const request = (tx: PrismaService, txnId: number, status: string, scope: string | null = null) =>
  tx.transaction_edit_requests.create({
    data: {
      transaction_id: txnId, status, scope, requested_by_name: 'ZZ Asker',
      created_at: new Date(), updated_at: new Date(),
    },
  });

describe('the Pending Approvals count', () => {
  it('COUNTS A DEAL ONCE, however many requests are pending on it', async () => {
    /*
     * The headline requirement. `some` is a semi-join, so this holds structurally — but that is
     * exactly the kind of property that a later "improvement" to a join or a groupBy quietly
     * breaks, and the symptom (a tile reading 4 above a list of one row) is subtle.
     */
    await inRollback(async (tx) => {
      const a = await agent(tx, 'multi');
      const me = asUser('agent', a.id, a.name);
      const d = await deal(tx, a.name);

      expect(await tileCount(tx, me)).toBe(0);

      await request(tx, d, 'pending', 'financial');
      await request(tx, d, 'pending', 'mandatory');
      await request(tx, d, 'pending', 'other');
      await request(tx, d, 'pending', null);

      expect(await tileCount(tx, me)).toBe(1);
      // And the list agrees, which is the only thing that makes the number worth printing.
      expect(await listCount(tx, me)).toBe(1);
    });
  });

  it('is 0 when nothing is pending, rather than absent', async () => {
    await inRollback(async (tx) => {
      const a = await agent(tx, 'none');
      const me = asUser('agent', a.id, a.name);
      await deal(tx, a.name);

      const d = await dash(tx).desk(me);
      expect(d.approvals).toEqual({ pending: 0 });
    });
  });

  it('IGNORES DECIDED REQUESTS — approving or rejecting the last one takes the deal off the tile', async () => {
    await inRollback(async (tx) => {
      const a = await agent(tx, 'decided');
      const me = asUser('agent', a.id, a.name);
      const d = await deal(tx, a.name);
      const one = await request(tx, d, 'pending', 'financial');
      const two = await request(tx, d, 'pending', 'mandatory');
      expect(await tileCount(tx, me)).toBe(1);

      // One of two decided: still pending overall, so the deal stays counted.
      await tx.transaction_edit_requests.update({ where: { id: one.id }, data: { status: 'approved' } });
      expect(await tileCount(tx, me)).toBe(1);
      expect(await listCount(tx, me)).toBe(1);

      // The last one decided: the deal drops off both.
      await tx.transaction_edit_requests.update({ where: { id: two.id }, data: { status: 'rejected' } });
      expect(await tileCount(tx, me)).toBe(0);
      expect(await listCount(tx, me)).toBe(0);
    });
  });

  it('counts the APPROVAL workflow, not validation or commission status', async () => {
    // A deal can be invalid and unpaid without anybody having asked for anything.
    await inRollback(async (tx) => {
      const a = await agent(tx, 'otherstatus');
      const me = asUser('agent', a.id, a.name);
      const d = await deal(tx, a.name);
      await tx.transactions.update({
        where: { id: d },
        data: { valid_status: 'Invalid', comm_status: 'Not received' },
      });

      expect(await tileCount(tx, me)).toBe(0);
    });
  });

  it('a deleted deal is not pending anything', async () => {
    await inRollback(async (tx) => {
      const a = await agent(tx, 'deleted');
      const me = asUser('agent', a.id, a.name);
      const d = await deal(tx, a.name);
      await request(tx, d, 'pending');
      expect(await tileCount(tx, me)).toBe(1);

      await tx.transactions.update({ where: { id: d }, data: { deleted_at: new Date() } });
      expect(await tileCount(tx, me)).toBe(0);
      expect(await listCount(tx, me)).toBe(0);
    });
  });
});

describe('who may see what', () => {
  it('AN AGENT IS NOT TOLD ABOUT ANOTHER AGENT\'S PENDING APPROVALS', async () => {
    await inRollback(async (tx) => {
      const mine = await agent(tx, 'mine');
      const theirs = await agent(tx, 'theirs');
      const myDeal = await deal(tx, mine.name);
      const theirDeal = await deal(tx, theirs.name);
      await request(tx, myDeal, 'pending');
      await request(tx, theirDeal, 'pending');

      const me = asUser('agent', mine.id, mine.name);
      expect(await tileCount(tx, me)).toBe(1);
      expect(await listCount(tx, me)).toBe(1);

      // The other agent sees their own one, not mine, and certainly not both.
      const them = asUser('agent', theirs.id, theirs.name);
      expect(await tileCount(tx, them)).toBe(1);
    });
  });

  it('THE TILE AND THE LIST AGREE FOR EVERY ROLE, which is the whole contract', async () => {
    /*
     * The count and the filter are two call sites of one clause and one scope helper. This asserts
     * the consequence directly rather than trusting that they were wired the same way: whatever
     * each role can see, both numbers say the same thing about it.
     */
    await inRollback(async (tx) => {
      const mine = await agent(tx, 'parity');
      const theirs = await agent(tx, 'parity2');
      await request(tx, await deal(tx, mine.name), 'pending');
      await request(tx, await deal(tx, theirs.name), 'pending');
      await deal(tx, mine.name);   // no request on this one

      for (const u of [
        asUser('agent', mine.id, mine.name),
        asUser('agent', theirs.id, theirs.name),
        asUser('manager', 1, 'ZZ Admin'),
        asUser('admin', 1, 'ZZ Super'),
      ]) {
        expect(await tileCount(tx, u)).toBe(await listCount(tx, u));
      }
    });
  });

  it('an office role counts brokerage-wide, an agent does not', async () => {
    await inRollback(async (tx) => {
      const mine = await agent(tx, 'scopea');
      const theirs = await agent(tx, 'scopeb');
      await request(tx, await deal(tx, mine.name), 'pending');
      await request(tx, await deal(tx, theirs.name), 'pending');

      const asAgent = await tileCount(tx, asUser('agent', mine.id, mine.name));
      const asAdmin = await tileCount(tx, asUser('admin', 1, 'ZZ Super'));
      expect(asAgent).toBe(1);
      expect(asAdmin).toBeGreaterThanOrEqual(2);
      expect(asAdmin).toBeGreaterThan(asAgent);
    });
  });
});

describe('the list filter', () => {
  it('returns exactly the deals with something pending, and clearing it returns all of them', async () => {
    await inRollback(async (tx) => {
      const a = await agent(tx, 'filter');
      const me = asUser('agent', a.id, a.name);
      const waiting = await deal(tx, a.name);
      await deal(tx, a.name);
      await deal(tx, a.name);
      await request(tx, waiting, 'pending');

          const scope = { AND: [{ deleted_at: null }, transactionScopeWhere(me as unknown as ResourceUser)] };

      // Filtered: one. Unfiltered: all three. Clearing the filter is simply not sending it.
      expect(await tx.transactions.count({ where: { AND: [...scope.AND, PENDING_APPROVAL] } })).toBe(1);
      expect(await tx.transactions.count({ where: scope })).toBe(3);
    });
  });
});
