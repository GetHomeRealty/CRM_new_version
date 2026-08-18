import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CommissionService } from '../transactions/commission.service';
import { PaymentCacheService } from '../transactions/payment-cache.service';
import { PersonResolver } from '../core/person-resolver.service';
import { ReportDataService } from './report-data.service';
import { ReportsService } from './reports.service';
import { PAYMENT_STATUSES } from './report-payments.sql';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * THE GATE ON THE PAYMENT-STATUS FAST PATH.
 *
 * The report classifies every deal through a five-rung ladder and groups the result into four
 * sections. Both are now SQL over the cached columns instead of a walk over enriched deals, and the
 * two have to agree exactly — a rung transliterated out of order does not fail, it silently moves
 * deals between sections, which reads as a bookkeeping error rather than a bug.
 *
 * `payment-cache.spec.ts` proves the COLUMNS equal the engine. This proves the REPORT built on them
 * equals the report built without them: same rows, same sections, same counts, same money.
 *
 * FOUR THINGS ARE ASSERTED THAT THE COLUMN TESTS CANNOT REACH:
 *
 *   · the ladder's ORDER, through deals built to sit on each rung
 *   · the section split, including that Mutual Release beats Closed
 *   · that an agent-scoped caller does NOT get the brokerage-wide cached answer
 *   · that a row with `calc_at` NULL sends the whole report the long way and still answers correctly
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

const admin: AuthUserRecord = { id: 1, name: 'Pay Admin', role: 'admin', user_permissions: [], user_modules: [] } as unknown as AuthUserRecord;

const presented = (r: { rows: Record<string, unknown>[]; totals: unknown; total_count: number; page: number; last_page: number; sections?: unknown }) => ({
  rows: r.rows, totals: r.totals, total_count: r.total_count, page: r.page, last_page: r.last_page, sections: r.sections,
});

const serviceFor = (tx: PrismaService) =>
  new ReportsService(new ReportDataService(tx, new CommissionService(new PersonResolver(tx))), tx);

const cacheFor = (tx: PrismaService) => new PaymentCacheService(tx, new CommissionService(new PersonResolver(tx)));

/**
 * Run through the ORIGINAL enrichment path.
 *
 * The fast path is entered only for this report type, so there is no registry entry to remove — the
 * switch is the method itself. Replacing it for the duration turns it off while leaving everything
 * else about the run identical.
 */
async function slowly(svc: ReportsService, query: Record<string, unknown>) {
  const any = svc as unknown as { runFastPayments: unknown };
  const saved = any.runFastPayments;
  any.runFastPayments = async () => null;
  try {
    return await (svc.run('transaction-payment-status', admin, query as never) as Promise<never>);
  } finally {
    any.runFastPayments = saved;
  }
}

const payment = (status: string, amount: number) =>
  ({ paid_type: 'TDB-EFT', paid_status: status, amount: String(amount), paid_date: '2026-03-01' });

/**
 * Deals sitting on every rung of the ladder and in every section.
 *
 * Named for the rung each is meant to land on, so a failure says which branch moved rather than
 * only that a count changed.
 */
