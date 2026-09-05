import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CommissionService } from '../transactions/commission.service';
import type { CommissionTxn } from '../transactions/commission.types';
import { round2 } from '../common/serialize';
import { isAgent } from '../core/authz';
import { transactionScopeWhere, type ScopedUser } from '../common/transaction-scope';
import { ANALYTICS_DATE_SQL, type AnalyticsFilters } from './desk-analytics.filters';

/**
 * The Transaction Desk Analytics screen, computed where the data is.
 *
 * WHAT THIS REPLACES, IN TWO STEPS. Originally `AnalyticsPage` called `GET /api/transactions` with
 * no page — the endpoint's "no query means the entire list" mode — and summed the result in the
 * browser, so opening Analytics downloaded every transaction the caller could see, fully serialised.
 * That moved here, which fixed the wire but not the shape: the server then read every row in pages
 * and did the same arithmetic one deal at a time in Node.
 *
 * MEASURED at 80,000 deals: 3,142 ms for an office user single-handed, and a 33,225 ms p95 with a
 * hundred people on the system. Fourteen numbers and three small tables, for three seconds of
 * fetching and looping. The cost was never the query.
 *
 * IT IS NOW FOUR AGGREGATES. The commission formula lives in SQL as `desk_gross_commission` and the
 * rounding as `php_round2` (migration 20260815090000_desk_commission_sql), both transliterated from
 * `CommissionService` operation for operation in `double precision` — the same IEEE-754 binary64
 * JavaScript uses. The database groups and sums; the response is the chart, and nothing else
 * crosses the wire or the process boundary.
 *
 * THE NUMBERS DO NOT MOVE, and that is enforced rather than asserted: `desk-sql-parity.spec.ts`
 * runs the SQL implementation and the TypeScript one over every transaction in the database and
 * requires exact equality, per row and per total.
 *
 * WHY THE SUMS ARE `numeric` AND NOT `double precision`. `php_round2` returns an exact two-decimal
 * value, so `SUM()` over it is exact and — the part that matters — independent of the order rows
 * arrive in. Summing doubles is neither: floating-point addition is not associative, so a parallel
 * or hash aggregate could hand back a different last cent between two runs of the same query. An
 * aggregate that is allowed to disagree with itself is worse than a slow one.
 *
 * EVERY FIGURE HERE IS BEFORE HST, and that is a decision rather than an accident.
 *
 * HST is not brokerage revenue. It is tax collected on the brokerage's behalf and remitted, so
 * including it in a commission-performance figure overstates what the brokerage earned by 13%.
 * The screen used to mix the two bases in one panel: `paid` and `pending` summed the commission
 * before HST while the by-month, by-agent and by-type totals summed it after, and the tile over the
 * first pair was labelled "incl. HST". Three numbers on one screen, two bases, and a label that
 * matched neither.
 *
 * Invoice figures are the deliberate exception and are NOT computed here: an invoice total is what
 * was actually billed, and HST belongs in it.
 */

export interface DeskAnalytics {
  /** Money before HST, and the number of deals behind each figure. */
  totals: { total: number; paid: number; pending: number; paid_count: number; pending_count: number };
  /** Ascending by month (`YYYY-MM`). Deals with neither date are omitted, as on the screen. */
  by_month: { month: string; total: number }[];
  /** Descending by commission. `Unassigned` covers deals with no agent, as on the screen. */
  by_agent: { agent: string; count: number; total: number | null }[];
  by_type: { type: string; count: number; total: number }[];
}

/**
 * The gross commission for one row, as a SQL expression over the alias `t`.
 *
 * Written once and shared by all four aggregates so they cannot drift from each other, and so the
 * only place the column list appears is here.
 */
const GROSS = `desk_gross_commission(
  t.type, t.price::float8, t.comm_type, t.comm_value::float8,
  t.comm_pct::float8, t.comm_amt::float8,
  t.listing_comm_pct::float8, t.coop_comm_pct::float8,
  t.listing_comm_flat::float8, t.coop_comm_flat::float8,
  t.precon_comm_pct::float8, t.precon_comm_amt_manual::float8
)`;

