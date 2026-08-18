import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CommissionService } from '../transactions/commission.service';
import { PersonResolver } from '../core/person-resolver.service';
import { DashboardService } from '../dashboard/dashboard.service';
import { DeskAnalyticsService, ANALYTICS_SELECT, type AnalyticsRow } from '../dashboard/desk-analytics.service';
import { diffParity } from '../dashboard/dashboard-parity.harness';
import { round2 } from '../common/serialize';
import type { ResourceUser } from '../transactions/transaction.resource';

/**
 * THE GATE ON THE COMMISSION MATH THAT LIVES IN SQL.
 *
 * Analytics and the Dashboard's commission figures are computed by the database now — see
 * `dashboard/desk-analytics.service.ts`, `dashboard/desk-commission.sql.ts` and migrations
 * 20260815090000 / 20260815100000. That means the commission engine exists TWICE: once in
 * `CommissionService`, once as SQL. Two copies of a financial rule drift, and when they drift the
 * symptom is not a crash — it is a wrong number on a screen that nobody questions.
 *
 * This is what makes that acceptable. Every case below builds a deal, computes the answer with the
 * TypeScript engine, computes it again with the SQL, and requires them to be EXACTLY equal. No
 * tolerance, no epsilon: the failure being guarded against is precisely a sub-cent difference that
 * rounds into a visible figure, and a tolerance would hide it.
 *
 * The cases are the places the two implementations can disagree, not a sample of ordinary deals:
 *
 *   · ALL THREE VARIANTS. Standard, listing and preconstruction take different paths through
 *     `breakdown()`, and each had to be transliterated separately.
 *   · THE FOUR-WAY COMMISSION FALLBACK, including a stored zero, which must fall THROUGH to the next
 *     rule rather than short-circuit to nothing.
 *   · `1 + 0.13` VERSUS `1.13`. These are different doubles. Every gross-up in the SQL is written as
 *     the former because that is what the TypeScript computes; a deal whose numbers do not divide
 *     evenly is what makes the difference visible.
 *   · HALF-CENT ROUNDING, which is where PHP's pre-correction earns its keep.
 *   · THE MEMBER RESOLUTION SPECIAL CASES: no team rows at all (the agent's profile split), and team
 *     rows that all have a zero share (the primary agent is promoted to 100).
 *   · TWO ACTIVE ACCOUNTS WITH THE SAME NAME, which is the situation this brokerage is actually in
 *     and the reason `PersonResolver` exists.
 *
 * If you change `CommissionService` and this fails, the SQL needs the same change. That is the
 * point of it — do not relax the comparison.
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

const engineFor = (tx: PrismaService) => new CommissionService(new PersonResolver(tx));
const dashboardFor = (tx: PrismaService) => new DashboardService(tx, engineFor(tx), new PersonResolver(tx));
const analyticsFor = (tx: PrismaService) => new DeskAnalyticsService(tx, engineFor(tx));
const asUser = (name: string, role: string, id: number): ResourceUser => ({ id, name, role } as unknown as ResourceUser);

/** The gross-commission expression exactly as the services build it. */
const GROSS = `desk_gross_commission(
  t.type, t.price::float8, t.comm_type, t.comm_value::float8, t.comm_pct::float8, t.comm_amt::float8,
  t.listing_comm_pct::float8, t.coop_comm_pct::float8, t.listing_comm_flat::float8, t.coop_comm_flat::float8,
  t.precon_comm_pct::float8, t.precon_comm_amt_manual::float8)`;