async function fixture(tx: PrismaService) {
  const now = new Date();
  const stamp = Date.now();

  const mk = async (opts: {
    label: string;
    members: { name: string; split: number }[];
    admin?: unknown;
    tracker?: unknown;
    statuses?: string[];
    price?: number;
    commPct?: number | null;
  }) => {
    const t = await tx.transactions.create({
      data: {
        trade_no: `PAYROW-${stamp}-${String(++seq).padStart(3, '0')}`,
        type: 'Residential Buying',
        agent: opts.members[0]?.name ?? 'Nobody',
        property: opts.label,
        price: opts.price ?? 900_000,
        comm_type: '%', comm_value: 5, comm_pct: opts.commPct === undefined ? 2.5 : opts.commPct,
        comm_status: 'Pending',
        admin_activities: JSON.stringify(opts.admin ?? {}),
        activity_tracker: JSON.stringify(opts.tracker ?? {}),
        adjustments: '{}',
        closing_date: new Date(`2026-0${(seq % 8) + 1}-15T00:00:00.000Z`),
        created_at: now, updated_at: now,
      },
    });
    let p = 0;
    for (const m of opts.members) {
      await tx.team_members.create({
        data: {
          transaction_id: t.id, name: m.name, split: m.split, agent_pct: 90, brok_pct: 10,
          is_primary: p === 0, access: 'docs', scope: 'Entire', position: p++, created_at: now, updated_at: now,
        },
      });
    }
    for (const s of opts.statuses ?? []) {
      await tx.transaction_statuses.create({ data: { transaction_id: t.id, status: s, created_at: now, updated_at: now } });
    }
    return t.id;
  };

  const A = [{ name: 'Pay Agent A', split: 100 }];
  const AB = [{ name: 'Pay Agent A', split: 50 }, { name: 'Pay Agent B', split: 50 }];

  // rung 1 — a recorded Yes beats everything, including having no payment rows at all
  await mk({ label: 'faq-yes', members: A, tracker: { agent_commission_paid_status: 'Yes' }, statuses: ['Closed'] });
  // rung 2 — a recorded N/A, both spellings
  await mk({ label: 'faq-na', members: A, tracker: { agent_commission_paid_status: 'N/A' }, statuses: ['Closed'] });
  await mk({ label: 'faq-notapplicable', members: A, tracker: { agent_commission_paid_status: 'Not Applicable' } });
  // rung 3 — zero commission
  await mk({ label: 'zero-comm', members: A, price: 0, commPct: 0, statuses: ['Closed'] });
  // rung 4 — every named agent has a Paid row
  await mk({ label: 'all-paid', members: AB, statuses: ['Closed'], admin: { agents: {
    'Pay Agent A': { payments: [payment('Paid', 1000)] },
    'Pay Agent B': { payments: [payment('Paid', 2000)] },
  } } });
  // rung 5 — some but not all
  await mk({ label: 'partial', members: AB, statuses: ['Closed'], admin: { agents: {
    'Pay Agent A': { payments: [payment('Paid', 1000)] },
    'Pay Agent B': { payments: [payment('Pending', 2000)] },
  } } });
  // rung 6 — closed, nothing paid
  await mk({ label: 'pending', members: A, statuses: ['Closed'] });
  // rung 7 — not closed, nothing paid
  await mk({ label: 'upcoming', members: A, statuses: ['Secured Firm'] });
  // sections — mutual release beats closed, and beats a Paid status
  await mk({ label: 'mutual', members: A, statuses: ['Closed', 'Mutual Release'], admin: { agents: {
    'Pay Agent A': { payments: [payment('Paid', 5000)] },
  } } });
  // a deal with no statuses at all
  await mk({ label: 'no-status', members: A });
}

/** Cache every fixture deal, which is what the write path would have done. */
async function warmCache(tx: PrismaService) {
  const ids = (await tx.transactions.findMany({ where: { trade_no: { startsWith: 'PAYROW-' } }, select: { id: true } })).map((r) => r.id);
  await cacheFor(tx).recompute(ids);
  return ids;
}

