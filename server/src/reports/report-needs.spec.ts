import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CommissionService } from '../transactions/commission.service';
import { PersonResolver } from '../core/person-resolver.service';
import { ReportDataService, type DataScope, type LoadOptions, type ReportNeeds } from './report-data.service';
import { ReportsService } from './reports.service';
import { REPORTS } from './report-registry';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * THE GATE ON THE TWO OPTIMISATIONS IN THE REPORTS DATA PATH.
 *
 * Both are invisible when they go wrong, which is why they need a test rather than a review:
 *
 *   `needs` — which documentation relations a report loads. A report that reads `docs` without
 *   declaring them does not fail; it sees an empty list and reports zero pending documents. That
 *   reads as good news on a compliance report, which is about the worst way for a bug to present.
 *
 *   `sqlWhere` — the database predicate applied before enrichment. It is required to be a SUPERSET
 *   of the report's JavaScript predicate. If it is too strict, rows vanish from somebody's report
 *   with no error anywhere: the totals are simply lower than they should be.
 *
 * The test for both is the same shape and is the only one that would actually catch them: run every
 * report the fast way, run it again with the optimisations disabled, and require the two results to
 * be IDENTICAL — rows, order, totals, sections, counts.
 *
 * The fixture is built so that each report has something to find and something to exclude, because
 * two empty results also compare equal.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

/**
 * REPEATABLE READ, not the default — and the reason is specific to what these tests do.
 *
 * Every test here runs the same report TWICE and requires the two results to be identical: once the
 * fast way and once the slow way, or once with a relation and once without. Under PostgreSQL's
 * default READ COMMITTED each statement takes a FRESH snapshot, so a row another Jest worker commits
 * between the two runs is visible to the second and not the first — and the comparison fails on data
 * that has nothing to do with the code under test. Alone the file passed; in the parallel suite it
 * did not, which is exactly the shape of that bug.
 *
 * One snapshot for the whole transaction removes the difference without weakening anything: the
 * fixture is still built and rolled back, and both runs still see it.
 */
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

/**
 * A loader with a FIXED set of relations and no SQL narrowing — the reference to compare against.
 *
 * `only` is what the optimised path is measured against: pass all three and you get what the module
 * did before this change; drop one and you get "what would this report look like if that relation
 * were missing", which is how the test DISCOVERS what each report needs instead of trusting a list.
 */
class FixedData extends ReportDataService {
  constructor(tx: PrismaService, engine: CommissionService, private readonly only: ReportNeeds) {
    super(tx, engine);
  }
  override load(scope: DataScope, _opts: LoadOptions = {}): ReturnType<ReportDataService['load']> {
    return super.load(scope, { needs: this.only });
  }
}

const ALL: ReportNeeds = { documents: true, conditions: true, clients: true };
const RELATIONS: (keyof ReportNeeds)[] = ['documents', 'conditions', 'clients'];

/**
 * A report result reduced to WHAT THE REPORT ACTUALLY PRESENTS.
 *
 * `baseRow` puts every documentation field on every row — `client_names`, `pending_docs`,
 * `documentation_status` and the rest — whether or not the report has a column for them. So a
 * commission report that skips the documents relation emits `pending_docs: 0` where it used to emit
 * `pending_docs: 3`, on a key nothing renders, nothing exports and nothing reads.
 *
 * Comparing raw rows would therefore fail on differences that cannot reach a user, and — worse —
 * would push towards declaring every relation on every report, which is the thing being fixed. So
 * the comparison is over the report's own columns plus the three structural keys the client uses to
 * expand a row, and the test below separately proves that a column NEVER depends on a relation the
 * report did not ask for. That second property is the one that matters, and it is discovered rather
 * than declared.
 */
function presented(r: { columns: { key: string }[]; rows: Record<string, unknown>[]; totals: unknown; sections?: unknown; total_count: number }) {
  const keys = [...r.columns.map((c) => c.key), 'txn_id', 'doc_id', 'section'];
  return {
    rows: r.rows.map((row) => Object.fromEntries(keys.filter((k) => k in row).map((k) => [k, row[k]]))),
    totals: r.totals,
    sections: r.sections,
    total_count: r.total_count,
  };
}

const admin = { id: 1, name: 'Report Boss', role: 'admin' } as unknown as AuthUserRecord;

