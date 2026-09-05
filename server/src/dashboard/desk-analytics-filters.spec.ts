import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CommissionService } from '../transactions/commission.service';
import { PersonResolver } from '../core/person-resolver.service';
import { DeskAnalyticsService, ANALYTICS_SELECT, type AnalyticsRow } from './desk-analytics.service';
import { parseAnalyticsFilters, ALL_STATUSES } from './desk-analytics.filters';
import { round2 } from '../common/serialize';
import type { Prisma } from '@prisma/client';
import type { ScopedUser } from '../common/transaction-scope';

/**
 * THE ANALYTICS FILTERS — applied in the database, authorized on the server.
 *
 * Two properties are under test and they need different kinds of assertion:
 *
 *   ARITHMETIC. A filtered total must equal the same commission engine summed over exactly the deals
 *   that match. So the expected value is computed here with `amountFor` — the TypeScript reference
 *   the SQL is already pinned against — over the fixture rows the filter should keep, rather than
 *   hard-coded. A hard-coded number would pass just as well if the filter matched the wrong set.
 *
 *   AUTHORIZATION. An agent must not be able to ask for another agent's figures, and the refusal
 *   must come from the server. These tests call the parser directly with an agent principal, because
 *   that is where the decision is made — asserting it through a hidden control would be asserting
 *   the frontend.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx as unknown as PrismaService);
      throw new Error(ROLLBACK);
    }, { timeout: 60000, isolationLevel: 'RepeatableRead' });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const svcFor = (tx: PrismaService) => new DeskAnalyticsService(tx, new CommissionService(new PersonResolver(tx)));
const office: ScopedUser = { id: 1, name: 'Office Boss', role: 'admin' };

async function makeAgent(tx: PrismaService, name: string) {
  const stamp = `${Date.now()}-${++seq}`;
  return tx.users.create({
    data: {
      name, email: `af-${stamp}@spec.test`, username: `af-${stamp}`,
      role: 'agent', status: 'Active', password: 'x', profile: '{}',
      created_at: new Date(), updated_at: new Date(),
    },
    select: { id: true, name: true },
  });
}

interface DealSpec {
  agent?: { id: number; name: string } | null;
  member?: { id: number | null; name: string };
  type?: string;
  status?: string;
  closing?: string | null;
  offer?: string | null;
  pct?: number;
  price?: number;
  paid?: boolean;
}

async function makeDeal(tx: PrismaService, d: DealSpec): Promise<number> {
  const now = new Date();
  const t = await tx.transactions.create({
    data: {
      trade_no: `AF-${Date.now()}-${++seq}`,
      type: d.type ?? 'Residential Buying',
      agent: d.agent ? d.agent.name : null,
      agent_user_id: d.agent ? d.agent.id : null,
      price: d.price ?? 800_000, deposit: 20_000,
      comm_type: '%', comm_value: 0, comm_pct: d.pct ?? 2.5,
      comm_status: 'Pending', comm_paid_status: d.paid ? 'Yes' : 'No',
      closing_date: d.closing === undefined ? new Date('2025-06-15T00:00:00.000Z') : d.closing ? new Date(`${d.closing}T00:00:00.000Z`) : null,
      offer_date: d.offer === undefined ? new Date('2025-03-01T00:00:00.000Z') : d.offer ? new Date(`${d.offer}T00:00:00.000Z`) : null,
      adjustments: '{}', admin_activities: '{}', activity_tracker: '{}',
      created_at: now, updated_at: now,
    },
  });
  if (d.status) {
    await tx.transaction_statuses.create({ data: { transaction_id: t.id, status: d.status, created_at: now, updated_at: now } });
  }
  if (d.member) {
    await tx.team_members.create({
      data: {
        transaction_id: t.id, name: d.member.name, user_id: d.member.id,
        split: 50, agent_pct: 90, brok_pct: 10, access: 'docs', scope: 'Entire', position: 0,
        created_at: now, updated_at: now,
      },
    });
  }
  return t.id;
}

/**
 * The commission the reference engine computes for the deals matching `where`.
 *
 * A WHERE CLAUSE RATHER THAN A LIST OF FIXTURE IDS, because these tests run against the development
 * database and it already holds transactions. Asserting a filtered total against only the rows this
 * test created passes whenever the fixture happens to be the whole answer — and would go on passing
 * for a filter that wrongly EXCLUDED pre-existing rows. The expected value has to describe the same
 * set the filter claims to describe.
 */
