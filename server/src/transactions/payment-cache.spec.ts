import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CommissionService } from './commission.service';
import { PaymentCacheService } from './payment-cache.service';
import { commissionInclude, normalizeCommissionTxn } from './commission.loader';
import { PersonResolver } from '../core/person-resolver.service';
import { parseJsonObject } from '../common/serialize';
import { agentCommission, agentLines, agentPaymentsPaid } from '../reports/report-financials';

/**
 * THE CACHED COLUMNS ARE WHAT THE ENGINE SAYS, DEAL SHAPE BY DEAL SHAPE.
 *
 * `verify-payment-cache.cjs` proves the STORE matches the function across a whole database, which is
 * the staleness question. This asks the other one: does the function itself give the right answer
 * for each kind of deal the brokerage actually has? A corpus check cannot answer that, because it
 * can only contain the shapes somebody happened to seed.
 *
 * Every case below is a deal shape that computes differently:
 *
 *   standard / listing / preconstruction — three separate branches of the commission engine, and
 *     precon is the one that matters most: it emits one agent line PER TERM, so a four-term deal
 *     counts an agent's payments four times. `agentPaymentsPaid` iterates a LIST, not a set, and the
 *     cache has to reproduce that rather than quietly fix it.
 *   split deals — several agents on one deal, which is what makes `calc_agent_name_count` more than
 *     one and lets "Partially Paid" exist at all.
 *   team changes — a member removed after a payment was recorded against them. The blob still names
 *     them; the deal no longer does. The cached figures follow the CURRENT members, because that is
 *     what the report shows.
 *   zero commission — the value that decides "Not Applicable", and the reason NULL and 0 must not be
 *     conflated in the column.
 *   N/A — the recorded outcome that beats every computed one.
 *   malformed legacy data — a blob that is not JSON at all. The parsers fall back; so must this, and
 *     the row must still get a value rather than being skipped.
 *
 * EVERY ASSERTION IS AGAINST THE ENGINE, NOT AGAINST A LITERAL. A hard-coded expected dollar figure
 * would be asserting today's commission rules, which is a different test and a brittle one — these
 * ask that the cache equals what `CommissionService` and the report parsers say, to the cent.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx as unknown as PrismaService);
      throw new Error(ROLLBACK);
    }, { timeout: 120000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const svcFor = (tx: PrismaService) => new PaymentCacheService(tx, new CommissionService(new PersonResolver(tx)));

/** What the REPORT would compute for this deal, brokerage-wide — the thing the cache must equal. */
async function expected(tx: PrismaService, id: number) {
  const t = await tx.transactions.findUnique({ where: { id }, include: commissionInclude });
  const bd = await new CommissionService(new PersonResolver(tx)).breakdown(normalizeCommissionTxn(t!));
  const names = agentLines(bd).map((l) => String(l.name ?? '')).filter((n) => n !== '');
  const paid = agentPaymentsPaid(parseJsonObject(t!.admin_activities), names);
  return {
    comm: agentCommission(bd).total,
    paidTotal: paid.totalPaid,
    paidNames: paid.paidNames.length,
    names: names.length,
  };
}

const cents = (v: unknown) => Math.round(Number(v ?? 0) * 100);

/** A payment row in the shape `admin_activities.agents[name].payments[]` actually holds. */
const payment = (status: string, amount: number, date = '2026-03-01') =>
  ({ paid_type: 'TDB-EFT', paid_status: status, amount: String(amount), paid_date: date, batch_no: 'W09-2026' });

async function makeDeal(tx: PrismaService, opts: {
  type: string;
  members: { name: string; split: number }[];
  admin?: unknown;
  tracker?: unknown;
  price?: number;
  commPct?: number | null;
  terms?: number;
}) {
  const now = new Date();
  const t = await tx.transactions.create({
    data: {
      trade_no: `PAYCACHE-${Date.now()}-${String(++seq).padStart(3, '0')}`,
      type: opts.type,
      agent: opts.members[0]?.name ?? 'Nobody',
      price: opts.price ?? 800_000,
      comm_type: '%', comm_value: 5,
      comm_pct: opts.commPct === undefined ? 2.5 : opts.commPct,
      comm_status: 'Pending',
      precon_term_count: opts.terms ?? null,
      admin_activities: typeof opts.admin === 'string' ? opts.admin : JSON.stringify(opts.admin ?? {}),
      activity_tracker: typeof opts.tracker === 'string' ? opts.tracker : JSON.stringify(opts.tracker ?? {}),
      adjustments: '{}',
      closing_date: new Date('2026-05-01T00:00:00.000Z'),
      created_at: now, updated_at: now,
    },
  });
  let p = 0;
  for (const m of opts.members) {
    await tx.team_members.create({
      data: {
        transaction_id: t.id, name: m.name, split: m.split, agent_pct: 90, brok_pct: 10,
        is_primary: p === 0, access: 'docs', scope: 'Entire', position: p++,
        created_at: now, updated_at: now,
      },
    });
  }
  return t.id;
}