describe('the payment-status fast path returns exactly what the enrichment path returns', () => {
  jest.setTimeout(180_000);

  it('the whole report, unfiltered', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      await warmCache(tx);
      const svc = serviceFor(tx);
      const q = { filters: {}, page: 1, per_page: 500 };
      const fast = await svc.run('transaction-payment-status', admin, q as never);
      expect(presented(fast)).toEqual(presented(await slowly(svc, q)));
      expect(fast.total_count).toBeGreaterThan(5);
    });
  });

  it('every rung of the ladder lands on the same status both ways', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      await warmCache(tx);
      const svc = serviceFor(tx);
      const q = { filters: {}, page: 1, per_page: 500 };
      const fast = await svc.run('transaction-payment-status', admin, q as never);
      const slow = await slowly(svc, q);

      const byLabel = (r: { rows: Record<string, unknown>[] }) => new Map(
        r.rows.filter((x) => String(x.trade_no ?? '').startsWith('PAYROW-'))
          .map((x) => [String(x.property), String(x.payment_status)]),
      );
      const f = byLabel(fast);
      const s = byLabel(slow);
      expect([...f.entries()].sort()).toEqual([...s.entries()].sort());

      // And the ladder really did put them where it should — named, so a move says which rung.
      expect(f.get('faq-yes')).toBe('Paid');
      expect(f.get('faq-na')).toBe('Not Applicable');
      expect(f.get('faq-notapplicable')).toBe('Not Applicable');
      expect(f.get('zero-comm')).toBe('Not Applicable');
      expect(f.get('all-paid')).toBe('Paid');
      expect(f.get('partial')).toBe('Partially Paid');
      expect(f.get('pending')).toBe('Pending');
      expect(f.get('upcoming')).toBe('Upcoming');
    });
  });

  it('every section, one at a time, and Mutual Release beats Closed', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      await warmCache(tx);
      const svc = serviceFor(tx);

      for (const sections of [['closed_paid'], ['closed_pending'], ['yet_to_close'], ['mutual_release']]) {
        const q = { filters: { sections }, page: 1, per_page: 500 };
        expect(presented(await svc.run('transaction-payment-status', admin, q as never)))
          .toEqual(presented(await slowly(svc, q)));
      }

      const mutual = await svc.run('transaction-payment-status', admin, { filters: { sections: ['mutual_release'] }, page: 1, per_page: 500 } as never);
      const labels = mutual.rows.filter((r) => String(r.trade_no ?? '').startsWith('PAYROW-')).map((r) => String(r.property));
      expect(labels).toContain('mutual');
    });
  });

  it('every status filter', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      await warmCache(tx);
      const svc = serviceFor(tx);
      for (const status of PAYMENT_STATUSES) {
        const q = { filters: { status }, page: 1, per_page: 500 };
        expect(presented(await svc.run('transaction-payment-status', admin, q as never)))
          .toEqual(presented(await slowly(svc, q)));
      }
    });
  });

  it('every page, so the section boundary and the ordering have to agree', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      await warmCache(tx);
      const svc = serviceFor(tx);
      const first = await svc.run('transaction-payment-status', admin, { filters: {}, page: 1, per_page: 3 } as never);
      for (let page = 1; page <= first.last_page; page++) {
        const q = { filters: {}, page, per_page: 3 };
        expect(presented(await svc.run('transaction-payment-status', admin, q as never)))
          .toEqual(presented(await slowly(svc, q)));
      }
    });
  });

  /**
   * ONE UNCOMPUTED ROW SENDS THE WHOLE REPORT THE LONG WAY.
   *
   * The cached columns are cleared on one fixture deal, which is what a row the backfill has not
   * reached looks like. The report must still be right — that is what this asserts — and it must be
   * right because it took the enrichment path, not because a CASE over NULLs happened to agree.
   */
  it('falls back entirely when any candidate row is uncomputed, and is still correct', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const ids = await warmCache(tx);
      const svc = serviceFor(tx);
      const q = { filters: {}, page: 1, per_page: 500 };
      const cached = await svc.run('transaction-payment-status', admin, q as never);

      await tx.transactions.update({
        where: { id: ids[0] },
        data: { calc_at: null, calc_agent_comm_total: null, calc_paid_total: null, calc_paid_name_count: null, calc_agent_name_count: null, calc_faq_paid_status: null },
      });

      const afterClear = await svc.run('transaction-payment-status', admin, q as never);
      expect(presented(afterClear)).toEqual(presented(await slowly(svc, q)));
      // The same answer as when every row was cached: the fallback changes the route, not the result.
      expect(presented(afterClear)).toEqual(presented(cached));
    });
  });

  /**
   * AN AGENT MUST NOT RECEIVE THE BROKERAGE-WIDE CACHED ANSWER.
   *
   * `enrich()` narrows the agent lines to the signed-in agent, so their commission total and their
   * paid figure are genuinely different numbers from the cached ones. The fast path refuses them for
   * that reason; this asserts the refusal by requiring an agent's report to equal the enrichment
   * path's, which is the only definition of "correct" for them.
   */
  it('an agent-scoped caller gets their own figures, not the cached brokerage ones', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      await warmCache(tx);
      const svc = serviceFor(tx);
      const agentUser = { id: 42, name: 'Pay Agent A', role: 'agent', user_permissions: [], user_modules: [] } as unknown as AuthUserRecord;
      const q = { filters: {}, page: 1, per_page: 500 };

      const asAgent = await svc.run('transaction-payment-status', agentUser, q as never);
      const any = svc as unknown as { runFastPayments: unknown };
      const saved = any.runFastPayments;
      any.runFastPayments = async () => null;
      let slowAgent;
      try {
        slowAgent = await svc.run('transaction-payment-status', agentUser, q as never);
      } finally {
        any.runFastPayments = saved;
      }
      expect(presented(asAgent)).toEqual(presented(slowAgent));
    });
  });
});

afterAll(async () => { await prisma.$disconnect(); });