async function expectedTotal(tx: PrismaService, where: Prisma.transactionsWhereInput): Promise<number> {
  const svc = svcFor(tx);
  const rows = (await tx.transactions.findMany({
    where: { AND: [{ deleted_at: null }, where] }, select: ANALYTICS_SELECT, orderBy: { id: 'asc' },
  })) as AnalyticsRow[];
  return round2(rows.reduce((sum, r) => sum + svc.amountFor(r).amount, 0));
}

/** How many deals match — the count behind those figures. */
async function expectedCount(tx: PrismaService, where: Prisma.transactionsWhereInput): Promise<number> {
  return tx.transactions.count({ where: { AND: [{ deleted_at: null }, where] } });
}

/** The Analytics date as a Prisma range — the same closing-then-offer basis the service filters on. */
const inRange = (from: string, to: string): Prisma.transactionsWhereInput => ({
  OR: [
    { closing_date: { gte: new Date(from + 'T00:00:00.000Z'), lte: new Date(to + 'T00:00:00.000Z') } },
    { AND: [{ closing_date: null }, { offer_date: { gte: new Date(from + 'T00:00:00.000Z'), lte: new Date(to + 'T00:00:00.000Z') } }] },
  ],
});

describe('Analytics filters narrow the aggregate in the database', () => {
  it('no filters — every deal in scope', async () => {
    await inRollback(async (tx) => {
      const a = await makeAgent(tx, 'Filt Ana');
      await makeDeal(tx, { agent: a, closing: '2025-02-10' });
      await makeDeal(tx, { agent: a, closing: '2025-08-20' });
      // Unfiltered means every live deal, including any the database already held.
      const out = await svcFor(tx).summary(office, {});
      expect(out.totals.total).toBe(await expectedTotal(tx, {}));
    });
  });

  it('a date range keeps every deal that belongs to the period, however the chart buckets it', async () => {
    /*
     * TD-092 — THE RANGE AND THE CHART ANSWER DIFFERENT QUESTIONS.
     *
     * This case used to assert they applied one rule. They deliberately do not: membership of a
     * period is COALESCE(closing, offer), because a deal that has not closed still belongs to the
     * period it was written in and dropping it would hide live work — while the month a BAR is
     * drawn in is the closing date alone, because that is what the chart is headed.
     *
     * So the deal below with only an offer date is inside the March range AND sits in the
     * no-closing-date bucket. Both are true; the defect was inventing a closing month for it.
     */
    await inRollback(async (tx) => {
      const a = await makeAgent(tx, 'Filt Date');
      const inside = await makeDeal(tx, { agent: a, closing: '2025-03-10' });
      await makeDeal(tx, { agent: a, closing: '2025-09-10' });
      const byOffer = await makeDeal(tx, { agent: a, closing: null, offer: '2025-03-20' });

      const out = await svcFor(tx).summary(office, { from: '2025-03-01', to: '2025-03-31' });
      expect(out.totals.total).toBe(await expectedTotal(tx, inRange('2025-03-01', '2025-03-31')));
      expect(out.by_month.map((m) => m.month)).toEqual(['2025-03', 'none']);
      // Both fixture deals landed inside — one by its closing date, one by its offer date.
      expect(await expectedCount(tx, { AND: [{ id: { in: [inside, byOffer] } }, inRange('2025-03-01', '2025-03-31')] })).toBe(2);
    });
  });

  it('a deal with NEITHER date is excluded by a range, as it is excluded from the chart', async () => {
    await inRollback(async (tx) => {
      const a = await makeAgent(tx, 'Filt NoDate');
      const dated = await makeDeal(tx, { agent: a, closing: '2025-04-10' });
      await makeDeal(tx, { agent: a, closing: null, offer: null });

      const all = await svcFor(tx).summary(office, {});
      const ranged = await svcFor(tx).summary(office, { from: '2025-01-01', to: '2025-12-31' });
      expect(ranged.totals.total).toBe(await expectedTotal(tx, inRange('2025-01-01', '2025-12-31')));
      expect(all.totals.paid_count + all.totals.pending_count).toBe(await expectedCount(tx, {}));
      expect(ranged.totals.paid_count + ranged.totals.pending_count)
        .toBe(await expectedCount(tx, inRange('2025-01-01', '2025-12-31')));
      // The undated deal IS counted with no range, so the exclusion is the range's doing rather
      // than the deal being invisible to Analytics.
      expect(all.totals.paid_count + all.totals.pending_count)
        .toBeGreaterThan(ranged.totals.paid_count + ranged.totals.pending_count);
      expect(dated).toBeGreaterThan(0);
    });
  });

  it('boundary dates are INCLUSIVE at both ends', async () => {
    await inRollback(async (tx) => {
      const a = await makeAgent(tx, 'Filt Bound');
      const first = await makeDeal(tx, { agent: a, closing: '2025-05-01' });
      const last = await makeDeal(tx, { agent: a, closing: '2025-05-31' });
      const before = await makeDeal(tx, { agent: a, closing: '2025-04-30' });
      const after = await makeDeal(tx, { agent: a, closing: '2025-06-01' });

      const out = await svcFor(tx).summary(office, { from: '2025-05-01', to: '2025-05-31' });
      expect(out.totals.total).toBe(await expectedTotal(tx, inRange('2025-05-01', '2025-05-31')));
      // Both ends in, both neighbours out — asserted on the fixture directly, so a range that
      // slipped by a day could not hide behind the database's other rows.
      const matched = await tx.transactions.findMany({
        where: { AND: [{ id: { in: [first, last, before, after] } }, inRange('2025-05-01', '2025-05-31')] },
        select: { id: true },
      });
      expect(matched.map((r) => r.id).sort((x, y) => x - y)).toEqual([first, last].sort((x, y) => x - y));
    });
  });

  it('a type filter keeps only that type', async () => {
    await inRollback(async (tx) => {
      const a = await makeAgent(tx, 'Filt Type');
      const buying = await makeDeal(tx, { agent: a, type: 'Residential Buying' });
      await makeDeal(tx, { agent: a, type: 'Commercial Property Buying' });

      const out = await svcFor(tx).summary(office, { type: 'Residential Buying' });
      expect(out.totals.total).toBe(await expectedTotal(tx, { type: 'Residential Buying' }));
      expect(out.by_type.map((r) => r.type)).toEqual(['Residential Buying']);
      expect(buying).toBeGreaterThan(0);
    });
  });

  it('a status filter keeps only deals holding that status, counting each deal once', async () => {
    await inRollback(async (tx) => {
      const a = await makeAgent(tx, 'Filt Status');
      const closed = await makeDeal(tx, { agent: a, status: 'Closed' });
      const open = await makeDeal(tx, { agent: a, status: 'Open' });
      // A deal holds a SET of statuses. Two matching rows must not count the deal twice.
      await tx.transaction_statuses.create({
        data: { transaction_id: closed, status: 'Mutual Release', created_at: new Date(), updated_at: new Date() },
      });

      const hasClosed: Prisma.transactionsWhereInput = { transaction_statuses: { some: { status: 'Closed' } } };
      const out = await svcFor(tx).summary(office, { status: 'Closed' });
      expect(out.totals.total).toBe(await expectedTotal(tx, hasClosed));
      expect(out.totals.paid_count + out.totals.pending_count).toBe(await expectedCount(tx, hasClosed));
      // The deal carrying TWO statuses is counted once — the thing a join would break.
      expect(await expectedCount(tx, { AND: [{ id: { in: [closed, open] } }, hasClosed] })).toBe(1);
    });
  });

  it('an agent filter includes the deals that agent is SPLIT into, not only the ones they own', async () => {
    await inRollback(async (tx) => {
      const owner = await makeAgent(tx, 'Filt Owner');
      const member = await makeAgent(tx, 'Filt Member');
      const owned = await makeDeal(tx, { agent: member });
      const split = await makeDeal(tx, { agent: owner, member: { id: member.id, name: member.name } });
      await makeDeal(tx, { agent: owner });

      const out = await svcFor(tx).summary(office, { agent_user_id: member.id });
      expect(out.totals.total).toBe(await expectedTotal(tx, { id: { in: [owned, split] } }));
    });
  });

  it('an agent filter matches a LEGACY row by name only when it carries no id', async () => {
    await inRollback(async (tx) => {
      const legacy = await makeAgent(tx, 'Filt Legacy');
      const byName = await tx.transactions.create({
        data: {
          trade_no: `AF-LEG-${Date.now()}-${++seq}`, type: 'Residential Buying',
          agent: 'Filt Legacy', agent_user_id: null,
          price: 800_000, deposit: 0, comm_type: '%', comm_value: 0, comm_pct: 2.5,
          comm_status: 'Pending', comm_paid_status: 'No',
          closing_date: new Date('2025-06-15T00:00:00.000Z'),
          adjustments: '{}', admin_activities: '{}', activity_tracker: '{}',
          created_at: new Date(), updated_at: new Date(),
        },
      });
      const out = await svcFor(tx).summary(office, { agent_user_id: legacy.id });
      expect(out.totals.total).toBe(await expectedTotal(tx, { id: byName.id }));
    });
  });

  it('TWO AGENTS WITH THE SAME NAME are told apart by id', async () => {
    await inRollback(async (tx) => {
      const first = await makeAgent(tx, 'Akhil');
      const second = await makeAgent(tx, 'Akhil');
      // Different prices, so "told apart" cannot pass by the two answers coinciding.
      const firstDeal = await makeDeal(tx, { agent: first, price: 700_000 });
      const secondDeal = await makeDeal(tx, { agent: second, price: 1_250_000 });

      const a = await svcFor(tx).summary(office, { agent_user_id: first.id });
      const b = await svcFor(tx).summary(office, { agent_user_id: second.id });
      expect(a.totals.total).toBe(await expectedTotal(tx, { id: firstDeal }));
      expect(b.totals.total).toBe(await expectedTotal(tx, { id: secondDeal }));
      expect(a.totals.total).not.toBe(b.totals.total);
    });
  });

  it('COMBINED filters narrow to their intersection', async () => {
    await inRollback(async (tx) => {
      const target = await makeAgent(tx, 'Filt Combo');
      const other = await makeAgent(tx, 'Filt Other');
      const wanted = await makeDeal(tx, { agent: target, type: 'Residential Buying', status: 'Closed', closing: '2025-03-15', price: 900_000 });
      // Each of these misses on exactly one clause.
      await makeDeal(tx, { agent: other, type: 'Residential Buying', status: 'Closed', closing: '2025-03-15' });
      await makeDeal(tx, { agent: target, type: 'Commercial Property Buying', status: 'Closed', closing: '2025-03-15' });
      await makeDeal(tx, { agent: target, type: 'Residential Buying', status: 'Open', closing: '2025-03-15' });
      await makeDeal(tx, { agent: target, type: 'Residential Buying', status: 'Closed', closing: '2025-09-15' });

      const out = await svcFor(tx).summary(office, {
        agent_user_id: target.id, type: 'Residential Buying', status: 'Closed',
        from: '2025-01-01', to: '2025-06-30',
      });
      expect(out.totals.total).toBe(await expectedTotal(tx, { id: wanted }));
      expect(out.totals.paid_count + out.totals.pending_count).toBe(1);
    });
  });

  it('an empty result is zeros and empty tables, not an error', async () => {
    await inRollback(async (tx) => {
      const a = await makeAgent(tx, 'Filt Empty');
      await makeDeal(tx, { agent: a, closing: '2025-06-15' });
      const out = await svcFor(tx).summary(office, { from: '2030-01-01', to: '2030-12-31' });
      expect(out.totals).toEqual({ total: 0, paid: 0, pending: 0, paid_count: 0, pending_count: 0 });
      expect(out.by_month).toEqual([]);
      expect(out.by_agent).toEqual([]);
      expect(out.by_type).toEqual([]);
    });
  });

  it('paid and pending stay split, and still sum to the total, under a filter', async () => {
    await inRollback(async (tx) => {
      const a = await makeAgent(tx, 'Filt Paid');
      const paid = await makeDeal(tx, { agent: a, closing: '2025-07-10', paid: true });
      const pending = await makeDeal(tx, { agent: a, closing: '2025-07-20', paid: false });

      const july = inRange('2025-07-01', '2025-07-31');
      const isPaid: Prisma.transactionsWhereInput = { OR: [{ comm_paid_status: 'Yes' }, { comm_status: 'Received' }] };

      const out = await svcFor(tx).summary(office, { from: '2025-07-01', to: '2025-07-31' });
      expect(out.totals.paid).toBe(await expectedTotal(tx, { AND: [july, isPaid] }));
      expect(out.totals.pending).toBe(await expectedTotal(tx, { AND: [july, { NOT: isPaid }] }));
      expect(await expectedCount(tx, { AND: [{ id: { in: [paid, pending] } }, isPaid] })).toBe(1);
      expect(out.totals.total).toBe(round2(out.totals.paid + out.totals.pending));
    });
  });
});