async function fixture(tx: PrismaService): Promise<void> {
  const now = new Date();
  const stamp = Date.now();

  const mk = async (o: {
    type?: string; agent?: string; price?: number; closed?: boolean;
    docs?: { title: string; validation: string; mandatory?: boolean }[];
    conditions?: { type: string; status: string }[];
    clients?: string[];
    members?: { name: string; split: number; agent_pct: number; brok_pct: number }[];
    adjustments?: Record<string, unknown>;
    admin_activities?: Record<string, unknown>;
    lead_source?: string | null;
    review?: boolean;
    conditional?: boolean;
    reco?: string | null;
  }) => {
    const t = await tx.transactions.create({
      data: {
        trade_no: `NEEDS-${stamp}-${++seq}`,
        type: o.type ?? 'Residential Buying',
        agent: o.agent ?? 'Report Agent',
        price: o.price ?? 750_000, deposit: 25_000,
        comm_type: '%', comm_value: 0, comm_pct: 2.5,
        listing_comm_pct: o.type?.includes('Listing') ? 2.5 : null,
        coop_comm_pct: o.type?.includes('Listing') ? 2.5 : null,
        comm_status: 'Pending', comm_paid_status: 'No',
        conditional_offer: o.conditional ?? false,
        reco_audit_ready: o.reco ?? 'No',
        lead_source: o.lead_source ?? null,
        lead_converted_date: o.lead_source ? new Date('2025-02-01T00:00:00.000Z') : null,
        review_email_sent_at: o.review ? new Date('2025-01-10T00:00:00.000Z') : null,
        closing_date: new Date('2025-06-15T00:00:00.000Z'),
        offer_date: new Date('2025-03-01T00:00:00.000Z'),
        adjustments: JSON.stringify(o.adjustments ?? {}),
        admin_activities: JSON.stringify(o.admin_activities ?? {}),
        activity_tracker: '{}', created_at: now, updated_at: now,
      },
    });
    if (o.closed) await tx.transaction_statuses.create({ data: { transaction_id: t.id, status: 'Closed', created_at: now, updated_at: now } });
    let p = 0;
    for (const d of o.docs ?? []) {
      await tx.documents.create({
        data: {
          transaction_id: t.id, title: d.title, validation: d.validation, status: 'Pending',
          mandatory: d.mandatory ?? false, position: p++, file_path: 'x/y.pdf', file_name: 'y.pdf',
          created_at: now, updated_at: now,
        },
      });
    }
    p = 0;
    for (const c of o.conditions ?? []) {
      await tx.conditions.create({ data: { transaction_id: t.id, type: c.type, status: c.status, deadline: new Date('2025-05-01T00:00:00.000Z'), position: p++, created_at: now, updated_at: now } });
    }
    p = 0;
    for (const c of o.clients ?? []) {
      await tx.clients.create({ data: { transaction_id: t.id, name: c, position: p++, created_at: now, updated_at: now } });
    }
    p = 0;
    for (const m of o.members ?? []) {
      await tx.team_members.create({ data: { transaction_id: t.id, name: m.name, split: m.split, agent_pct: m.agent_pct, brok_pct: m.brok_pct, position: p++, created_at: now, updated_at: now } });
    }
    return t.id;
  };

  // Documentation reports: one deal with pending AND invalid documents, one entirely valid (which
  // every documentation predicate must EXCLUDE — that is what proves the SQL filter is not simply
  // letting everything through).
  await mk({
    agent: 'Docs Agent', clients: ['Buyer One', 'Buyer Two'],
    docs: [
      { title: 'Agreement of Purchase and Sale', validation: 'Pending', mandatory: true },
      { title: 'Amendment to Agreement', validation: 'Invalid' },
      { title: 'Waiver of Conditions', validation: 'Valid' },
    ],
    conditions: [{ type: 'Financing', status: 'Pending' }],
    conditional: true,
  });
  await mk({
    agent: 'Clean Agent', clients: ['Seller One'],
    docs: [{ title: 'Agreement of Purchase and Sale', validation: 'Valid', mandatory: true }],
    reco: 'Yes',
  });
  // A deal with NO documents at all — the "total === 0" branch.
  await mk({ agent: 'Bare Agent' });

  // Team split, for the team-split report's `is_team` predicate — plus a single-agent deal, which
  // it must exclude.
  await mk({ agent: 'Team Lead', closed: true, members: [
    { name: 'Team Lead', split: 60, agent_pct: 90, brok_pct: 10 },
    { name: 'Team Second', split: 40, agent_pct: 85, brok_pct: 15 },
  ] });
  await mk({ agent: 'Solo', closed: true });

  // Brokerage lead conversion, and a non-brokerage lead it must exclude.
  //
  // SIX of them, not one, so the paging assertions have a second page to be wrong about — a fast
  // path compared only against a single-page result would pass without ever paging.
  for (let i = 0; i < 6; i++) await mk({ agent: `Lead Agent ${i}`, price: 600_000 + i * 25_000, lead_source: 'Brokerage Lead' });
  await mk({ agent: 'Lead Agent', lead_source: 'Personal Referral' });

  // Review / coupon, advance, cashback and referral — the adjustments-driven reports.
  await mk({ agent: 'Review Agent', review: true });
  await mk({
    agent: 'Money Agent', closed: true,
    adjustments: {
      advance_payment: 'Yes', advance_rows: [{ agent: 'Money Agent', amount: 2_500, paid_date: '2025-04-01' }],
      client_referral: 'Yes', client_rows: [{ client_name: 'Cashback Client', amount: 900, paid_status: 'Paid' }],
      ext_referral: 'Yes', ext: { amount: 1_200, party: 'Other Brokerage', pct: 25 },
    },
    admin_activities: { agents: { 'Money Agent': { payments: [{ paid_status: 'Paid', amount: 5_000, paid_date: '2025-05-01' }], cta: [{ cta: 'No' }] } } },
    members: [{ name: 'Money Agent', split: 100, agent_pct: 90, brok_pct: 10 }],
  });

  // Preconstruction, so the third commission variant is represented.
  const pre = await mk({ type: 'Preconstruction', agent: 'Pre Agent', closed: true });
  await tx.transactions.update({ where: { id: pre }, data: { comm_pct: null, precon_comm_pct: 4, precon_term_count: 2 } });
  await tx.precon_terms.create({ data: { transaction_id: pre, term_no: 1, pct: 2, created_at: now, updated_at: now } });
  await tx.precon_terms.create({ data: { transaction_id: pre, term_no: 2, pct: 2, created_at: now, updated_at: now } });

  // A listing deal.
  await mk({ type: 'Residential Sale Listing', agent: 'Lister', closed: true });
}