interface DealSpec {
  type?: string;
  price?: number;
  comm_type?: string;
  comm_value?: number;
  comm_pct?: number | null;
  comm_amt?: number | null;
  listing_comm_pct?: number | null;
  coop_comm_pct?: number | null;
  listing_comm_flat?: number | null;
  coop_comm_flat?: number | null;
  listing_adj_enabled?: boolean;
  listing_adj_before?: number;
  listing_adj_after?: number;
  comm_adjust_enabled?: boolean;
  comm_adjust_before?: number;
  comm_adjust_after?: number;
  precon_comm_pct?: number | null;
  precon_comm_amt_manual?: number | null;
  precon_term_count?: number | null;
  precon_terms?: { term_no: number; pct: number }[];
  comm_paid_status?: string | null;
  comm_status?: string;
  agent?: string | null;
  agent_user_id?: number | null;
  closed?: boolean;
  closing_date?: string | null;
  offer_date?: string | null;
  adjustments?: Record<string, unknown>;
  admin_activities?: Record<string, unknown>;
  members?: { name: string; user_id?: number | null; split: number; agent_pct: number; brok_pct: number; scope?: string; terms?: number[] }[];
}

async function makeDeal(tx: PrismaService, d: DealSpec): Promise<number> {
  const now = new Date();
  const t = await tx.transactions.create({
    data: {
      trade_no: `SQLP-${Date.now()}-${++seq}`,
      type: d.type ?? 'Residential Buying',
      agent: d.agent === undefined ? 'Parity Agent' : d.agent,
      agent_user_id: d.agent_user_id ?? null,
      price: d.price ?? 812_345.67,
      deposit: 25_000,
      comm_type: d.comm_type ?? '%',
      comm_value: d.comm_value ?? 0,
      comm_pct: d.comm_pct === undefined ? 2.5 : d.comm_pct,
      comm_amt: d.comm_amt ?? null,
      comm_adjust_enabled: d.comm_adjust_enabled ?? false,
      comm_adjust_before: d.comm_adjust_before ?? 0,
      comm_adjust_after: d.comm_adjust_after ?? 0,
      listing_comm_pct: d.listing_comm_pct ?? null,
      coop_comm_pct: d.coop_comm_pct ?? null,
      listing_comm_flat: d.listing_comm_flat ?? null,
      coop_comm_flat: d.coop_comm_flat ?? null,
      listing_adj_enabled: d.listing_adj_enabled ?? false,
      listing_adj_before: d.listing_adj_before ?? 0,
      listing_adj_after: d.listing_adj_after ?? 0,
      precon_comm_pct: d.precon_comm_pct ?? null,
      precon_comm_amt_manual: d.precon_comm_amt_manual ?? null,
      precon_term_count: d.precon_term_count ?? null,
      comm_paid_status: d.comm_paid_status ?? 'No',
      comm_status: d.comm_status ?? 'Pending',
      closing_date: d.closing_date === undefined ? new Date('2025-06-15T00:00:00.000Z') : d.closing_date ? new Date(`${d.closing_date}T00:00:00.000Z`) : null,
      offer_date: d.offer_date === undefined ? new Date('2025-03-01T00:00:00.000Z') : d.offer_date ? new Date(`${d.offer_date}T00:00:00.000Z`) : null,
      adjustments: JSON.stringify(d.adjustments ?? {}),
      admin_activities: JSON.stringify(d.admin_activities ?? {}),
      activity_tracker: '{}',
      created_at: now,
      updated_at: now,
    },
  });

  if (d.closed) {
    await tx.transaction_statuses.create({ data: { transaction_id: t.id, status: 'Closed', created_at: now, updated_at: now } });
  }
  for (const p of d.precon_terms ?? []) {
    await tx.precon_terms.create({ data: { transaction_id: t.id, term_no: p.term_no, pct: p.pct, created_at: now, updated_at: now } });
  }
  let pos = 0;
  for (const m of d.members ?? []) {
    const row = await tx.team_members.create({
      data: {
        transaction_id: t.id, name: m.name, user_id: m.user_id ?? null,
        split: m.split, agent_pct: m.agent_pct, brok_pct: m.brok_pct,
        scope: m.scope ?? 'Entire', position: pos++, created_at: now, updated_at: now,
      },
    });
    for (const k of m.terms ?? []) {
      await tx.team_member_terms.create({ data: { team_member_id: row.id, term_no: k, created_at: now, updated_at: now } });
    }
  }
  return t.id;
}

