import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CommissionService } from '../transactions/commission.service';
import { PersonResolver } from '../core/person-resolver.service';
import { ReportDataService } from './report-data.service';
import { ReportsService } from './reports.service';
import { getReport } from './report-registry';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * THE TWO LISTING COLUMNS NOTHING COMPARED.
 *
 * TD-168 left `agent_w` and `brok_wo` - the agent side WITH HST and the brokerage side without it -
 * checked by no spec, on this report or any other. The entry that raised them was withdrawn because
 * the MEMBER lines were proved at parity; these two were never in that comparison. It is the same
 * gap TD-164 sat in undetected.
 *
 * Both implementations are read over the same rows: the SQL fast path the report actually runs, and
 * the TypeScript commission engine with that path switched off. They must agree exactly.
 *
 * THE FIXTURE IS CHOSEN SO THE BROKERAGE FLOOR BINDS, AND IT WAS MEASURED RATHER THAN ASSUMED.
 * A 60,000 listing at 2.5% each side makes 3,000 of commission. The report returns agent 1,001 and
 * brokerage 499 - where a 90/10 share of the 1,500 listing side would have left the brokerage 150.
 * So the brokerage's own floor decides that figure, not the percentage. That is where two
 * implementations of the same money are likeliest to part company, and nothing covered it.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx as unknown as PrismaService);
      throw new Error(ROLLBACK);
    }, { timeout: 120000, isolationLevel: 'RepeatableRead' });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const admin: AuthUserRecord = { id: 1, name: 'Yearly Admin', role: 'admin', user_permissions: [], user_modules: [] } as unknown as AuthUserRecord;

const presented = (r: { rows: Record<string, unknown>[]; totals: unknown; total_count: number; last_page: number }) => ({
  rows: r.rows, totals: r.totals, total_count: r.total_count, last_page: r.last_page,
});

async function fixture(tx: PrismaService) {
  const now = new Date();
  const stamp = Date.now();
  const mk = async (o: { agent: string; price: number; members?: { name: string; split: number; agent_pct: number; brok_pct: number }[] }) => {
    const t = await tx.transactions.create({
      data: {
        trade_no: `YRL-${stamp}-${String(++seq).padStart(3, '0')}`,
        type: 'Residential Sale Listing', agent: o.agent, price: o.price,
        comm_type: '%', comm_value: 0, listing_comm_pct: 2.5, coop_comm_pct: 2.5,
        comm_status: 'Pending', comm_paid_status: 'No',
        closing_date: new Date('2025-06-15T00:00:00.000Z'), offer_date: new Date('2025-03-01T00:00:00.000Z'),
        adjustments: '{}', admin_activities: '{}', activity_tracker: '{}',
        created_at: now, updated_at: now,
      },
    });
    let p = 0;
    for (const m of o.members ?? []) {
      await tx.team_members.create({
        data: {
          transaction_id: t.id, name: m.name, split: m.split, agent_pct: m.agent_pct, brok_pct: m.brok_pct,
          scope: 'Entire', position: p++, created_at: now, updated_at: now,
        },
      });
    }
    return t.id;
  };
  // The floor binds here: the brokerage side comes back 499, not the 150 a percentage would give.
  await mk({ agent: 'Floor One', price: 60_000 });
  // The same deal shared by two members on DIFFERENT plans, where the per-member floor decides.
  await mk({ agent: 'Floor Two', price: 60_000, members: [
    { name: 'Floor Two', split: 60, agent_pct: 90, brok_pct: 10 },
    { name: 'Floor Three', split: 40, agent_pct: 85, brok_pct: 15 },
  ] });
  // And one far above the floor, so a failure points at the floor rather than at listings generally.
  await mk({ agent: 'Roomy', price: 1_000_000 });
}

const serviceFor = (tx: PrismaService) =>
  new ReportsService(new ReportDataService(tx, new CommissionService(new PersonResolver(tx))), tx);

async function slowly(svc: ReportsService, q: Record<string, unknown>) {
  const def = getReport('yearly-deal-summary')!;
  const kept = def.sqlExact;
  def.sqlExact = undefined;
  try {
    return await (svc.run('yearly-deal-summary', admin, q as never) as Promise<never>);
  } finally {
    def.sqlExact = kept;
  }
}

describe('the Yearly Summary listing columns agree in SQL and in Node', () => {
  jest.setTimeout(180_000);

  it('agrees on every column, including agent_w and brok_wo', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const svc = serviceFor(tx);
      const q = { filters: {}, page: 1, per_page: 500 };
      const fast = await svc.run('yearly-deal-summary', admin, q as never);
      expect(presented(fast)).toEqual(presented(await slowly(svc, q)));
      // And the two columns this spec exists for carry money, rather than being quietly absent.
      const mine = fast.rows.filter((r) => String(r.trade_no ?? '').startsWith('YRL-'));
      expect(mine.length).toBe(3);
      for (const r of mine) {
        expect(Number(r.agent_w)).toBeGreaterThan(0);
        expect(Number(r.brok_wo)).toBeGreaterThan(0);
      }
    });
  });
});
