import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CommissionService } from '../transactions/commission.service';
import { PersonResolver } from '../core/person-resolver.service';
import { ReportDataService } from './report-data.service';
import { ReportsService } from './reports.service';
import { expiryStatusSql, EXPIRY_VALUES } from './report-conds.sql';
import { expiryStatus } from './report-documents';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * THE GATE ON THE CONDITION-ROW FAST PATH — Conditional Offers and Expiry.
 *
 * The report emits one row per condition and used to build every one of them in memory, enriching
 * each conditional deal in the brokerage with its documents AND its conditions to display
 * twenty-five rows. Measured at 80,000 deals: 8.2 s.
 *
 * FOUR THINGS HAVE TO BE RIGHT NOW, and none of them fails loudly:
 *
 *   THE EXPIRY LADDER. `expiryStatus` is six branches over a status word and a deadline, and the
 *   recorded outcomes beat the date. Transliterated wrongly, a fulfilled condition starts reporting
 *   as expired — which reads as a data problem rather than a reporting one.
 *
 *   TODAY. The TypeScript uses the UTC date; `current_date` is the session's. This suite pins the
 *   two against each other for deadlines either side of the boundary, because the disagreement only
 *   appears for a few hours a day and would otherwise be found by a user rather than by a test.
 *
 *   THE DEAL WITH NO CONDITIONS. It is still one row of the report. It has to be counted, filtered
 *   and paged with the rest, or a page boundary falling in a run of them is silently off.
 *
 *   THE FILTER'S REACH. It qualifies DEALS: a deal with one Expired condition shows all its
 *   conditions, Active ones included. Filtering rows instead gives a shorter, plausible, wrong
 *   report — which is why the filtered comparison below is the load-bearing assertion here.
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

const admin: AuthUserRecord = { id: 1, name: 'Cond Admin', role: 'admin', user_permissions: [], user_modules: [] } as unknown as AuthUserRecord;

const presented = (r: { rows: Record<string, unknown>[]; totals: unknown; total_count: number; page: number; last_page: number; sections?: unknown }) => ({
  rows: r.rows, totals: r.totals, total_count: r.total_count, page: r.page, last_page: r.last_page, sections: r.sections,
});

const serviceFor = (tx: PrismaService) =>
  new ReportsService(new ReportDataService(tx, new CommissionService(new PersonResolver(tx))), tx);

/**
 * Run the report through the ORIGINAL enrichment path.
 *
 * `runFastCondRows` is entered only for this exact report type, so there is no registry entry to
 * remove — the switch is the type itself. Renaming it for the duration is what turns the fast path
 * off while leaving everything else about the run identical.
 */
async function slowly(svc: ReportsService, query: Record<string, unknown>) {
  const svcAny = svc as unknown as { runFastCondRows: unknown };
  const saved = svcAny.runFastCondRows;
  svcAny.runFastCondRows = async () => null;
  try {
    return await (svc.run('conditional-offers', admin, query as never) as Promise<never>);
  } finally {
    svcAny.runFastCondRows = saved;
  }
}

