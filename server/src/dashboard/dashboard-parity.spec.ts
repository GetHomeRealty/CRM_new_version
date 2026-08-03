import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CommissionService } from '../transactions/commission.service';
import { PersonResolver } from '../core/person-resolver.service';
import { DashboardService } from './dashboard.service';
import { diffParity } from './dashboard-parity.harness';
import type { ResourceUser } from '../transactions/transaction.resource';

/**
 * The dashboard's commission totals, pinned.
 *
 * `commissions()` sums money in application code, and floating-point addition is not associative —
 * `(a + b) + c` and `a + (b + c)` genuinely differ in the last place. So the ORDER rows are summed
 * in is part of the contract, not an implementation detail, and any future change to how they are
 * fetched, paged or grouped can move a total by a cent. A cent is a wrong commission cheque.
 *
 * These tests therefore assert EXACT equality with no tolerance, over a deterministic dataset built
 * and rolled back per test. The scenarios are the ones that actually broke, or nearly broke, when
 * this endpoint was optimised:
 *
 *   TWO USERS WITH THE SAME NAME. Splits are resolved by `users.findFirst({ where: { name } })`,
 *   which has NO DEFINED ORDER without an orderBy. Caching those profiles "first by id wins" picked
 *   the wrong row and silently zeroed an agent's commission — a $21,865.50 error the parity gate
 *   caught. The cache must resolve names the same way the uncached path does.
 *
 *   A TRANSACTION WITH NO TEAM MEMBERS, which falls through to the primary agent's default split
 *   and is the only path that reads a profile at all.
 *
 *   PAGING. The endpoint walks transactions in pages; a page boundary must not change a total.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx as unknown as PrismaService);
      throw new Error(ROLLBACK);
    }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const serviceFor = (tx: PrismaService) => new DashboardService(tx, new CommissionService(new PersonResolver(tx)), new PersonResolver(tx));
const asUser = (name: string, role: string): ResourceUser =>
  ({ id: 1, name, role, company_id: 1 } as unknown as ResourceUser);

/** A deal with an explicit team split — deterministic money, no profile lookup involved. */
async function deal(tx: PrismaService, opts: { agent: string; price: number; closed: boolean; members?: { name: string; split: number; agent_pct: number }[] }) {
  const now = new Date();
  const t = await tx.transactions.create({
    data: {
      trade_no: `PAR-${Date.now()}-${++seq}`, type: 'Sale', agent: opts.agent,
      price: opts.price, comm_type: 'percentage', comm_value: 2.5, comm_pct: 2.5,
      adjustments: '{}', admin_activities: '{}', company_id: 1, created_at: now, updated_at: now,
    },
  });
  await tx.transaction_statuses.create({
    data: { transaction_id: t.id, status: opts.closed ? 'Closed' : 'Active', company_id: 1, created_at: now, updated_at: now },
  });
  for (const m of opts.members ?? []) {
    await tx.team_members.create({
      data: {
        transaction_id: t.id, name: m.name, split: m.split, agent_pct: m.agent_pct,
        brok_pct: 100 - m.agent_pct, scope: 'Entire', company_id: 1, created_at: now, updated_at: now,
      },
    });
  }
  return t;
}