/** The transaction-backed reports. The two custom ones read other tables and are covered below. */
const TRANSACTION_REPORTS = REPORTS.filter((r) => !r.custom).map((r) => r.type);

const engineFor = (tx: PrismaService) => new CommissionService(new PersonResolver(tx));
const QUERY = { filters: {}, page: 1, per_page: 200 };
const without = (r: keyof ReportNeeds): ReportNeeds => ({ ...ALL, [r]: false });

describe('what a report presents does not change when it skips the relations it did not declare', () => {
  it.each(TRANSACTION_REPORTS)('%s', async (type) => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const engine = engineFor(tx);
      const declared = new ReportsService(new ReportDataService(tx, engine), tx);
      const everything = new ReportsService(new FixedData(tx, engine, ALL), tx);

      const a = presented(await declared.run(type, admin, QUERY));
      const b = presented(await everything.run(type, admin, QUERY));
      expect(a).toEqual(b);
      // …and the report actually found something, so two empty results cannot pass by accident.
      expect(a.total_count).toBeGreaterThan(0);
    });
  }, 180000);
});

describe('a report declares every relation its own columns depend on', () => {
  /**
   * THIS IS THE PROPERTY THAT MAKES THE OPTIMISATION SAFE, and it is DISCOVERED rather than trusted.
   *
   * For each relation in turn: run the report with that relation removed and everything else
   * present. If anything the report presents changes, the report demonstrably depends on it — so it
   * must have declared it. A hand-written list of "which column needs which relation" would go stale
   * the first time somebody adds a column; this cannot.
   */
  it.each(TRANSACTION_REPORTS)('%s', async (type) => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const engine = engineFor(tx);
      const def = REPORTS.find((r) => r.type === type)!;
      const everything = new ReportsService(new FixedData(tx, engine, ALL), tx);
      const full = presented(await everything.run(type, admin, QUERY));

      for (const rel of RELATIONS) {
        const missing = new ReportsService(new FixedData(tx, engine, without(rel)), tx);
        const changed = JSON.stringify(presented(await missing.run(type, admin, QUERY))) !== JSON.stringify(full);
        if (changed && !def.needs?.[rel]) {
          throw new Error(
            `Report "${type}" changes when \`${rel}\` is not loaded, but does not declare `
            + `needs.${rel}. Add it to the report definition — without it the report will silently `
            + `report empty documentation.`,
          );
        }
      }
    });
  }, 180000);
});

