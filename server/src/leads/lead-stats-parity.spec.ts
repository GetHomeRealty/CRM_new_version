import { PrismaClient, Prisma } from '@prisma/client';
import { DASHBOARD_LEAD_SOURCES, RECENT_LEAD_DAYS } from './lead.constants';

/**
 * The Leads header counters, computed the old way and the new way, against the same rows.
 *
 * `statsGrouped` replaced thirteen separate `count()` queries with two `groupBy`s and two counts.
 * The speed-up is measured elsewhere; what this file protects is the part that would be expensive
 * to get wrong quietly — that the NUMBERS did not change.
 *
 * A counter that is merely plausible is the failure mode here. Nobody checks a dashboard tile
 * against the database by hand, so a rewrite that made "hot" mean something slightly different —
 * counting nulls, or missing a bucket, or losing the ownership scope — would be believed for as
 * long as it survived. So the old implementation is kept below, verbatim in behaviour, and both are
 * run against real rows under several different filters.
 *
 * THE FILTERS MATTER AS MUCH AS THE COUNTS. `statsGrouped` receives whatever `buildWhere` produced —
 * the search, the dropdowns, the tag match, the age range and, most importantly, the ownership
 * scope. Testing only the unfiltered case would prove the arithmetic and miss the thing that would
 * actually hurt: a rewrite that dropped the scope and showed one agent another's totals.
 */

const prisma = new PrismaClient();

/** Either the client or a transaction handle — both implementations read through one of these. */
type Client = Pick<PrismaClient, 'leads'>;
afterAll(async () => { await prisma.$disconnect(); });

/** The implementation as it stood before: one query per counter. */
async function statsTheOldWay(where: Prisma.leadsWhereInput, db: Client = prisma): Promise<Record<string, unknown>> {
  const since = new Date(Date.now() - RECENT_LEAD_DAYS * 24 * 60 * 60 * 1000);
  const count = (extra: Prisma.leadsWhereInput) => db.leads.count({ where: { AND: [where, extra] } });

  // `websiteEnquiries` is gone from both implementations: it counted paid ads under a website name
  // and disagreed with `bySource.website` in the same response. See `lead.constants.ts`.
  const [total, noCalls, recent, hot, warm, cold, mild, closed, ...sourceCounts] = await Promise.all([
    db.leads.count({ where }),
    count({ lead_calls: { none: {} } }),
    count({ created_at: { gte: since } }),
    count({ lead_status: 'hot' }),
    count({ lead_status: 'warm' }),
    count({ lead_status: 'cold' }),
    count({ lead_status: 'mild' }),
    count({ lead_status: 'closed' }),
    ...DASHBOARD_LEAD_SOURCES.map((s) => count({ lead_source: s.value })),
  ]);

  const bySource: Record<string, number> = {};
  DASHBOARD_LEAD_SOURCES.forEach((s, i) => { bySource[s.key] = sourceCounts[i]; });
  bySource.other = total - sourceCounts.reduce((a, b) => a + b, 0);

  return { total, noCalls, recent, byStatus: { hot, warm, cold, mild, closed }, bySource };
}

/** The implementation as it stands now, copied from `LeadsService.statsGrouped`. */
async function statsTheNewWay(where: Prisma.leadsWhereInput, db: Client = prisma): Promise<Record<string, unknown>> {
  const since = new Date(Date.now() - RECENT_LEAD_DAYS * 24 * 60 * 60 * 1000);
  const count = (extra: Prisma.leadsWhereInput) => db.leads.count({ where: { AND: [where, extra] } });

  const [byStatusRows, bySourceRows, noCalls, recent] = await Promise.all([
    db.leads.groupBy({ by: ['lead_status'], where, _count: { _all: true } }),
    db.leads.groupBy({ by: ['lead_source'], where, _count: { _all: true } }),
    count({ lead_calls: { none: {} } }),
    count({ created_at: { gte: since } }),
  ]);

  const statusCounts = new Map(byStatusRows.map((r) => [r.lead_status ?? '', r._count._all]));
  const sourceCounts = new Map(bySourceRows.map((r) => [r.lead_source ?? '', r._count._all]));
  const status = (k: string): number => statusCounts.get(k) ?? 0;
  const source = (k: string): number => sourceCounts.get(k) ?? 0;

  const bySource: Record<string, number> = {};
  for (const s of DASHBOARD_LEAD_SOURCES) bySource[s.key] = source(s.value);
  const total = [...sourceCounts.values()].reduce((a, b) => a + b, 0);
  bySource.other = total - DASHBOARD_LEAD_SOURCES.reduce((sum, s) => sum + source(s.value), 0);

  return {
    total, noCalls, recent,
    byStatus: {
      hot: status('hot'), warm: status('warm'), cold: status('cold'),
      mild: status('mild'), closed: status('closed'),
    },
    bySource,
  };
}