/** `summarize().amount` — the gross, rounded the way the application rounds. */
const AMOUNT = `php_round2(${GROSS})`;

/**
 * `summarize().paid` — and the `COALESCE` is the whole reason this has a comment.
 *
 * The TypeScript is `comm_paid_status === 'Yes' || comm_status === 'Received'`, where a NULL
 * `comm_paid_status` simply fails the first test and the deal is pending.
 *
 * SQL DOES NOT AGREE. `comm_paid_status` is nullable, so `NULL = 'Yes'` is UNKNOWN, and
 * `UNKNOWN OR FALSE` is UNKNOWN — not FALSE. Written the obvious way, every deal with no payment
 * status set satisfied neither `WHERE paid` nor `WHERE NOT paid` and vanished from BOTH totals and
 * BOTH counts. It is exactly the kind of difference that looks like nothing on a corpus where the
 * column is always filled in, which is why `core/desk-sql-parity.spec.ts` builds a deal with it
 * null: that test is what found this.
 */
const PAID = `(COALESCE(t.comm_paid_status = 'Yes', false) OR t.comm_status = 'Received')`;

/**
 * TD-092 — the month key for a deal that has no closing date.
 *
 * A sentinel rather than an empty string or a null, so it survives a JSON round trip, sorts
 * predictably and cannot be mistaken for a month: every other key is exactly `YYYY-MM`. The
 * screen and the export both translate it into words; nothing renders the sentinel itself.
 */
export const NO_CLOSING_DATE = 'none';

/**
 * The screen's filters, as extra SQL predicates.
 *
 * EVERY ONE IS APPLIED IN THE DATABASE. Filtering the response in the browser would mean shipping
 * the unfiltered aggregate to do it, and the whole point of this service is that the aggregate never
 * leaves the database — a client-side filter would also make the totals disagree with the rows they
 * are totals of.
 *
 * Values reach here already validated by `parseAnalyticsFilters`, which refuses anything outside the
 * application's own vocabularies. Dates and the agent id are still bound as parameters rather than
 * interpolated: validation is not the same as trust, and a bound parameter cannot be a SQL fragment
 * however the validator changes later.
 *
 * The status test is `EXISTS`, not a join, because a deal holds a SET of statuses — a join would
 * count a deal once per matching status row and silently multiply the totals.
 */
function filterSql(f: AnalyticsFilters, params: unknown[]): string {
  const clauses: string[] = [];
  const bind = (v: unknown): string => `$${params.push(v)}`;

  if (f.from !== undefined) clauses.push(`${ANALYTICS_DATE_SQL} >= ${bind(f.from)}::date`);
  if (f.to !== undefined) clauses.push(`${ANALYTICS_DATE_SQL} <= ${bind(f.to)}::date`);
  /*
   * A date range EXCLUDES deals with neither date: asking for a period cannot include deals that
   * belong to no period.
   *
   * TD-092 — THE RANGE AND THE CHART ANSWER DIFFERENT QUESTIONS, AND NO LONGER PRETEND OTHERWISE.
   * This used to say the range applied the same rule the month chart did. It deliberately does not
   * any more. Membership of a period is COALESCE(closing, offer) — a deal that has not closed still
   * belongs to the period it was written in, and dropping it from a filtered view would hide live
   * work. The month a BAR is drawn in is the closing date alone, because that is what the chart is
   * headed. So a deal with only an offer date inside the range is included by the filter and
   * appears under "No closing date" in the chart: both facts stated, instead of one invented.
   */
  if (f.from !== undefined || f.to !== undefined) clauses.push(`${ANALYTICS_DATE_SQL} IS NOT NULL`);

  if (f.type !== undefined) clauses.push(`t.type = ${bind(f.type)}`);

  if (f.status !== undefined) {
    clauses.push(`EXISTS (SELECT 1 FROM transaction_statuses st WHERE st.transaction_id = t.id AND st.status = ${bind(f.status)})`);
  }

  /*
   * THE AGENT FILTER MATCHES THE OWNERSHIP RULE, not just the `agent_user_id` column.
   *
   * A deal belongs to an agent when it carries their id, when it carries their name and no id at
   * all (a row that never resolved), or when they are on the team split. Filtering on
   * `agent_user_id = n` alone would have quietly dropped the second and third from every filtered
   * chart — the same narrowing that made the Dashboard and the Transactions list disagree.
   *
   * `parseAnalyticsFilters` has already refused an agent naming anyone but themselves, so this is a
   * narrowing of an authorized set rather than the thing that authorizes it.
   */
  if (f.agent_user_id !== undefined) {
    const id = bind(f.agent_user_id);
    clauses.push(`(
      t.agent_user_id = ${id}
      OR (t.agent_user_id IS NULL AND t.agent IS NOT NULL AND t.agent = (SELECT u.name FROM users u WHERE u.id = ${id}))
      OR (t.agent IS NOT NULL AND t.agent <> '' AND EXISTS (
        SELECT 1 FROM team_members tm WHERE tm.transaction_id = t.id AND (
          tm.user_id = ${id}
          OR (tm.user_id IS NULL AND tm.name = (SELECT u.name FROM users u WHERE u.id = ${id}))
        )))
    )`);
  }

  return clauses.length ? ` AND ${clauses.join(' AND ')}` : '';
}