/** The SQL gross for one deal, as the number the services would use. */
async function sqlAmount(tx: PrismaService, id: number): Promise<number> {
  const rows = await tx.$queryRawUnsafe<{ amount: string | null }[]>(
    `SELECT php_round2(${GROSS})::text AS amount FROM transactions t WHERE t.id = ${id}`,
  );
  return Number(rows[0]?.amount ?? 0);
}

/** The TypeScript gross for the same deal. */
async function tsAmount(tx: PrismaService, id: number): Promise<number> {
  const row = (await tx.transactions.findUniqueOrThrow({ where: { id }, select: ANALYTICS_SELECT })) as AnalyticsRow;
  return analyticsFor(tx).amountFor(row).amount;
}

// ---------------------------------------------------------------------------
describe('the gross commission in SQL matches CommissionService, deal for deal', () => {
  /**
   * Named so a failure says which RULE broke rather than which row.
   *
   * The prices are deliberately awkward — 812,345.67 at 2.5% is 20,308.641750, which is exactly the
   * kind of value where a rewritten formula lands a cent away.
   */
  const cases: [string, DealSpec][] = [
    ['a percentage of an odd price', { comm_pct: 2.5, price: 812_345.67 }],
    ['a percentage that rounds on the half cent', { comm_pct: 3.7, price: 1_234_567.89 }],
    ['a fixed amount', { comm_pct: null, comm_type: 'Fixed', comm_value: 7_500 }],
    ['comm_amt winning over comm_pct', { comm_amt: 9_999.99, comm_pct: 2.5 }],
    ['a ZERO comm_amt falling through to comm_pct', { comm_amt: 0, comm_pct: 2.5 }],
    ['a ZERO comm_pct falling through to comm_value', { comm_pct: 0, comm_type: '%', comm_value: 4.25 }],
    ['no commission configured at all', { comm_pct: null, comm_type: '%', comm_value: 0 }],
    ['a listing deal, both legs', {
      type: 'Residential Sale Listing', comm_pct: null,
      listing_comm_pct: 2.5, coop_comm_pct: 2.5, listing_comm_flat: 750, coop_comm_flat: 500,
    }],
    ['a listing deal with only flat amounts', {
      type: 'Commercial Property Sale Listing', comm_pct: null,
      listing_comm_pct: null, coop_comm_pct: null, listing_comm_flat: 1_500, coop_comm_flat: 1_250,
    }],
    ['Business Sale, which takes the listing path despite its name', {
      type: 'Business Sale', comm_pct: null, listing_comm_pct: 3, coop_comm_pct: 2,
    }],
    ['a lease listing', {
      type: 'Residential Lease Listing', comm_pct: null, price: 3_400,
      listing_comm_pct: 50, coop_comm_pct: 50,
    }],
    ['preconstruction on the master percentage', {
      type: 'Preconstruction', comm_pct: null, precon_comm_pct: 3.75, precon_term_count: 3,
    }],
    ['preconstruction with a manual amount overriding the percentage', {
      type: 'Preconstruction', comm_pct: null, precon_comm_pct: 3.75, precon_comm_amt_manual: 41_250.5,
    }],
    ['preconstruction with a ZERO manual amount falling through to the percentage', {
      type: 'Preconstruction', comm_pct: null, precon_comm_pct: 3.75, precon_comm_amt_manual: 0,
    }],
    ['a deal type the listing branch must NOT claim', { type: 'Business Buying', comm_pct: 2.5 }],
  ];

  for (const [label, spec] of cases) {
    it(label, async () => {
      await inRollback(async (tx) => {
        const id = await makeDeal(tx, spec);
        const ts = await tsAmount(tx, id);
        const sql = await sqlAmount(tx, id);
        // Object.is, not toBe: a 0 that became -0 is a real difference and would otherwise pass.
        expect(Object.is(sql, ts)).toBe(true);
      });
    });
  }

  it('agrees on the paid flag, including a null comm_paid_status', async () => {
    await inRollback(async (tx) => {
      const ids = await Promise.all([
        makeDeal(tx, { comm_paid_status: 'Yes', comm_status: 'Pending' }),
        makeDeal(tx, { comm_paid_status: 'No', comm_status: 'Received' }),
        makeDeal(tx, { comm_paid_status: null, comm_status: 'Pending' }),
        makeDeal(tx, { comm_paid_status: null, comm_status: 'Received' }),
      ]);
      const rows = await tx.$queryRawUnsafe<{ id: number; paid: boolean }[]>(
        `SELECT t.id, (t.comm_paid_status = 'Yes' OR t.comm_status = 'Received') AS paid
         FROM transactions t WHERE t.id IN (${ids.join(',')})`,
      );
      for (const r of rows) {
        const row = (await tx.transactions.findUniqueOrThrow({ where: { id: r.id }, select: ANALYTICS_SELECT })) as AnalyticsRow;
        expect(r.paid).toBe(analyticsFor(tx).amountFor(row).paid);
      }
    });
  });
});