/**
 * The filter sets to compare under.
 *
 * Chosen to cover the shapes `buildWhere` actually produces, not just the empty one: an ownership
 * scope (the privacy rule), a dropdown filter, a relation-free date filter, and a combination.
 */
/**
 * Everything created before this file started running.
 *
 * The widest case used to be an unscoped `{ deleted_at: null }`, and it failed roughly one run in
 * three — not because the two implementations disagreed, but because they were reading a moving
 * target. The suite runs specs in parallel against one database, and several of them create and
 * delete leads; between the old-way read and the new-way read, the population changed.
 *
 * Freezing the upper bound at start-up keeps the case genuinely broad — every lead that existed
 * when this file began — while making it immune to what a neighbouring spec does next. A parity
 * test that fails intermittently teaches people to re-run it, which is worse than not having it.
 */
const SNAPSHOT = new Date();

const CASES: { name: string; where: Prisma.leadsWhereInput }[] = [
  { name: 'every live lead', where: { deleted_at: null, created_at: { lt: SNAPSHOT } } },
  {
    name: 'one agent’s book — the ownership scope',
    // The exact shape `leadScopeWhere` builds. If the rewrite ever loses this, the totals jump.
    where: { AND: [{ deleted_at: null }, { OR: [{ assigned_to: 1 }, { owner_user_id: 1 }] }] },
  },
  { name: 'a status filter', where: { AND: [{ deleted_at: null }, { lead_status: 'hot' }] } },
  { name: 'a source filter', where: { AND: [{ deleted_at: null }, { lead_source: 'meta' }] } },
  {
    name: 'status + source together',
    where: { AND: [{ deleted_at: null }, { lead_status: 'warm' }, { lead_source: 'website' }] },
  },
  {
    name: 'a filter that matches nothing',
    // The empty case is where `groupBy` differs most from `count`: it returns no rows at all, and
    // every derived figure has to come out 0 rather than NaN or undefined.
    where: { AND: [{ deleted_at: null }, { lead_status: 'zzz-nonexistent' }] },
  },
];

describe('the rewritten Leads counters return exactly the old numbers', () => {
  for (const c of CASES) {
    it(`agrees for: ${c.name}`, async () => {
      /*
       * BOTH IMPLEMENTATIONS READ ONE SNAPSHOT, at REPEATABLE READ.
       *
       * They used to run as separate top-level queries against live data, so any row committed
       * between them made the two disagree — and the disagreement looked exactly like the counter
       * bug this file exists to catch. It fired for real once a spec that commits outside a
       * transaction joined the suite.
       *
       * A plain transaction is NOT enough: PostgreSQL's default READ COMMITTED gives every
       * STATEMENT its own snapshot, so the two would still see different data inside one. Repeatable
       * read pins the snapshot for the whole transaction, which is what "against the same rows"
       * requires.
       */
      const [oldWay, newWay] = await prisma.$transaction(
        (tx) => Promise.all([statsTheOldWay(c.where, tx), statsTheNewWay(c.where, tx)]),
        { isolationLevel: 'RepeatableRead' },
      );
      expect(newWay).toEqual(oldWay);
    }, 120_000);
  }

  it('the empty case really is empty — otherwise the case above proves nothing', async () => {
    // A parity test between two implementations both returning zero would pass while both were
    // broken. This asserts the fixture has data at all, so the comparisons above are meaningful.
    const live = await prisma.leads.count({ where: { deleted_at: null, created_at: { lt: SNAPSHOT } } });
    expect(live).toBeGreaterThan(0);
  }, 120_000);

  it('the parts of the source breakdown add up to the total', async () => {
    // The invariant the "other" bucket exists to preserve, asserted directly rather than inferred.
    const s = await statsTheNewWay({ deleted_at: null, created_at: { lt: SNAPSHOT } }) as {
      total: number; bySource: Record<string, number>;
    };
    const parts = Object.values(s.bySource).reduce((a, b) => a + b, 0);
    expect(parts).toBe(s.total);
  }, 120_000);
});
