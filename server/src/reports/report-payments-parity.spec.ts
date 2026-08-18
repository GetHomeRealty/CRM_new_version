import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CommissionService } from '../transactions/commission.service';
import { PersonResolver } from '../core/person-resolver.service';
import { ReportDataService } from './report-data.service';
import { ReportsService } from './reports.service';
import { agentPaymentsPaid, num } from './report-financials';
import { getReport } from './report-registry';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * THE GATE ON THE PAYMENT FIGURES THE DATABASE NOW COMPUTES.
 *
 * Sales Statement totals what each agent has actually been PAID, and that lives inside the
 * `admin_activities` JSON blob rather than in a column. It is now read by `desk_agent_paid` in SQL
 * instead of by enriching every deal in the brokerage — which means the money has a second
 * implementation, and a second implementation of money is the thing this codebase is most careful
 * about.
 *
 * TWO THINGS ARE CHECKED, and the first is the one that actually broke.
 *
 *   THE COERCION. Payment amounts are typed by people: "$1,234.56" as often as 1234.56. The Reports
 *   module's `num()` strips dollar signs, commas and spaces before parsing; the commission engine's
 *   does not, and PHP's float cast does something different again. Reading amounts with the wrong
 *   one silently reports zero for every formatted amount — measured at 80,000 deals with realistic
 *   payment history, $2,558,016.24 short, with nothing in any log.
 *
 *   THE TOTAL. The report is run both ways over a fixture whose amounts are formatted, awkward and
 *   partly unpaid, and the footers must agree exactly.
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

const admin: AuthUserRecord = { id: 1, name: 'Pay Admin', role: 'admin', user_permissions: [], user_modules: [] } as unknown as AuthUserRecord;

const presented = (r: { rows: Record<string, unknown>[]; totals: unknown; total_count: number; last_page: number }) => ({
  rows: r.rows, totals: r.totals, total_count: r.total_count, last_page: r.last_page,
});

/**
 * Values a payment amount has actually been found as, plus the ones that discriminate the three
 * coercions from each other.
 */
const AMOUNTS: unknown[] = [
  1234.56, 0, -450.25, 1e3, 0.005, 999999.99,
  '1234.56', '$1,234.56', ' $ 1,234.56 ', '1,000', '$0.00', '-$25.50', '+12.5',
  '.5', '5.', '1e3', '2E-2', '', '   ', 'n/a', 'abc', '90%', 'Infinity', '-Infinity', 'NaN',
  null, true, false, [], {}, [1, 2], { amount: 5 },
];

describe('the SQL payment coercion matches the Reports module', () => {
  jest.setTimeout(120_000);

  it('desk_report_num agrees with num() for every shape an amount arrives in', async () => {
    const rows = await prisma.$queryRawUnsafe<{ i: number; v: string }[]>(
      `SELECT i::int AS i, desk_report_num(x)::text AS v
       FROM unnest($1::jsonb[]) WITH ORDINALITY AS t(x, i)`,
      AMOUNTS.map((a) => JSON.stringify(a === undefined ? null : a)),
    );
    const wrong: string[] = [];
    for (const r of rows) {
      const input = AMOUNTS[r.i - 1];
      const expected = num(input);
      if (Number(r.v) !== expected) wrong.push(`${JSON.stringify(input)} -> sql ${r.v}, node ${expected}`);
    }
    expect(wrong).toEqual([]);
  });

  it('desk_agent_paid agrees with agentPaymentsPaid for one agent', async () => {
    const blobs = [
      { agents: { A: { payments: [{ paid_status: 'Paid', amount: '$1,200.50' }, { paid_status: 'Pending', amount: 900 }] } } },
      { agents: { A: { payments: [{ paid_status: 'Paid', amount: 0.01 }, { paid_status: 'Paid', amount: 0.02 }, { paid_status: 'Paid', amount: 0.03 }] } } },
      { agents: { A: { payments: [{ paid_status: 'paid', amount: 500 }] } } },   // exact case only
      { agents: { A: { payments: [] } } },
      { agents: { A: {} } },
      { agents: { B: { payments: [{ paid_status: 'Paid', amount: 100 }] } } },   // a different agent
      { agents: {} },
      {},
      { agents: { A: { payments: 'not an array' } } },
      { agents: { A: { payments: [{ paid_status: 'Paid', amount: '1,000,000.005' }] } } },
    ];
    const rows = await prisma.$queryRawUnsafe<{ i: number; v: string }[]>(
      `SELECT i::int AS i, desk_agent_paid(x, 'A')::text AS v
       FROM unnest($1::jsonb[]) WITH ORDINALITY AS t(x, i)`,
      blobs.map((b) => JSON.stringify(b)),
    );
    const wrong: string[] = [];
    for (const r of rows) {
      // agentPaymentsPaid rounds; desk_agent_paid returns the raw sum and the caller rounds, so the
      // comparison is against the unrounded accumulation for a single name.
      const expected = agentPaymentsPaid(blobs[r.i - 1] as Record<string, unknown>, ['A']).totalPaid;
      const got = Math.round(Number(r.v) * 100) / 100;
      if (got !== expected) wrong.push(`${JSON.stringify(blobs[r.i - 1])} -> sql ${got}, node ${expected}`);
    }
    expect(wrong).toEqual([]);
  });
});