describe('the Analytics agent selector is an authorization boundary', () => {
  const agent: ScopedUser = { id: 42, name: 'Scoped Agent', role: 'agent' };

  it('an AGENT asking for another agent is REFUSED, not quietly rewritten', () => {
    expect(() => parseAnalyticsFilters({ agent_user_id: '99' }, agent)).toThrow(/only view your own/i);
  });

  it('an agent asking for themselves is allowed', () => {
    expect(parseAnalyticsFilters({ agent_user_id: '42' }, agent).agent_user_id).toBe(42);
  });

  it('an agent who asks for nobody is LOCKED to themselves', () => {
    expect(parseAnalyticsFilters({}, agent).agent_user_id).toBe(42);
  });

  it('an office user may name any agent, and may name nobody', () => {
    expect(parseAnalyticsFilters({ agent_user_id: '99' }, office).agent_user_id).toBe(99);
    expect(parseAnalyticsFilters({}, office).agent_user_id).toBeUndefined();
  });

  it('an agent still sees only their own deals even with no filter at all', async () => {
    await inRollback(async (tx) => {
      const me = await makeAgent(tx, 'Own Only');
      const other = await makeAgent(tx, 'Not Mine');
      const mine = await makeDeal(tx, { agent: me });
      await makeDeal(tx, { agent: other });

      const out = await svcFor(tx).summary({ id: me.id, name: me.name, role: 'agent' }, {});
      expect(out.totals.total).toBe(await expectedTotal(tx, { id: mine }));
    });
  });
});