/** Rows returned by the aggregates. `numeric` and `bigint` arrive as strings / BigInt. */
type TotalsRow = { paid: string | null; pending: string | null; paid_count: bigint; pending_count: bigint };
type MonthRow = { month: string; total: string };
type GroupRow = { key: string | null; count: bigint; total: string };

const money = (v: string | null): number => round2(Number(v ?? 0));

@Injectable()
export class DeskAnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commission: CommissionService,
  ) {}

  async summary(user: ScopedUser | null, filters: AnalyticsFilters = {}): Promise<DeskAnalytics> {
    // The same visibility rule the Transactions list applies — an agent's analytics are their own
    // deals, everyone else's are the brokerage's. One definition; see `common/transaction-scope.ts`.
    const scope = await this.scopeSql(user);
    // A scope that can match nothing short-circuits: there is no query to run, and no aggregate
    // that would return the right shape for "no rows" without one.
    if (scope === null) {
      return { totals: { total: 0, paid: 0, pending: 0, paid_count: 0, pending_count: 0 }, by_month: [], by_agent: [], by_type: [] };
    }

    /*
     * The filters are bound as PARAMETERS, and the four aggregates share one list.
     *
     * Built once so the `$1, $2 …` positions are identical in all four statements — a per-query
     * parameter list would number them differently and the fragments could not be shared.
     */
    const params: unknown[] = [];
    const narrowed = filterSql(filters, params);

    const [totals, byMonth, byAgent, byType] = await Promise.all([
      this.prisma.$queryRawUnsafe<TotalsRow[]>(`
        SELECT
          COALESCE(SUM(${AMOUNT}) FILTER (WHERE ${PAID}), 0)     AS paid,
          COALESCE(SUM(${AMOUNT}) FILTER (WHERE NOT ${PAID}), 0) AS pending,
          COUNT(*) FILTER (WHERE ${PAID})                        AS paid_count,
          COUNT(*) FILTER (WHERE NOT ${PAID})                    AS pending_count
        FROM transactions t
        WHERE t.deleted_at IS NULL AND ${scope}${narrowed}`, ...params),

      /*
       * TD-092 — THE CHART IS "COMMISSION BY CLOSING MONTH", SO A DEAL WITHOUT ONE SAYS SO.
       *
       * The month was `COALESCE(closing_date, offer_date)`, and deals with neither date were
       * dropped. One missing field therefore produced two different wrong answers, chosen by
       * whichever other date the deal happened to carry:
       *
       *   · a deal with an offer date was charted as CLOSING in its offer month — measured on a
       *     50,000 deal whose closing date was cleared: 2027-03 fell back by 50,000 and the offer
       *     month rose by exactly that, with the headline unchanged. The arithmetic reconciles
       *     perfectly, which is why a careful month-end review would never catch it;
       *   · a deal with neither date vanished from the chart altogether (the residue of TD-044).
       *
       * Both are now one honest bucket. `closing_date` alone decides the month, and everything else
       * lands in `none`, which the screen and the export both label "No closing date". Nothing is
       * dropped — the month totals still sum to the headline — and nothing is asserted to close in a
       * month it has no closing date for.
       *
       * The offer-date fallback is deliberately gone rather than moved: a deal that has not closed
       * has no closing month, and inventing one is the defect. Its commission is still visible, in
       * the bucket that says the date is missing.
       *
       * `to_char(date, 'YYYY-MM')` on a `date` column is the same value the TypeScript produced by
       * reading the driver's UTC midnight with `toISOString()`. It is also right, which the browser
       * version was not: reading those dates with local getters west of Greenwich gives the previous
       * day, and at a month boundary the previous MONTH.
       */
      this.prisma.$queryRawUnsafe<MonthRow[]>(`
        SELECT COALESCE(to_char(t.closing_date, 'YYYY-MM'), '${NO_CLOSING_DATE}') AS month,
               COALESCE(SUM(${AMOUNT}), 0) AS total
        FROM transactions t
        WHERE t.deleted_at IS NULL AND ${scope}${narrowed}
        GROUP BY 1
        -- The no-date bucket sorts last, said explicitly rather than left to the collation's view
        -- of how 'none' compares with '2027-03'. The expression is the grouped one repeated, which
        -- is what makes it legal to order by: the bare column is not in the GROUP BY.
        ORDER BY (COALESCE(to_char(t.closing_date, 'YYYY-MM'), '${NO_CLOSING_DATE}') = '${NO_CLOSING_DATE}') ASC, 1 ASC`, ...params),

      // Highest commission first — the order the two tables have always rendered in. The tie-break
      // on the key is not cosmetic: without it two agents on identical totals could swap places
      // between requests, and a table that reorders itself for no reason reads as a bug.
      this.prisma.$queryRawUnsafe<GroupRow[]>(`
        -- TD-045 - one agent, one row, keyed on IDENTITY rather than on the typed name. Grouping
        -- on the resolved NAME would be worse: two accounts sharing a name would pool their
        -- commission, and a rename would split one agent's history across the old and new label.
        -- So the GROUP BY is the account id where there is one, and only the DISPLAY is the name.
        -- A deal with no id falls back to its trimmed, case-folded name - an external/co-op agent,
        -- which is legitimate. An ambiguous name is left alone rather than guessed at.
        SELECT COALESCE(NULLIF(btrim(au.name), ''), NULLIF(btrim(t.agent), ''), 'Unassigned') AS key,
               COUNT(*) AS count, COALESCE(SUM(${AMOUNT}), 0) AS total
        FROM transactions t
        LEFT JOIN users au ON au.id = COALESCE(t.agent_user_id, (SELECT MIN(u2.id) FROM users u2 WHERE u2.name = btrim(t.agent) HAVING COUNT(*) = 1))
        WHERE t.deleted_at IS NULL AND ${scope}${narrowed}
        GROUP BY COALESCE(au.id::text, 'n:' || lower(btrim(COALESCE(t.agent, '')))),
                 COALESCE(NULLIF(btrim(au.name), ''), NULLIF(btrim(t.agent), ''), 'Unassigned')
        ORDER BY 3 DESC, 1 ASC`, ...params),

      this.prisma.$queryRawUnsafe<GroupRow[]>(`
        SELECT t.type AS key, COUNT(*) AS count, COALESCE(SUM(${AMOUNT}), 0) AS total
        FROM transactions t
        WHERE t.deleted_at IS NULL AND ${scope}${narrowed}
        GROUP BY 1
        ORDER BY 3 DESC, 1 ASC`, ...params),
    ]);

    const row = totals[0] ?? { paid: '0', pending: '0', paid_count: 0n, pending_count: 0n };
    const paid = money(row.paid);
    const pending = money(row.pending);

    return {
      totals: {
        total: round2(paid + pending),
        paid,
        pending,
        paid_count: Number(row.paid_count),
        pending_count: Number(row.pending_count),
      },
      by_month: byMonth.map((m) => ({ month: m.month, total: money(m.total) })),
      /*
       * TD-002 - an agent sees who worked what, never what anyone earned.
       *
       * The brokerage's rule: another agent's NAME and DEAL COUNT are visible, their commission is
       * not. HIDING ONLY THE OTHER ROWS WOULD NOT ACHIEVE THAT - the totals card is on the same
       * screen, so one subtraction recovers the hidden figure exactly whenever two agents appear.
       * So for an agent the column comes off the table entirely; they read their own commission
       * from the totals, and nothing per-agent can be derived.
       *
       * NOT scoped by name-matching the viewer's own row. by_agent groups on t.agent, which is free
       * text (TD-045), and this file already warns that the brokerage has two active accounts
       * sharing a name - a namesake would be handed the other's figures by an exact string match.
       */
      by_agent: byAgent.map((r) => ({
        agent: r.key ?? 'Unassigned',
        count: Number(r.count),
        total: isAgent(user) ? null : money(r.total),
      })),
      by_type: byType.map((r) => ({ type: r.key ?? '', count: Number(r.count), total: money(r.total) })),
    };
  }

  /**
   * The values the filter controls offer.
   *
   * THE AGENT LIST IS THE ONLY PART THAT NEEDS A RULE. Deal types and statuses are the application's
   * fixed vocabularies and are the same for everybody. The agent roster is not: handing an agent the
   * brokerage's list of names and hiding the control in the browser would publish the roster to
   * anybody who opened the network tab. An agent is answered with their own single entry, which is
   * also the only value `parseAnalyticsFilters` will accept from them.
   */
  async filterOptions(
    user: ScopedUser | null,
    types: string[],
    statuses: string[],
  ): Promise<{ agents: { id: number; name: string }[]; types: string[]; statuses: string[]; locked_agent_id: number | null }> {
    const own = typeof user?.id === 'number' ? user.id : null;
    if (isAgent(user)) {
      return {
        agents: own === null ? [] : [{ id: own, name: user?.name ?? '' }],
        types,
        statuses,
        // The screen uses this to lock (or hide) the control. It is presentation only — the server
        // refuses another agent's id regardless of what the browser does with this field.
        locked_agent_id: own,
      };
    }
    const agents = await this.prisma.users.findMany({
      where: { role: 'agent', status: 'Active' },
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return { agents, types, statuses, locked_agent_id: null };
  }

  /**
   * The visibility rule as a SQL fragment — resolved through `transactionScopeWhere`, never
   * re-spelled.
   *
   * THIS IS THE ONE PLACE THIS SERVICE COULD GET AUTHORIZATION WRONG, so it does not write the rule.
   * `common/transaction-scope.ts` is deliberately the single definition of "which deals are mine"
   * — id first, name only for rows that never resolved to an account — because the brokerage has two
   * active accounts sharing a name and a second spelling of that rule is exactly how a namesake ends
   * up reading somebody else's deals. Restating it as hand-written SQL here would be that second
   * spelling.
   *
   * So the rule is evaluated by Prisma, as it always is, and this asks it for the matching ids.
   * For an agent that is their own deals — tens or hundreds, not the brokerage — so the id list is
   * small and the extra round trip is nothing beside the aggregate it scopes. For everybody else the
   * rule is empty and there is no extra query at all.
   *
   * Returns `null` for "matches nothing", which is a different answer from "matches everything" and
   * must not collapse into it.
   */
  private async scopeSql(user: ScopedUser | null): Promise<string | null> {
    const where = transactionScopeWhere(user);
    if (Object.keys(where).length === 0) return 'TRUE';

    const rows = await this.prisma.transactions.findMany({
      where: { AND: [{ deleted_at: null }, where] },
      select: { id: true },
    });
    if (rows.length === 0) return null;
    return `t.id IN (${rows.map((r) => r.id).join(',')})`;
  }

  /**
   * The TypeScript implementation of one row's contribution, kept for the parity gate.
   *
   * NOT DEAD CODE AND NOT A SECOND IMPLEMENTATION IN USE. `desk-sql-parity.spec.ts` calls this for
   * every transaction in the database and compares it with what `desk_gross_commission` and
   * `php_round2` return for the same row, requiring exact equality. It is the reference the SQL is
   * measured against, which is the only reason the SQL can be trusted with money.
   */
  amountFor(t: AnalyticsRow): { amount: number; paid: boolean } {
    const s = this.commission.summarize(toCommissionTxn(t));
    return { amount: s.amount, paid: s.paid };
  }
}

/** The columns the reference implementation reads. */
export const ANALYTICS_SELECT = {
  id: true,
  type: true,
  agent: true,
  price: true,
  deposit: true,
  comm_type: true,
  comm_value: true,
  comm_pct: true,
  comm_amt: true,
  comm_adjust_enabled: true,
  comm_adjust_before: true,
  comm_adjust_after: true,
  listing_comm_pct: true,
  coop_comm_pct: true,
  listing_comm_flat: true,
  coop_comm_flat: true,
  listing_adj_enabled: true,
  listing_adj_before: true,
  listing_adj_after: true,
  coop_adj_enabled: true,
  coop_adj_before: true,
  coop_adj_after: true,
  precon_net_of_hst: true,
  precon_comm_pct: true,
  precon_comm_amt_manual: true,
  precon_term_count: true,
  comm_paid_status: true,
  comm_status: true,
  agent_user_id: true,
  closing_date: true,
  offer_date: true,
} satisfies Prisma.transactionsSelect;

export type AnalyticsRow = Prisma.transactionsGetPayload<{ select: typeof ANALYTICS_SELECT }>;

const num = (d: Prisma.Decimal | number | null): number => (d === null ? 0 : Number(d));
const numN = (d: Prisma.Decimal | number | null): number | null => (d === null ? null : Number(d));

/**
 * The commission input, built from the selected columns.
 *
 * `normalizeCommissionTxn` is not used because it reads `adjustments` and the two relation
 * collections, none of which `summarize()` looks at. The empty collections and null blob below are
 * what `summarize` sees either way; the one function that needs them is `breakdown()`, which this
 * screen never calls.
 */
function toCommissionTxn(t: AnalyticsRow): CommissionTxn {
  return {
    type: t.type,
    price: num(t.price),
    deposit: num(t.deposit),
    comm_type: t.comm_type,
    comm_value: num(t.comm_value),
    comm_pct: numN(t.comm_pct),
    comm_amt: numN(t.comm_amt),
    comm_adjust_enabled: t.comm_adjust_enabled,
    comm_adjust_before: num(t.comm_adjust_before),
    comm_adjust_after: num(t.comm_adjust_after),
    listing_comm_pct: numN(t.listing_comm_pct),
    coop_comm_pct: numN(t.coop_comm_pct),
    listing_comm_flat: numN(t.listing_comm_flat),
    coop_comm_flat: numN(t.coop_comm_flat),
    listing_adj_enabled: t.listing_adj_enabled,
    listing_adj_before: num(t.listing_adj_before),
    listing_adj_after: num(t.listing_adj_after),
    coop_adj_enabled: t.coop_adj_enabled,
    coop_adj_before: num(t.coop_adj_before),
    coop_adj_after: num(t.coop_adj_after),
    precon_net_of_hst: t.precon_net_of_hst,
    precon_comm_pct: numN(t.precon_comm_pct),
    precon_comm_amt_manual: numN(t.precon_comm_amt_manual),
    precon_term_count: t.precon_term_count,
    comm_paid_status: t.comm_paid_status,
    comm_status: t.comm_status,
    agent: t.agent,
    agent_user_id: t.agent_user_id ?? null,
    adjustments: null,
    teamMembers: [],
    preconTerms: [],
  };
}