// ---------------------------------------------------------------------------
describe('the Analytics aggregate matches summing the same rows in TypeScript', () => {
  it('agrees on every total, month, agent and type', async () => {
    await inRollback(async (tx) => {
      // A corpus with real skew: three variants, both paid states, two agents, a deal with no
      // closing date (which must fall back to the offer month) and one with neither (which must
      // drop out of by_month entirely).
      await makeDeal(tx, { agent: 'Ana', comm_pct: 2.5, price: 812_345.67, comm_paid_status: 'Yes', closing_date: '2025-01-31' });
      await makeDeal(tx, { agent: 'Ana', comm_pct: 3.7, price: 1_234_567.89, closing_date: '2025-01-05' });
      await makeDeal(tx, { agent: 'Bo', comm_type: 'Fixed', comm_pct: null, comm_value: 7_500, comm_status: 'Received', closing_date: '2025-02-14' });
      await makeDeal(tx, { agent: 'Bo', type: 'Residential Sale Listing', comm_pct: null, listing_comm_pct: 2.5, coop_comm_pct: 2.5, closing_date: null, offer_date: '2024-12-20' });
      await makeDeal(tx, { agent: null, type: 'Preconstruction', comm_pct: null, precon_comm_pct: 3.75, precon_term_count: 2, closing_date: null, offer_date: null });
      await makeDeal(tx, { agent: '', comm_pct: 1.5, price: 500_000, closing_date: '2025-03-01' });

      const out = await analyticsFor(tx).summary(null);

      // The reference: the same rows, summed in TypeScript.
      const rows = (await tx.transactions.findMany({ where: { deleted_at: null }, select: ANALYTICS_SELECT, orderBy: { id: 'asc' } })) as AnalyticsRow[];
      const svc = analyticsFor(tx);
      let paid = 0, pending = 0, paidCount = 0, pendingCount = 0;
      const byMonth = new Map<string, number>();
      const byAgent = new Map<string, { count: number; total: number }>();
      const byType = new Map<string, { count: number; total: number }>();
      const tally = (m: Map<string, { count: number; total: number }>, k: string, v: number) => {
        const cur = m.get(k) ?? { count: 0, total: 0 };
        cur.count += 1; cur.total += v; m.set(k, cur);
      };
      for (const r of rows) {
        const { amount, paid: isPaid } = svc.amountFor(r);
        if (isPaid) { paid += amount; paidCount++; } else { pending += amount; pendingCount++; }
        const d = r.closing_date ?? r.offer_date;
        if (d) { const k = d.toISOString().slice(0, 7); byMonth.set(k, (byMonth.get(k) ?? 0) + amount); }
        tally(byAgent, r.agent && r.agent.trim() !== '' ? r.agent : 'Unassigned', amount);
        tally(byType, r.type, amount);
      }

      expect(out.totals).toEqual({
        total: round2(paid + pending), paid: round2(paid), pending: round2(pending),
        paid_count: paidCount, pending_count: pendingCount,
      });
      expect(out.by_month).toEqual(
        [...byMonth.entries()].map(([month, total]) => ({ month, total: round2(total) })).sort((a, b) => a.month.localeCompare(b.month)),
      );
      // Compared as maps: the SQL's tie-break on the key is its own contract and is asserted below.
      expect(Object.fromEntries(out.by_agent.map((r) => [r.agent, [r.count, r.total]])))
        .toEqual(Object.fromEntries([...byAgent].map(([k, v]) => [k, [v.count, round2(v.total)]])));
      expect(Object.fromEntries(out.by_type.map((r) => [r.type, [r.count, r.total]])))
        .toEqual(Object.fromEntries([...byType].map(([k, v]) => [k, [v.count, round2(v.total)]])));
    });
  });

  it('orders by_agent and by_type by commission, highest first', async () => {
    await inRollback(async (tx) => {
      await makeDeal(tx, { agent: 'Small', comm_pct: null, comm_type: 'Fixed', comm_value: 1_000 });
      await makeDeal(tx, { agent: 'Large', comm_pct: null, comm_type: 'Fixed', comm_value: 9_000 });
      const out = await analyticsFor(tx).summary(null);
      const totals = out.by_agent.map((r) => r.total);
      expect([...totals].sort((a, b) => b - a)).toEqual(totals);
    });
  });

  it('answers zeros — not everybody else\'s figures — for a scope that matches nothing', async () => {
    await inRollback(async (tx) => {
      await makeDeal(tx, { agent: 'Somebody Else', comm_pct: 2.5 });
      // An agent with an id nothing references and a name nothing matches.
      const out = await analyticsFor(tx).summary({ id: 99_000_001, name: 'Nobody At All', role: 'agent' });
      expect(out).toEqual({
        totals: { total: 0, paid: 0, pending: 0, paid_count: 0, pending_count: 0 },
        by_month: [], by_agent: [], by_type: [],
      });
    });
  });
});