/** UTC today, and offsets from it — the same clock `expiryStatus` reads. */
const utcToday = () => new Date().toISOString().slice(0, 10);
const dayOffset = (n: number) => {
  const d = new Date(`${utcToday()}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
};

/**
 * Deals covering every branch of the ladder and every shape of row.
 *
 * The offsets are chosen against `EXPIRING_SOON_DAYS = 3`: -1 is Expired, 0 and 3 are the two edges
 * of Expiring Soon, 4 is the first Active. Both edges are here because an off-by-one in the
 * transliteration moves exactly one of them.
 */
async function fixture(tx: PrismaService) {
  const now = new Date();
  const stamp = Date.now();

  const mk = async (agent: string, conds: { type: string; status: string; deadline: Date | null }[], flag = true) => {
    const t = await tx.transactions.create({
      data: {
        trade_no: `CONDROW-${stamp}-${String(++seq).padStart(3, '0')}`,
        type: 'Residential Buying', agent, price: 500_000 + seq * 1_000,
        comm_type: '%', comm_value: 0, comm_pct: 2.5, comm_status: 'Pending', comm_paid_status: 'No',
        conditional_offer: flag,
        closing_date: new Date('2025-06-15T00:00:00.000Z'), offer_date: new Date('2025-03-01T00:00:00.000Z'),
        adjustments: '{}', admin_activities: '{}', activity_tracker: '{}', created_at: now, updated_at: now,
      },
    });
    let p = 0;
    for (const c of conds) {
      await tx.conditions.create({
        data: {
          transaction_id: t.id, type: c.type, status: c.status, deadline: c.deadline,
          position: p++, created_at: now, updated_at: now,
        },
      });
    }
    // A document apiece, because the report also prints waiver and amendment documentation.
    await tx.documents.create({
      data: {
        transaction_id: t.id, title: 'Waiver of Conditions', validation: 'Pending', status: 'Pending',
        position: 0, created_at: now, updated_at: now,
      },
    });
    return t.id;
  };

  // Every ladder branch on one deal, so a single deal spans several expiry statuses.
  await mk('Cond Agent 0', [
    { type: 'Financing', status: 'Pending', deadline: dayOffset(-1) },   // Expired
    { type: 'Home Inspection', status: 'Pending', deadline: dayOffset(0) },    // Expiring Soon (edge)
    { type: 'Status Certificate', status: 'Pending', deadline: dayOffset(3) }, // Expiring Soon (edge)
    { type: 'Lawyer Review', status: 'Pending', deadline: dayOffset(4) },      // Active (first)
  ]);
  // The recorded outcomes, which must beat the date — every one of these deadlines is long past.
  await mk('Cond Agent 1', [
    { type: 'Financing', status: 'Fulfilled', deadline: dayOffset(-30) },
    { type: 'Financing', status: 'completed', deadline: dayOffset(-30) },
    { type: 'Financing', status: 'SATISFIED', deadline: dayOffset(-30) },
    { type: 'Financing', status: ' Waived ', deadline: dayOffset(-30) },
    { type: 'Financing', status: 'Extended', deadline: dayOffset(-30) },
  ]);
  // No deadline at all — Active regardless of status word.
  await mk('Cond Agent 2', [{ type: 'Sale of Property', status: 'Pending', deadline: null }]);
  // Conditional by FLAG with no condition rows: the "—" row.
  await mk('Cond Bare', [], true);
  // Not conditional at all and no conditions: must not appear.
  await mk('Cond None', [], false);
  // Conditional by CONDITIONS only, flag false — still conditional.
  await mk('Cond Implied', [{ type: 'Financing', status: 'Pending', deadline: dayOffset(10) }], false);
}

describe('the expiry ladder agrees between SQL and TypeScript', () => {
  jest.setTimeout(180_000);

  it('every status word and every deadline edge', async () => {
    const today = utcToday();
    const cases: { status: string; deadline: string | null }[] = [];
    for (const status of ['Pending', 'Fulfilled', 'completed', 'SATISFIED', ' Waived ', 'Extended', '', 'unknown']) {
      for (const off of [-30, -1, 0, 1, 3, 4, 30]) {
        const d = new Date(`${today}T00:00:00.000Z`);
        d.setUTCDate(d.getUTCDate() + off);
        cases.push({ status, deadline: d.toISOString().slice(0, 10) });
      }
      cases.push({ status, deadline: null });
    }

    /*
     * Both arrays are `text[]`, with the absent deadline carried as '' and cast back inside.
     * A `date[]` containing a null is rejected by the driver — "improper binary format in array
     * element" — and the null deadline is the branch most worth testing, so it travels as a string.
     */
    const rows = await prisma.$queryRawUnsafe<{ status: string; deadline: string | null; expiry: string }[]>(
      `SELECT c.status, c.deadline::text AS deadline, ${expiryStatusSql(`'${today}'`)} AS expiry
       FROM (
         SELECT x.status, NULLIF(x.d, '')::date AS deadline
         FROM unnest($1::text[], $2::text[]) AS x(status, d)
       ) c`,
      cases.map((c) => c.status),
      cases.map((c) => c.deadline ?? ''),
    );

    const wrong = rows.filter((r, i) => r.expiry !== expiryStatus({ status: cases[i].status, deadline: cases[i].deadline }, today));
    expect(wrong).toEqual([]);
    // And the SQL only ever produces values the filter knows about.
    for (const r of rows) expect(EXPIRY_VALUES).toContain(r.expiry);
  });
});

describe('the condition-row fast path returns exactly what the enrichment path returns', () => {
  jest.setTimeout(180_000);

  it('the whole report, unfiltered', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const svc = serviceFor(tx);
      const q = { filters: {}, page: 1, per_page: 500 };
      const fast = await svc.run('conditional-offers', admin, q as never);
      expect(presented(fast)).toEqual(presented(await slowly(svc, q)));
      expect(fast.total_count).toBeGreaterThan(5);
    });
  });

  it('every page, so the ordering has to agree all the way down', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const svc = serviceFor(tx);
      const first = await svc.run('conditional-offers', admin, { filters: {}, page: 1, per_page: 3 } as never);
      expect(first.last_page).toBeGreaterThan(2);
      for (let page = 1; page <= first.last_page; page++) {
        const q = { filters: {}, page, per_page: 3 };
        expect(presented(await svc.run('conditional-offers', admin, q as never)))
          .toEqual(presented(await slowly(svc, q)));
      }
    });
  });

  it('keeps a deal’s other conditions when one of them matches the expiry filter', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const svc = serviceFor(tx);
      for (const status of EXPIRY_VALUES) {
        const q = { filters: { status }, page: 1, per_page: 500 };
        expect(presented(await svc.run('conditional-offers', admin, q as never)))
          .toEqual(presented(await slowly(svc, q)));
      }
    });
  });

  it('the deal with no conditions is one row, and only under Active', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const svc = serviceFor(tx);
      const bare = (r: { rows: Record<string, unknown>[] }) =>
        r.rows.filter((x) => String(x.trade_no ?? '').includes('CONDROW') && x.condition_type === '—');

      const all = await svc.run('conditional-offers', admin, { filters: {}, page: 1, per_page: 500 } as never);
      expect(bare(all).length).toBe(1);
      expect(bare(all)).toEqual(bare(await slowly(svc, { filters: {}, page: 1, per_page: 500 })));

      const active = await svc.run('conditional-offers', admin, { filters: { status: 'Active' }, page: 1, per_page: 500 } as never);
      expect(bare(active).length).toBe(1);
      const expired = await svc.run('conditional-offers', admin, { filters: { status: 'Expired' }, page: 1, per_page: 500 } as never);
      expect(bare(expired).length).toBe(0);
    });
  });

  it('with a global filter narrowing the deals as well', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const svc = serviceFor(tx);
      for (const filters of [
        { deal_type: ['Residential Buying'] },
        { agent: ['Cond Agent 0'] },
        { closing_date_from: '2025-01-01', closing_date_to: '2025-12-31' },
      ]) {
        const q = { filters, page: 1, per_page: 500 };
        expect(presented(await svc.run('conditional-offers', admin, q as never)))
          .toEqual(presented(await slowly(svc, q)));
      }
    });
  });

  it('DECLINES a sort it cannot produce, and still answers it correctly', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const svc = serviceFor(tx);
      for (const q of [
        { filters: {}, page: 1, per_page: 500, sort: 'condition_type', dir: 'asc' },
        { filters: {}, page: 1, per_page: 500, sort: 'condition_expiry', dir: 'desc' },
      ]) {
        expect(presented(await svc.run('conditional-offers', admin, q as never)))
          .toEqual(presented(await slowly(svc, q)));
      }
    });
  });

  it('reports no sections — this report has none', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const svc = serviceFor(tx);
      const fast = await svc.run('conditional-offers', admin, { filters: {}, page: 1, per_page: 5 } as never);
      expect(fast.sections).toBeUndefined();
    });
  });
});

afterAll(async () => { await prisma.$disconnect(); });