describe('the report filters narrow in the database without changing the answer', () => {
  /**
   * Each case exercises a `sqlWhere` or a pushed-down global filter. A predicate that is too strict
   * shows up here as a smaller `total_count` on the optimised side than on the unoptimised one.
   */
  const cases: [string, string, Record<string, unknown>][] = [
    ['deal type', 'yearly-deal-summary', { deal_type: ['Residential Buying'] }],
    ['closing year', 'yearly-deal-summary', { year: '2025' }],
    ['closing date range', 'yearly-deal-summary', { closing_date_from: '2025-01-01', closing_date_to: '2025-12-31' }],
    ['offer date range', 'yearly-deal-summary', { offer_date_from: '2025-01-01' }],
    ['a named agent', 'yearly-deal-summary', { agent: ['Team Second'] }],
    ['free-text search', 'yearly-deal-summary', { search: 'NEEDS-' }],
    ['the documentation status filter', 'deal-documentation-status', { status: 'Invalid Documentation' }],
    ['RECO readiness = Yes', 'reco-audit-readiness', { reco_ready: 'Yes' }],
    ['RECO readiness = No', 'reco-audit-readiness', { reco_ready: 'No' }],
    ['amendments that are Missing', 'amendment-documentation', { status: 'Missing' }],
    ['amendments that are Invalid', 'amendment-documentation', { status: 'Invalid' }],
    ['team splits', 'team-split-deals', {}],
    ['brokerage leads', 'brokerage-lead-conversion', {}],
    ['reviews and coupons', 'google-review-gift-coupon', {}],
    ['conditional offers', 'conditional-offers', {}],
    ['pending and invalid documents', 'pending-invalid-documents', {}],
    // The four adjustments/admin-activity reports, whose `sqlWhere` narrows by MENTION of a JSON
    // key. Each has a matching deal and several non-matching ones in the fixture, so a clause that
    // is too strict shows up as a missing row here rather than as a quietly smaller report.
    ['advance payments', 'agent-advance-payments', {}],
    ['advance payments, balance pending', 'agent-advance-payments', { status: 'Pending' }],
    ['agent paid but brokerage pending', 'agent-paid-brokerage-pending', {}],
    ['client cashback', 'client-cashback', {}],
    ['client cashback, completed', 'client-cashback', { status: 'Completed' }],
    ['referral payments', 'referral-payment', {}],
    ['referral payments, pending', 'referral-payment', { status: 'Pending' }],
  ];

  it.each(cases)('%s (%s)', async (_label, type, filters) => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const engine = engineFor(tx);
      const declared = new ReportsService(new ReportDataService(tx, engine), tx);
      const everything = new ReportsService(new FixedData(tx, engine, ALL), tx);
      const q = { filters, page: 1, per_page: 200 };
      expect(presented(await declared.run(type, admin, q))).toEqual(presented(await everything.run(type, admin, q)));
    });
  }, 180000);
});

