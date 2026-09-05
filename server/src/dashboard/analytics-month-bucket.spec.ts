import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CommissionService } from '../transactions/commission.service';
import { PersonResolver } from '../core/person-resolver.service';
import { DeskAnalyticsService, NO_CLOSING_DATE } from './desk-analytics.service';
import { parseAnalyticsFilters } from './desk-analytics.filters';
import type { ScopedUser } from '../common/transaction-scope';

/**
 * TD-092 — a deal with no closing date is charted as having none.
 *
 * THE DEFECT. The chart is headed "Commission by Closing Month", and the month came from
 * `COALESCE(closing_date, offer_date)` with no-date deals filtered out. One missing field therefore
 * produced two different wrong answers, chosen by whichever other date the deal happened to carry:
 *
 *   · with an offer date, the commission was charted as CLOSING in the offer month. Measured on a
 *     50,000 deal whose closing date was cleared: the 2027-03 bar fell by exactly 50,000 and the
 *     offer month rose by exactly 50,000, headline unchanged. The arithmetic reconciles perfectly,
 *     which is why a careful month-end review would never catch it;
 *   · with neither date, the deal vanished from the chart (the residue of TD-044).
 *
 * Both are now one bucket that says what it is. These tests build the state by CLEARING a closing
 * date, the way the defect was reproduced, and assert where the money goes — not merely that the
 * totals still add up, because they always did.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

afterAll(async () => { await prisma.$disconnect(); });

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

const analyticsFor = (tx: PrismaService) => new DeskAnalyticsService(tx, new CommissionService(new PersonResolver(tx)));
const OFFICE: ScopedUser = { id: 1, name: 'An Admin', role: 'admin' };

/**
 * An agent to filter by.
 *
 * The Analytics agent filter is BY USER ID, never by name — it is an authorization boundary, not a
 * convenience — so the fixture needs a real account and its deals need `agent_user_id`. Filtering
 * is what makes the fixture the whole picture: this runs against the development database.
 */
async function makeAgent(tx: PrismaService) {
  const now = new Date();
  const n = ++seq;
  return tx.users.create({
    data: {
      name: `TD092 Agent ${Date.now()}-${n}`, email: `td092-${Date.now()}-${n}@x.test`, password: 'x',
      role: 'agent', status: 'Active', profile: '{"agent_comm_pct":"90"}', created_at: now, updated_at: now,
    },
    select: { id: true, name: true },
  });
}

/** One deal worth a round commission, with both dates set. */
async function deal(tx: PrismaService, agent: { id: number; name: string }, offer: string, closing: string | null) {
  const now = new Date();
  return tx.transactions.create({
    data: {
      trade_no: `TD092-${Date.now()}-${++seq}`, type: 'Residential Buying',
      agent: agent.name, agent_user_id: agent.id,
      property: '1 Closing Month Road',
      price: 2_000_000, comm_type: '%', comm_value: 2.5, comm_pct: 2.5,
      offer_date: new Date(`${offer}T00:00:00.000Z`),
      closing_date: closing ? new Date(`${closing}T00:00:00.000Z`) : null,
      adjustments: '{}', admin_activities: '{}', activity_tracker: '{}', created_at: now, updated_at: now,
    },
  });
}

/** The chart, filtered to one agent so the fixture is the whole picture. */
const chart = async (tx: PrismaService, agent: { id: number }): Promise<{ months: Record<string, number>; total: number }> => {
  const filters = parseAnalyticsFilters({ agent_user_id: agent.id }, OFFICE as never);
  const a = await analyticsFor(tx).summary(OFFICE, filters);
  return {
    months: Object.fromEntries(a.by_month.map((m) => [m.month, m.total])),
    total: a.totals.total,
  };
};

describe('the commission-by-closing-month chart (TD-092)', () => {
  jest.setTimeout(120_000);

  it('puts a deal in the month it closes', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      await deal(tx, agent, '2026-01-10', '2027-03-15');

      const { months } = await chart(tx, agent);
      expect(Object.keys(months)).toEqual(['2027-03']);
    });
  });

  it('moves it to the no-closing-date bucket when the date is cleared — not to its offer month', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const t = await deal(tx, agent, '2026-01-10', '2027-03-15');
      const before = await chart(tx, agent);

      await tx.transactions.update({ where: { id: t.id }, data: { closing_date: null } });
      const after = await chart(tx, agent);

      // Where the money went is the whole defect: the offer month must not have taken it.
      expect(after.months['2027-03']).toBeUndefined();
      expect(after.months['2026-01']).toBeUndefined();
      expect(after.months[NO_CLOSING_DATE]).toBe(before.months['2027-03']);
      // And nothing was dropped — the headline is unchanged, which is what TD-044 established.
      expect(after.total).toBe(before.total);
    });
  });

  it('keeps a deal with neither date on the chart, in the same bucket', async () => {
    // The other branch of the same missing field: this one used to vanish altogether.
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      const t = await deal(tx, agent, '2026-01-10', null);
      await tx.transactions.update({ where: { id: t.id }, data: { offer_date: null } });

      const { months, total } = await chart(tx, agent);
      expect(Object.keys(months)).toEqual([NO_CLOSING_DATE]);
      expect(months[NO_CLOSING_DATE]).toBe(total);
    });
  });

  it('sorts the months in order and leaves the no-date bucket last', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      await deal(tx, agent, '2026-01-10', '2027-03-15');
      await deal(tx, agent, '2026-01-10', '2026-11-01');
      await deal(tx, agent, '2026-01-10', null);

      const filters = parseAnalyticsFilters({ agent_user_id: agent.id }, OFFICE as never);
      const a = await analyticsFor(tx).summary(OFFICE, filters);
      expect(a.by_month.map((m) => m.month)).toEqual(['2026-11', '2027-03', NO_CLOSING_DATE]);
    });
  });

  it('still adds up: the buckets sum to the headline, with or without dates', async () => {
    await inRollback(async (tx) => {
      const agent = await makeAgent(tx);
      await deal(tx, agent, '2026-01-10', '2027-03-15');
      await deal(tx, agent, '2026-02-10', null);

      const filters = parseAnalyticsFilters({ agent_user_id: agent.id }, OFFICE as never);
      const a = await analyticsFor(tx).summary(OFFICE, filters);
      const summed = a.by_month.reduce((n, m) => n + m.total, 0);
      expect(Math.abs(summed - a.totals.total)).toBeLessThan(0.005);
    });
  });
});