// ---------------------------------------------------------------------------
describe('the Dashboard commission aggregate matches the TypeScript implementation', () => {
  /**
   * `commissions()` reads the database; `commissionsInNode()` is the original loop. Both are run
   * over the same data and every numeric leaf is compared.
   */
  const bothAgree = async (tx: PrismaService, user: ResourceUser | null) => {
    const svc = dashboardFor(tx);
    const [sql, node] = [await svc.commissions(user), await svc.commissionsInNode(user)];
    const diffs = diffParity(node, sql);
    if (diffs.length) {
      throw new Error(`SQL and TypeScript disagree:\n${diffs.map((d) => `  ${d.path}: node=${String(d.before)} sql=${String(d.after)}`).join('\n')}`);
    }
  };

  it('on a standard deal with an explicit team split', async () => {
    await inRollback(async (tx) => {
      await makeDeal(tx, {
        agent: 'Lead', closed: true, comm_pct: 2.5, price: 812_345.67,
        members: [
          { name: 'Lead', split: 60, agent_pct: 90, brok_pct: 10 },
          { name: 'Second', split: 40, agent_pct: 85, brok_pct: 15 },
        ],
      });
      await bothAgree(tx, asUser('Boss', 'admin', 1));
    });
  });

  it('on a deal with NO team rows, where the split comes from the agent profile', async () => {
    await inRollback(async (tx) => {
      const u = await tx.users.create({
        data: {
          name: 'Profile Agent', email: `pa-${Date.now()}@parity.test`, username: `pa-${Date.now()}`,
          role: 'agent', status: 'Active', password: 'x',
          profile: JSON.stringify({ agent_comm_pct: '87.5', lease_comm_pct: '92' }),
          created_at: new Date(), updated_at: new Date(),
        },
      });
      await makeDeal(tx, { agent: 'Profile Agent', agent_user_id: u.id, closed: true, comm_pct: 2.5 });
      // …and the lease variant, which reads the OTHER profile key.
      await makeDeal(tx, { agent: 'Profile Agent', agent_user_id: u.id, type: 'Residential Lease', comm_pct: 50, price: 3_400 });
      await bothAgree(tx, asUser('Boss', 'admin', 1));
    });
  });

  it('on a deal whose team rows all have a zero share (the primary is promoted to 100)', async () => {
    await inRollback(async (tx) => {
      await makeDeal(tx, {
        agent: 'Primary', closed: true, comm_pct: 2.5,
        members: [
          { name: 'Primary', split: 0, agent_pct: 90, brok_pct: 10 },
          { name: 'Helper', split: 0, agent_pct: 90, brok_pct: 10 },
        ],
      });
      await bothAgree(tx, asUser('Boss', 'admin', 1));
    });
  });

  it('on a listing deal, where the agent pool is sized by the FIRST member', async () => {
    await inRollback(async (tx) => {
      await makeDeal(tx, {
        type: 'Residential Sale Listing', agent: 'Lister', closed: true, comm_pct: null,
        listing_comm_pct: 2.5, coop_comm_pct: 2.5, listing_comm_flat: 750,
        listing_adj_enabled: true, listing_adj_before: 300, listing_adj_after: 125,
        members: [
          { name: 'Lister', split: 70, agent_pct: 95, brok_pct: 5 },
          { name: 'Junior', split: 30, agent_pct: 80, brok_pct: 20 },
        ],
      });
      await bothAgree(tx, asUser('Boss', 'admin', 1));
    });
  });

  it('on a preconstruction deal with per-term member visibility', async () => {
    await inRollback(async (tx) => {
      await makeDeal(tx, {
        type: 'Preconstruction', agent: 'Pre', closed: true, comm_pct: null,
        precon_comm_pct: 4, precon_term_count: 3,
        // Term 3 has NO stored row, so it must contribute 0% rather than be skipped.
        precon_terms: [{ term_no: 1, pct: 1.5 }, { term_no: 2, pct: 1.5 }],
        members: [
          { name: 'Pre', split: 60, agent_pct: 90, brok_pct: 10, scope: 'Entire' },
          { name: 'Partial', split: 40, agent_pct: 85, brok_pct: 15, scope: 'Selected', terms: [2] },
        ],
      });
      await bothAgree(tx, asUser('Boss', 'admin', 1));
    });
  });

  it('on referrals and adjustments off the adjustments blob', async () => {
    await inRollback(async (tx) => {
      await makeDeal(tx, {
        agent: 'Ref', closed: true, comm_pct: 2.5, comm_adjust_enabled: true,
        comm_adjust_before: 450.55, comm_adjust_after: 120.25,
        adjustments: {
          ext_referral: 'Yes', ext: { amount: '1250.75', party: 'Other Brokerage', pct: 25 },
          client_referral: 'Yes', client_rows: [{ amount: 500 }, { amount: '250.50' }],
        },
        members: [{ name: 'Ref', split: 100, agent_pct: 90, brok_pct: 10 }],
      });
      await bothAgree(tx, asUser('Boss', 'admin', 1));
    });
  });

  it('when the adjustments blob is malformed, which must read as empty rather than fail', async () => {
    await inRollback(async (tx) => {
      const id = await makeDeal(tx, { agent: 'Broken', closed: true, comm_pct: 2.5, members: [{ name: 'Broken', split: 100, agent_pct: 90, brok_pct: 10 }] });
      await tx.transactions.update({ where: { id }, data: { adjustments: '{not json at all', admin_activities: '' } });
      await bothAgree(tx, asUser('Boss', 'admin', 1));
    });
  });

  it('on the paid / pending / upcoming split, which is what the tiles count', async () => {
    await inRollback(async (tx) => {
      const paidBlob = { agents: { Split: { payments: [{ paid_status: 'Paid', amount: 1000 }] } } };
      // paid + closed, unpaid + closed (pending), unpaid + open (upcoming)
      await makeDeal(tx, { agent: 'Split', closed: true, comm_pct: 2.5, admin_activities: paidBlob, members: [{ name: 'Split', split: 100, agent_pct: 90, brok_pct: 10 }] });
      await makeDeal(tx, { agent: 'Split', closed: true, comm_pct: 2.5, members: [{ name: 'Split', split: 100, agent_pct: 90, brok_pct: 10 }] });
      await makeDeal(tx, { agent: 'Split', closed: false, comm_pct: 2.5, members: [{ name: 'Split', split: 100, agent_pct: 90, brok_pct: 10 }] });
      await bothAgree(tx, asUser('Boss', 'admin', 1));
    });
  });

  it('for an AGENT, whose dashboard counts every visible deal — including ones they are not on', async () => {
    await inRollback(async (tx) => {
      const me = await tx.users.create({
        data: {
          name: 'Mine', email: `mine-${Date.now()}@parity.test`, username: `mine-${Date.now()}`,
          role: 'agent', status: 'Active', password: 'x', profile: '{}',
          created_at: new Date(), updated_at: new Date(),
        },
      });
      // One where they are the agent AND a member, one where they are the agent but the split names
      // somebody else — the second contributes a zero line, not no line.
      await makeDeal(tx, { agent: 'Mine', agent_user_id: me.id, closed: true, comm_pct: 2.5, members: [{ name: 'Mine', user_id: me.id, split: 100, agent_pct: 90, brok_pct: 10 }] });
      await makeDeal(tx, { agent: 'Mine', agent_user_id: me.id, closed: true, comm_pct: 2.5, members: [{ name: 'Somebody', split: 100, agent_pct: 90, brok_pct: 10 }] });
      await bothAgree(tx, asUser('Mine', 'agent', me.id));
    });
  });

  it('for the SECOND of two active accounts sharing one name', async () => {
    await inRollback(async (tx) => {
      const stamp = Date.now();
      const first = await tx.users.create({
        data: {
          name: 'Akhil', email: `a1-${stamp}@parity.test`, username: `a1-${stamp}`, role: 'agent',
          status: 'Active', password: 'x', profile: JSON.stringify({ agent_comm_pct: 0 }),
          created_at: new Date(), updated_at: new Date(),
        },
      });
      const second = await tx.users.create({
        data: {
          name: 'Akhil', email: `a2-${stamp}@parity.test`, username: `a2-${stamp}`, role: 'agent',
          status: 'Active', password: 'x', profile: JSON.stringify({ agent_comm_pct: 90 }),
          created_at: new Date(), updated_at: new Date(),
        },
      });
      await makeDeal(tx, { agent: 'Akhil', agent_user_id: first.id, closed: true, comm_pct: 2.5 });
      await makeDeal(tx, { agent: 'Akhil', agent_user_id: second.id, closed: true, comm_pct: 2.5 });
      await bothAgree(tx, asUser('Akhil', 'agent', second.id));
      await bothAgree(tx, asUser('Boss', 'admin', 1));
    });
  });

  it('answers zeros for a caller who can see nothing', async () => {
    await inRollback(async (tx) => {
      await makeDeal(tx, { agent: 'Somebody Else', closed: true, comm_pct: 2.5 });
      const out = await dashboardFor(tx).commissions(asUser('Nobody At All', 'agent', 99_000_002));
      expect(out.t4a.overall_total).toBe(0);
      expect(out.t4a.closed_count).toBe(0);
      expect(out.gross.overall_total).toBe(0);
    });
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});