describe('the SQL fast path returns exactly what the enrichment path returns', () => {
  /**
   * `ReportsService.runFast` answers the footer with a database aggregate and enriches only the
   * twenty-five rows on the page. Every figure it produces has a second implementation — the
   * original, which enriches everything and sums it with Decimal — so the test is to run both and
   * demand they agree.
   *
   * The fast path is disabled here by forcing the report onto the original route, which is what
   * `sqlExact` returning false does. Comparing against `presented()` covers the rows the report
   * shows, its totals, its count and its pagination.
   */
  const fastEligible = REPORTS.filter((r) => r.sqlExact).map((r) => r.type);

  const slowly = (svc: ReportsService, type: string, query: Record<string, unknown>) => {
    const def = REPORTS.find((r) => r.type === type)!;
    const exact = def.sqlExact;
    def.sqlExact = undefined;
    return (svc.run(type, admin, query as never) as Promise<never>).finally(() => { def.sqlExact = exact; });
  };

  it.each(fastEligible)('%s', async (type) => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const svc = new ReportsService(new ReportDataService(tx, engineFor(tx)), tx);
      const q = { filters: {}, page: 1, per_page: 5 };

      const fast = await svc.run(type, admin, q as never);
      const slow = await slowly(svc, type, q);

      expect(presented(fast)).toEqual(presented(slow));
      expect(fast.total_count).toBeGreaterThan(0);
      // …and the page really is a page, so the comparison is not of two complete result sets.
      expect(fast.last_page).toBeGreaterThan(1);
    });
  }, 180000);

  it('agrees on page two, where an off-by-one in the ordering would show', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const svc = new ReportsService(new ReportDataService(tx, engineFor(tx)), tx);
      const q = { filters: {}, page: 2, per_page: 3 };
      expect(presented(await svc.run('yearly-deal-summary', admin, q as never)))
        .toEqual(presented(await slowly(svc, 'yearly-deal-summary', q)));
    });
  }, 180000);

  it('agrees when a filter narrows the set', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const svc = new ReportsService(new ReportDataService(tx, engineFor(tx)), tx);
      for (const filters of [
        { deal_type: ['Residential Buying'] },
        { year: '2025' },
        { closing_date_from: '2025-01-01', closing_date_to: '2025-12-31' },
      ]) {
        const q = { filters, page: 1, per_page: 200 };
        expect(presented(await svc.run('yearly-deal-summary', admin, q as never)))
          .toEqual(presented(await slowly(svc, 'yearly-deal-summary', q)));
      }
    });
  }, 180000);

  it('agrees on an explicit sort, ascending and descending', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const svc = new ReportsService(new ReportDataService(tx, engineFor(tx)), tx);
      for (const dir of ['asc', 'desc'] as const) {
        for (const sort of ['price', 'trade_no', 'closing_date']) {
          const q = { filters: {}, page: 1, per_page: 200, sort, dir };
          expect(presented(await svc.run('yearly-deal-summary', admin, q as never)))
            .toEqual(presented(await slowly(svc, 'yearly-deal-summary', q)));
        }
      }
    });
  }, 180000);

  it('DECLINES the fast path where the predicate is not exact, rather than guessing', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const svc = new ReportsService(new ReportDataService(tx, engineFor(tx)), tx);
      // A payout-status filter is derived from admin_activities: no SQL predicate counts it, so the
      // report must fall back and still be right.
      const q = { filters: { payout_status: 'Pending' }, page: 1, per_page: 200 };
      expect(presented(await svc.run('yearly-deal-summary', admin, q as never)))
        .toEqual(presented(await slowly(svc, 'yearly-deal-summary', q)));
      // …and a sort by a DERIVED column, which the database cannot order by.
      const q2 = { filters: {}, page: 1, per_page: 200, sort: 'agent_payment_status', dir: 'asc' };
      expect(presented(await svc.run('yearly-deal-summary', admin, q2 as never)))
        .toEqual(presented(await slowly(svc, 'yearly-deal-summary', q2)));
    });
  }, 180000);
});

describe('the two loads that no longer read the whole brokerage', () => {
  it('the split-ratio dropdown lists the same ratios the enriched rows carry', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const data = new ReportDataService(tx, engineFor(tx));
      const fromSplits = new Set(await data.splitRatioOptions({}));
      const fromRows = new Set((await data.load({})).flatMap((t) => t.split_ratios));
      // The dropdown must offer every ratio a row can display, and nothing it cannot.
      expect([...fromSplits].sort()).toEqual([...fromRows].sort());
    });
  }, 180000);

  it('the per-deal document expansion still refuses a deal outside the caller’s scope', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const svc = new ReportsService(new ReportDataService(tx, engineFor(tx)), tx);
      const mine = await tx.transactions.findFirstOrThrow({ where: { agent: 'Docs Agent' }, select: { id: true } });

      // The office may expand it…
      await expect(svc.documentsFor(mine.id, admin)).resolves.toMatchObject({ transaction: { id: mine.id } });
      // …an agent who is not on it may not, and gets the same 404 as a missing deal.
      const stranger = { id: 424_242, name: 'Not On This Deal', role: 'agent' } as unknown as AuthUserRecord;
      await expect(svc.documentsFor(mine.id, stranger)).rejects.toThrow(/not found/i);
    });
  }, 180000);
});

afterAll(async () => {
  await prisma.$disconnect();
});