/** Compute and store, then read the row back — the full round trip the write path performs. */
async function cacheAndRead(tx: PrismaService, id: number) {
  await svcFor(tx).recompute([id]);
  return tx.transactions.findUnique({
    where: { id },
    select: {
      calc_agent_comm_total: true, calc_paid_total: true, calc_paid_name_count: true,
      calc_agent_name_count: true, calc_faq_paid_status: true, calc_at: true,
    },
  });
}

describe('the cached agent figures equal the commission engine, to the cent', () => {
  jest.setTimeout(180_000);

  it.each([
    ['standard', 'Residential Buying'],
    ['listing', 'Residential Sale Listing'],
    ['commercial', 'Commercial Property Buying'],
  ])('%s deal, one agent, one paid payment', async (_label, type) => {
    await inRollback(async (tx) => {
      const id = await makeDeal(tx, {
        type,
        members: [{ name: 'Cache Agent A', split: 100 }],
        admin: { agents: { 'Cache Agent A': { payments: [payment('Paid', 5000)] } } },
      });
      const row = await cacheAndRead(tx, id);
      const want = await expected(tx, id);

      expect(cents(row!.calc_agent_comm_total)).toBe(cents(want.comm));
      expect(cents(row!.calc_paid_total)).toBe(cents(want.paidTotal));
      expect(row!.calc_paid_name_count).toBe(want.paidNames);
      expect(row!.calc_agent_name_count).toBe(want.names);
      expect(row!.calc_at).not.toBeNull();
    });
  });

  /**
   * Preconstruction, which emits one agent line PER TERM.
   *
   * The multiset is the point: with four terms and one agent, `names` has four entries and
   * `agentPaymentsPaid` walks the payments four times. The cache must agree with that, including the
   * quadrupled paid total — the reports show it and correcting it here would make the two disagree.
   */
  it('preconstruction counts an agent once per term, as the reports do', async () => {
    await inRollback(async (tx) => {
      const id = await makeDeal(tx, {
        type: 'Preconstruction',
        members: [{ name: 'Cache Precon', split: 100 }],
        terms: 4,
        admin: { agents: { 'Cache Precon': { payments: [payment('Paid', 1000)] } } },
      });
      const row = await cacheAndRead(tx, id);
      const want = await expected(tx, id);

      expect(cents(row!.calc_agent_comm_total)).toBe(cents(want.comm));
      expect(cents(row!.calc_paid_total)).toBe(cents(want.paidTotal));
      expect(row!.calc_agent_name_count).toBe(want.names);
    });
  });

  it('a split deal counts every agent, and partial payment shows as fewer paid names', async () => {
    await inRollback(async (tx) => {
      const id = await makeDeal(tx, {
        type: 'Residential Buying',
        members: [
          { name: 'Cache Split One', split: 60 },
          { name: 'Cache Split Two', split: 40 },
        ],
        admin: {
          agents: {
            'Cache Split One': { payments: [payment('Paid', 3000)] },
            'Cache Split Two': { payments: [payment('Pending', 2000)] },
          },
        },
      });
      const row = await cacheAndRead(tx, id);
      const want = await expected(tx, id);

      expect(row!.calc_agent_name_count).toBe(2);
      // One of the two has a Paid row: this is exactly the "Partially Paid" case.
      expect(row!.calc_paid_name_count).toBe(1);
      expect(row!.calc_paid_name_count).toBe(want.paidNames);
      expect(cents(row!.calc_paid_total)).toBe(cents(want.paidTotal));
      expect(cents(row!.calc_agent_comm_total)).toBe(cents(want.comm));
    });
  });

  /**
   * A member removed after a payment was recorded against them.
   *
   * The blob still names the departed agent; the deal no longer does. The cached figures follow the
   * CURRENT members, because `agentPaymentsPaid` is scoped to the names the breakdown emits — so the
   * departed agent's payment stops counting, which is what the report shows.
   */
  it('follows a team change: a removed member stops counting', async () => {
    await inRollback(async (tx) => {
      const id = await makeDeal(tx, {
        type: 'Residential Buying',
        members: [{ name: 'Cache Stay', split: 50 }, { name: 'Cache Leave', split: 50 }],
        admin: {
          agents: {
            'Cache Stay': { payments: [payment('Paid', 1000)] },
            'Cache Leave': { payments: [payment('Paid', 9999)] },
          },
        },
      });
      const before = await cacheAndRead(tx, id);
      expect(before!.calc_agent_name_count).toBe(2);
      expect(before!.calc_paid_name_count).toBe(2);

      await tx.team_members.deleteMany({ where: { transaction_id: id, name: 'Cache Leave' } });

      const after = await cacheAndRead(tx, id);
      const want = await expected(tx, id);
      expect(after!.calc_agent_name_count).toBe(1);
      expect(after!.calc_paid_name_count).toBe(want.paidNames);
      expect(cents(after!.calc_paid_total)).toBe(cents(want.paidTotal));
      // The departed agent's 9,999 is gone from the total, not merely from the count.
      expect(Number(after!.calc_paid_total)).toBeLessThan(Number(before!.calc_paid_total));
    });
  });

  /** Zero commission — the value that makes a deal "Not Applicable", and must not read as absent. */
  it('stores a zero commission as zero, not as NULL', async () => {
    await inRollback(async (tx) => {
      const id = await makeDeal(tx, {
        type: 'Residential Buying',
        members: [{ name: 'Cache Zero', split: 100 }],
        price: 0, commPct: 0,
        admin: {},
      });
      const row = await cacheAndRead(tx, id);
      const want = await expected(tx, id);

      expect(cents(row!.calc_agent_comm_total)).toBe(cents(want.comm));
      expect(row!.calc_agent_comm_total).not.toBeNull();
      expect(cents(row!.calc_agent_comm_total)).toBe(0);
      expect(row!.calc_at).not.toBeNull();
    });
  });

  it('records the N/A and Yes tracker outcomes verbatim', async () => {
    await inRollback(async (tx) => {
      for (const faq of ['Yes', 'N/A', 'Not Applicable', '']) {
        const id = await makeDeal(tx, {
          type: 'Residential Buying',
          members: [{ name: 'Cache Faq', split: 100 }],
          admin: { agents: { 'Cache Faq': { payments: [] } } },
          tracker: { agent_commission_paid_status: faq },
        });
        const row = await cacheAndRead(tx, id);
        expect(row!.calc_faq_paid_status).toBe(faq);
      }
    });
  });

  /**
   * Legacy rows whose blob is not JSON at all.
   *
   * The parsers fall back to an empty object rather than throwing, and so must this — the row still
   * has to get a value, because a skipped row would leave `calc_at` NULL for ever and quietly keep
   * the slow path alive on exactly the deals nobody looks at.
   */
  it.each([
    ['not json', 'this is not json'],
    ['truncated', '{"agents": {"Cache Bad": {"payments": ['],
    ['empty string', ''],
    ['a json array', '[1,2,3]'],
  ])('survives malformed legacy data (%s)', async (_label, blob) => {
    await inRollback(async (tx) => {
      const id = await makeDeal(tx, {
        type: 'Residential Buying',
        members: [{ name: 'Cache Bad', split: 100 }],
        admin: blob,
      });
      const row = await cacheAndRead(tx, id);
      const want = await expected(tx, id);

      expect(row!.calc_at).not.toBeNull();
      expect(cents(row!.calc_paid_total)).toBe(cents(want.paidTotal));
      expect(cents(row!.calc_agent_comm_total)).toBe(cents(want.comm));
      expect(row!.calc_paid_name_count).toBe(want.paidNames);
    });
  });

  /** A deal with no members at all: no names, no paid figure, and a commission of zero. */
  it('handles a deal with no agent lines', async () => {
    await inRollback(async (tx) => {
      const id = await makeDeal(tx, { type: 'Residential Buying', members: [], admin: {} });
      const row = await cacheAndRead(tx, id);
      const want = await expected(tx, id);
      expect(row!.calc_agent_name_count).toBe(want.names);
      expect(cents(row!.calc_paid_total)).toBe(cents(want.paidTotal));
      expect(cents(row!.calc_agent_comm_total)).toBe(cents(want.comm));
    });
  });
});

afterAll(async () => { await prisma.$disconnect(); });