describe('a filter that cannot be honoured is refused, not dropped', () => {
  it('an unknown transaction type', () => {
    expect(() => parseAnalyticsFilters({ type: 'Spaceship Sale' }, office)).toThrow(/not a transaction type/i);
  });

  it('an unknown status', () => {
    expect(() => parseAnalyticsFilters({ status: 'Nearly Done' }, office)).toThrow(/not a transaction status/i);
  });

  it('a malformed date', () => {
    expect(() => parseAnalyticsFilters({ from: '15/06/2025' }, office)).toThrow(/not a date/i);
  });

  it('an inverted range', () => {
    expect(() => parseAnalyticsFilters({ from: '2025-06-30', to: '2025-01-01' }, office)).toThrow(/before the start date/i);
  });

  it('a non-numeric agent id', () => {
    expect(() => parseAnalyticsFilters({ agent_user_id: 'me' }, office)).toThrow(/not an agent id/i);
  });

  it('the vocabularies it validates against are the application\'s own', () => {
    // If a status is added to the Transactions module this list grows with it, rather than the
    // filter silently refusing a status the rest of the product accepts.
    expect(ALL_STATUSES).toEqual(expect.arrayContaining(['Open', 'Closed', 'Mutual Release', 'DFT', 'Void', 'Expired']));
    expect(parseAnalyticsFilters({ status: 'Closed' }, office).status).toBe('Closed');
  });

  it('blank values mean "no filter" rather than an error', () => {
    expect(parseAnalyticsFilters({ from: '', to: '  ', type: '', status: '', agent_user_id: '' }, office))
      .toEqual({ from: undefined, to: undefined, type: undefined, status: undefined, agent_user_id: undefined });
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});