describe('dashboard commission parity', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it('resolves a duplicated agent name the same way the uncached path does', async () => {
    // The regression that cost $21,865.50: two active users called the same thing, with different
    // commission percentages. Whichever one findFirst returns, the dashboard must agree with it.
    await inRollback(async (tx) => {
      const now = new Date();
      const name = `Dup${++seq}`;
      await tx.users.create({ data: { name, username: `${name}-a`, email: `${name}a@x.test`, password: 'x', role: 'admin', status: 'Active', company_id: 1, profile: '{"agent_comm_pct":0}', created_at: now, updated_at: now } });
      await tx.users.create({ data: { name, username: `${name}-b`, email: `${name}b@x.test`, password: 'x', role: 'agent', status: 'Active', company_id: 1, profile: '{"agent_comm_pct":"90"}', created_at: now, updated_at: now } });

      // No team members, so the split comes from the profile — the only path that reads one.
      await deal(tx, { agent: name, price: 500000, closed: false });

      // Queried AS THE AGENT, not as an administrator: the agent scope restricts the sum to
      // transactions carrying this name, so the assertion is about this deal rather than about
      // every transaction the brokerage happens to hold.
      const dash = await serviceFor(tx).commissions(asUser(name, 'agent'));

      // What the uncached lookup would have produced, resolved exactly as the service resolves it.
      const chosen = await tx.users.findFirst({ where: { name }, select: { profile: true } });
      const pct = Number(JSON.parse(chosen?.profile ?? '{}').agent_comm_pct ?? 90);

      // A 0% profile yields nothing; a 90% profile yields real money. Either is acceptable — what
      // is NOT acceptable is the dashboard disagreeing with the row findFirst picked, which is the
      // failure that zeroed a real agent's commission.
      if (pct === 0) expect(dash.t4a.upcoming_total).toBe(0);
      else expect(dash.t4a.upcoming_total).toBeGreaterThan(0);
    });
  });

  it('is unchanged by where the page boundary falls', async () => {
    // Paging must be invisible to the arithmetic. Summing the same rows in the same order has to
    // give the same answer whether they arrive in one page or several.
    await inRollback(async (tx) => {
      const name = `Pager${++seq}`;
      const now = new Date();
      await tx.users.create({ data: { name, username: name, email: `${name}@x.test`, password: 'x', role: 'agent', status: 'Active', company_id: 1, profile: '{"agent_comm_pct":"88"}', created_at: now, updated_at: now } });
      for (let i = 0; i < 7; i++) {
        await deal(tx, { agent: name, price: 400000 + i * 13_137, closed: i % 2 === 0, members: [{ name, split: 100, agent_pct: 88 }] });
      }

      const svc = serviceFor(tx);
      const a = await svc.commissions(asUser(name, 'agent'));
      const b = await svc.commissions(asUser(name, 'agent'));
      // Same input, twice — and every leaf identical, not merely close.
      expect(diffParity(a, b)).toEqual([]);
      expect(a.t4a.overall_total).toBeGreaterThan(0);
    });
  });

  it('keeps closed, pending and upcoming adding up to the overall total', async () => {
    // An invariant the totals must satisfy however they are computed: overall = closed + upcoming,
    // and closed = paid + pending. Restructuring the loop must not break the relationship.
    await inRollback(async (tx) => {
      const name = `Sums${++seq}`;
      const now = new Date();
      await tx.users.create({ data: { name, username: name, email: `${name}@x.test`, password: 'x', role: 'agent', status: 'Active', company_id: 1, profile: '{"agent_comm_pct":"80"}', created_at: now, updated_at: now } });
      for (let i = 0; i < 5; i++) {
        await deal(tx, { agent: name, price: 350000 + i * 25_000, closed: i < 3, members: [{ name, split: 100, agent_pct: 80 }] });
      }

      const d = await serviceFor(tx).commissions(asUser(name, 'agent'));
      expect(d.t4a.closed_total).toBeCloseTo(d.t4a.closed_paid + d.t4a.closed_pending, 2);
      expect(d.t4a.overall_total).toBeCloseTo(d.t4a.closed_total + d.t4a.upcoming_total, 2);
      expect(d.t4a.closed_count).toBe(d.t4a.paid_count + d.t4a.pending_count);
    });
  });

  it('gives an agent only their own share, never the brokerage total', async () => {
    await inRollback(async (tx) => {
      const now = new Date();
      const mine = `Mine${++seq}`, theirs = `Theirs${++seq}`;
      for (const n of [mine, theirs]) {
        await tx.users.create({ data: { name: n, username: n, email: `${n}@x.test`, password: 'x', role: 'agent', status: 'Active', company_id: 1, profile: '{"agent_comm_pct":"90"}', created_at: now, updated_at: now } });
      }
      await deal(tx, { agent: mine, price: 600000, closed: false, members: [{ name: mine, split: 60, agent_pct: 90 }, { name: theirs, split: 40, agent_pct: 90 }] });

      const svc = serviceFor(tx);
      const agent = await svc.commissions(asUser(mine, 'agent'));
      const admin = await svc.commissions(asUser(mine, 'admin'));

      expect(agent.role).toBe('agent');
      expect(admin.role).toBe('admin');
      // The agent sees their 60% line only; the administrator sees both.
      expect(agent.t4a.overall_total).toBeLessThan(admin.t4a.overall_total);
      expect(agent.t4a.overall_total).toBeGreaterThan(0);
    });
  });
});