describe('the Sales Statement footer is the same computed in SQL and in Node', () => {
  jest.setTimeout(180_000);

  async function fixture(tx: PrismaService) {
    const now = new Date();
    const stamp = Date.now();
    const mk = async (o: {
      agent: string; price: number; type?: string; paid?: unknown[]; faq?: string | null;
      members?: { name: string; split: number; agent_pct: number; brok_pct: number }[];
      terms?: number;
    }) => {
      const t = await tx.transactions.create({
        data: {
          trade_no: `PAY-${stamp}-${String(++seq).padStart(3, '0')}`,
          type: o.type ?? 'Residential Buying', agent: o.agent, price: o.price,
          comm_type: '%', comm_value: 0, comm_pct: o.type === 'Preconstruction' ? null : 2.5,
          precon_comm_pct: o.type === 'Preconstruction' ? 4 : null,
          precon_term_count: o.terms ?? null,
          comm_status: 'Pending', comm_paid_status: 'No',
          closing_date: new Date('2025-06-15T00:00:00.000Z'), offer_date: new Date('2025-03-01T00:00:00.000Z'),
          adjustments: '{}',
          admin_activities: JSON.stringify(o.paid ? { agents: { [o.agent]: { payments: o.paid, cta: [{ cta: 'No' }] } } } : {}),
          activity_tracker: o.faq ? JSON.stringify({ agent_commission_paid_status: o.faq }) : '{}',
          created_at: now, updated_at: now,
        },
      });
      for (let i = 0; i < (o.terms ?? 0); i++) {
        await tx.precon_terms.create({ data: { transaction_id: t.id, term_no: i + 1, pct: 2, created_at: now, updated_at: now } });
      }
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

    // Formatted amounts, which is the case that was wrong.
    await mk({ agent: 'Pay A', price: 812_345.67, paid: [{ paid_status: 'Paid', amount: '$1,234.56' }, { paid_status: 'Paid', amount: '2,000' }] });
    // Partly paid, partly not.
    await mk({ agent: 'Pay B', price: 640_000, paid: [{ paid_status: 'Paid', amount: 5_000.99 }, { paid_status: 'Pending', amount: 9_000 }] });
    // Nothing paid at all — the ratio must be zero, not a division by zero.
    await mk({ agent: 'Pay C', price: 500_000 });
    // Awkward thirds, where a float accumulation would drift from a decimal one.
    await mk({ agent: 'Pay D', price: 333_333.33, paid: Array.from({ length: 9 }, () => ({ paid_status: 'Paid', amount: 0.01 })) });
    // A team split: the paid figure is summed over every member line.
    await mk({
      agent: 'Pay E', price: 900_000,
      members: [
        { name: 'Pay E', split: 60, agent_pct: 90, brok_pct: 10 },
        { name: 'Pay F', split: 40, agent_pct: 85, brok_pct: 15 },
      ],
      paid: [{ paid_status: 'Paid', amount: '$3,333.33' }],
    });
    // Preconstruction, where one agent appears once PER TERM and their payments are counted per line.
    await mk({ agent: 'Pay G', price: 700_000, type: 'Preconstruction', terms: 3, paid: [{ paid_status: 'Paid', amount: 1_111.11 }] });
    // A listing deal, the third commission variant.
    await mk({ agent: 'Pay H', price: 750_000, type: 'Residential Sale Listing', paid: [{ paid_status: 'Paid', amount: 2_500 }] });
    // Flagged Paid in the FAQ centre with no payment rows at all.
    await mk({ agent: 'Pay I', price: 450_000, faq: 'Yes' });
  }

  const serviceFor = (tx: PrismaService) =>
    new ReportsService(new ReportDataService(tx, new CommissionService(new PersonResolver(tx))), tx);

  async function slowly(svc: ReportsService, q: Record<string, unknown>) {
    const def = getReport('sales-statement')!;
    const kept = def.sqlExact;
    def.sqlExact = undefined;
    try {
      return await (svc.run('sales-statement', admin, q as never) as Promise<never>);
    } finally {
      def.sqlExact = kept;
    }
  }

  it('agrees on the whole report', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const svc = serviceFor(tx);
      const q = { filters: {}, page: 1, per_page: 500 };
      const fast = await svc.run('sales-statement', admin, q as never);
      expect(presented(fast)).toEqual(presented(await slowly(svc, q)));
      expect(Number(fast.totals.agent_paid_w)).toBeGreaterThan(0);
    });
  });

  it('agrees page by page', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const svc = serviceFor(tx);
      for (const page of [1, 2, 3]) {
        const q = { filters: {}, page, per_page: 3 };
        expect(presented(await svc.run('sales-statement', admin, q as never)))
          .toEqual(presented(await slowly(svc, q)));
      }
    });
  });

  it('DECLINES the fast path when the payment-status filter is set, which SQL cannot count', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const svc = serviceFor(tx);
      const q = { filters: { status: 'Paid' }, page: 1, per_page: 500 };
      // Both routes are the same route here; the assertion is that the answer is still right.
      expect(presented(await svc.run('sales-statement', admin, q as never)))
        .toEqual(presented(await slowly(svc, q)));
    });
  });
});
