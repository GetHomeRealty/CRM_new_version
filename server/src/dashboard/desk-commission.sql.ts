/**
 * The Dashboard's commission figures, as one SQL statement.
 *
 * WHY THIS FILE EXISTS. `DashboardService.commissions` read every non-deleted transaction in the
 * brokerage with three relations attached, called `CommissionService.breakdown()` on each, and
 * summed the agent T4A lines in Node. Measured at 80,000 deals: 9,580 ms for an office user working
 * alone, and a 62,663 ms MEDIAN with a hundred people on the system — on the screen everybody lands
 * on first. The cost is not the query. It is fetching eighty thousand object graphs and doing
 * per-member arithmetic on them, once per person, every time anybody opens the Dashboard.
 *
 * WHAT IT IS. A transliteration of the T4A path through `CommissionService.breakdown` — all three
 * variants — plus `resolveMembers`, `agentDefaultSplit` and `DashboardService.memberPaid`. The
 * database resolves the members, computes each one's T4A commission, classifies it paid / pending /
 * upcoming and returns nine numbers.
 *
 * THE HAZARD, STATED PLAINLY. This is a SECOND IMPLEMENTATION OF THE COMMISSION MATH. That is the
 * thing this codebase has otherwise been careful to avoid, and for a good reason: two copies of a
 * financial rule drift, and when they drift the symptom is a wrong number on a screen rather than a
 * crash. It is here because the alternative — reading every deal into Node on every Dashboard open —
 * is what the measurements above describe, and no amount of query tuning changes that shape.
 *
 * WHAT MAKES IT SAFE ENOUGH TO KEEP. `core/desk-sql-parity.spec.ts` runs `DashboardService`
 * against the ORIGINAL TypeScript engine and against this SQL, over every transaction in the
 * database and for every role, and compares every numeric leaf for EXACT equality — no tolerance,
 * because the failure being guarded against is a sub-cent drift that rounds into a visible figure.
 * `DashboardService.commissionsInNode` is kept for exactly that purpose and is not dead code.
 *
 * IF YOU CHANGE `CommissionService`, CHANGE THIS TOO. The parity spec will fail if you do not, which
 * is the point of it.
 *
 * ---------------------------------------------------------------------------------------------
 * ARITHMETIC NOTES, because these are the places a "cleaner" rewrite silently breaks:
 *
 *   · `(1::float8 + 0.13::float8)` IS NOT `1.13`. In binary64, 0.13 is slightly above 13/100, so
 *     `1 + 0.13` is the double ABOVE 1.13 while the literal `1.13` is the one BELOW it. The
 *     TypeScript computes `1 + HST_RATE`, so every gross-up here must too. Writing `1.13` moves
 *     agent payouts in the last cent.
 *   · Everything is `double precision`, not `numeric`, for the same reason: binary64 is what
 *     JavaScript numbers are, and `numeric` would be exact where the original was not.
 *   · `php_round2` is applied at exactly the points `round2` is applied in the TypeScript, and
 *     nowhere else. An extra rounding step is as wrong as a missing one.
 *   · The FINAL sums use `numeric`, because by then every value has been through `php_round2` and
 *     is exactly two decimal places. That makes the total independent of the order rows are
 *     aggregated in — floating-point addition is not associative, and a parallel aggregate does not
 *     promise an order.
 */

/**
 * The deal types the LISTING breakdown claims, as a SQL list.
 *
 * Named once because it appears in three places — the variant partition, the standard variant's
 * exclusion and the listing variant's inclusion — and a list that disagrees with itself would put a
 * deal through two breakdowns or none.
 */
const LISTING_TYPES = `'Residential Sale Listing','Residential Lease Listing','Commercial Property Sale Listing','Commercial Property Lease Listing','Business Sale'`;

/** `1 + HST_RATE`, spelled so it is the same double the TypeScript computes. See the note above. */
export const G = '(1::float8 + 0.13::float8)';
export const HST = '0.13::float8';

/**
 * Every column the aggregate reads, cast once.
 *
 * `scope` is a SQL predicate supplied by the caller — see `DashboardService.scopeSql`, which
 * resolves it through `common/transaction-scope.ts` rather than re-spelling the ownership rule.
 */
/**
 * How `scoped` should obtain the parsed `admin_activities`.
 *
 *   'always' — parse it for every row. What the Dashboard needs: `desk_member_paid` reads it per
 *              member and there is no cached equivalent of that per-member figure.
 *   'stale'  — parse it ONLY for rows the payment cache has not computed (`calc_at IS NULL`), and
 *              give every other row NULL. The report totals need it only as a fallback, so this
 *              turns a per-row parse into one that normally never runs.
 *
 * MEASURED, because the first attempt to measure it was wrong. Selecting `desk_safe_jsonb(...)`
 * without consuming the result costs nothing — Postgres elides it — which read as "parsing is free".
 * Consuming it: 851 ms against 206 ms for the same scan without, over 80,000 rows. The cached column
 * sums in 163 ms.
 */
export type AdminBlobMode = 'always' | 'stale';

export const scopedCte = (scope: string, typeFilter: string, adminBlob: AdminBlobMode = 'always'): string => `
scoped AS (
  SELECT
    t.id, t.type, t.agent,
    t.price::float8                     AS price,
    t.comm_type,
    t.comm_value::float8                AS comm_value,
    t.comm_pct::float8                  AS comm_pct,
    t.comm_amt::float8                  AS comm_amt,
    t.comm_adjust_enabled,
    t.comm_adjust_before::float8        AS comm_adjust_before,
    t.comm_adjust_after::float8         AS comm_adjust_after,
    t.listing_comm_pct::float8          AS listing_comm_pct,
    t.coop_comm_pct::float8             AS coop_comm_pct,
    t.listing_comm_flat::float8         AS listing_comm_flat,
    t.coop_comm_flat::float8            AS coop_comm_flat,
    t.listing_adj_enabled,
    t.listing_adj_before::float8        AS listing_adj_before,
    t.listing_adj_after::float8         AS listing_adj_after,
    t.precon_comm_pct::float8           AS precon_comm_pct,
    t.precon_comm_amt_manual::float8    AS precon_comm_amt_manual,
    t.precon_term_count,
    desk_safe_jsonb(t.adjustments)      AS adj,
    ${adminBlob === 'always'
    ? 'desk_safe_jsonb(t.admin_activities) AS admin,'
    // CASE is short-circuiting, so the parse runs only for rows the cache has not reached. With the
    // backfill complete that is none, and the column is NULL for every row — which is safe because
    // the only consumer guards on `calc_at` before touching it.
    : `CASE WHEN t.calc_at IS NULL THEN desk_safe_jsonb(t.admin_activities) END AS admin,`}
    t.calc_at,
    t.calc_paid_total::numeric          AS calc_paid_total,
    (t.type ~* 'lease')                 AS is_lease,
    EXISTS (
      -- TD-084. 'is_closed' really means 'has ended' - it drives the upcoming figures, which must
      -- shed a deal the moment it dies, not only when it closes. This tested status = 'Closed'
      -- alone, so a deal moved to DFT / Mutual Release / Terminated / Void kept its commission in
      -- the agent's upcoming total and stayed in the pipeline count. Broadened to every ending
      -- status; the name is left as is to avoid churning its consumers.
      SELECT 1 FROM transaction_statuses st
      WHERE st.transaction_id = t.id
        AND st.status IN ('Closed', 'DFT', 'Mutual Release', 'Terminated', 'Void')
    )                                   AS is_closed
  FROM transactions t
  WHERE t.deleted_at IS NULL AND ${scope} AND ${typeFilter}
)`;

/**
 * The three commission variants, as type predicates.
 *
 * They PARTITION the deals — every transaction matches exactly one — which is what makes running
 * them as three separate queries and adding the results identical to running one query over
 * everything. Each subtotal is an exact two-decimal numeric, and decimal addition is associative,
 * so the order they are added in cannot move a cent.
 */
export const VARIANTS = {
  standard: `t.type <> 'Preconstruction' AND t.type NOT IN (${LISTING_TYPES})`,
  listing: `t.type IN (${LISTING_TYPES})`,
  precon: `t.type = 'Preconstruction'`,
} as const;

export type CommissionVariant = keyof typeof VARIANTS;

/**
 * The two referral figures off the adjustments blob — brokerReferralAmount and
 * clientReferralAmount.
 *
 * Both are gated on a Yes/No flag that defaults to No when the key is absent, and both read amounts
 * through desk_json_num because those fields are sometimes numbers and sometimes strings. The
 * client figure is a SUM over client_rows; a client_rows that is not an array contributes
 * nothing rather than failing, matching CommissionService.rows().
 */
export const REFS_CTE = `
refs AS MATERIALIZED (
  SELECT
    s.id,
    CASE WHEN COALESCE(s.adj->>'ext_referral', 'No') = 'Yes'
         THEN desk_json_num(s.adj->'ext'->'amount') ELSE 0::float8 END AS ext_ref,
    CASE WHEN COALESCE(s.adj->>'client_referral', 'No') = 'Yes'
         THEN COALESCE((
           SELECT SUM(desk_json_num(r->'amount'))
           FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(s.adj->'client_rows') = 'array'
                  THEN s.adj->'client_rows' ELSE '[]'::jsonb END) r
         ), 0::float8) ELSE 0::float8 END AS client_ref
  FROM scoped s
)`;

/**
 * The deals whose adjustments blob actually carries a deduction — and nothing else.
 *
 * The agent line needs `memberDeduction`, which reads `adjustments`. Reaching it through `scoped`
 * means hash-joining a CTE that carries two parsed jsonb documents per row, for every deal, to serve
 * the minority that have anything in them: measured at 80,000 deals that join and the function calls
 * behind it were most of the 8.5 s the report totals spent on the standard branch.
 *
 * This is the same two flags `desk_member_deduction` checks first. A deal that is not here is
 * LEFT JOINed to NULL, and `desk_member_deduction(NULL, …)` is 0 — the same answer the function
 * would have computed the long way, which is why the join can be an outer one rather than a filter.
 */
export const DEDUCTIBLE_CTE = `
deductible AS MATERIALIZED (
  SELECT s.id, s.adj
  FROM scoped s
  WHERE COALESCE(s.adj->>'agent_adjust', 'No') = 'Yes'
     OR COALESCE(s.adj->>'advance_payment', 'No') = 'Yes'
)`;

/**
 * CommissionService.resolveMembers — who is on the deal, after the two special cases.
 *
 * THE TWO SPECIAL CASES ARE THE WHOLE POINT of this CTE; the stored rows alone are not the answer.
 *
 *   1. NO TEAM ROWS AT ALL, but the deal has an agent: that agent holds the entire deal, at the
 *      split from their user profile. agentDefaultSplit — lease_comm_pct on a lease and
 *      agent_comm_pct otherwise, defaulting to 95/90, read through phpFloat so "90%" is 90.
 *   2. TEAM ROWS EXIST BUT NOBODY HAS A SHARE. team_members.split defaults to 0 and selecting
 *      agents on the Add Transaction screen adds them with no split, so every agent line would
 *      multiply out to zero. The PRIMARY agent — the FIRST row whose name matches the deal's agent —
 *      is given 100 until real splits are entered.
 *
 * person resolves a name to one account the way PersonResolver does: an Active row wins, ties
 * break on the lowest id. Deterministic, and the same rule the uncached TypeScript path applies —
 * this brokerage has two active accounts sharing a name, and "whichever the planner returned first"
 * was once a $21,865.50 error.
 */
export const MEMBERS_CTE = `
person AS (
  SELECT DISTINCT ON (u.name) u.name, desk_safe_jsonb(u.profile) AS profile
  FROM users u
  ORDER BY u.name, (u.status = 'Active') DESC, u.id ASC
),
mem_ord AS MATERIALIZED (
  SELECT
    tm.transaction_id AS tid, tm.name, tm.scope, tm.id AS mid,
    tm.split::float8     AS split,
    tm.agent_pct::float8 AS agent_pct,
    tm.brok_pct::float8  AS brok_pct,
    s.agent              AS deal_agent,
    ROW_NUMBER() OVER (PARTITION BY tm.transaction_id ORDER BY tm.position ASC, tm.id ASC) AS ord
  FROM team_members tm
  JOIN scoped s ON s.id = tm.transaction_id
),
mem_raw AS MATERIALIZED (
  /*
   * WHICH ROW IS THE PRIMARY, AS A WINDOW FUNCTION — and it has to be one, not a subquery.
   *
   * findIndex(m => m.name === t.agent) reads naturally as a correlated SELECT MIN(ord) … WHERE
   * tid = … AND name = agent, and that is what this was. Against a materialised CTE the planner has
   * no index to use, so it rescans the whole member set once per member: measured at 80,000 deals,
   * the aggregate had not finished after four minutes. As a window aggregate it is one pass.
   *
   * The ordering has to be computed in the CTE below first — a window function cannot be nested
   * inside another one.
   *
   * MIN over a CASE that yields NULL for non-matching rows, so a deal whose agent matches no member
   * row leaves this NULL and promotes nobody. That is findIndex returning -1.
   */
  SELECT m.*,
         MIN(CASE WHEN m.name = m.deal_agent THEN m.ord ELSE NULL END)
           OVER (PARTITION BY m.tid) AS primary_ord
  FROM mem_ord m
),
mem_stats AS MATERIALIZED (
  SELECT tid, COUNT(*) AS n, COALESCE(MAX(CASE WHEN split > 0 THEN 1 ELSE 0 END), 0) AS any_split
  FROM mem_raw GROUP BY tid
),
members AS MATERIALIZED (
  -- stored rows, with case 2 applied
  SELECT
    m.tid, m.name, m.scope, m.mid, m.ord,
    CASE
      WHEN ms.any_split = 0
       AND m.deal_agent IS NOT NULL AND m.deal_agent <> ''
       AND m.primary_ord IS NOT NULL
       AND m.ord = m.primary_ord
      THEN 100::float8 ELSE m.split
    END AS split,
    m.agent_pct, m.brok_pct
  FROM mem_raw m
  JOIN mem_stats ms ON ms.tid = m.tid

  UNION ALL

  -- case 1: the synthetic single member
  SELECT
    s.id, s.agent, 'Entire'::varchar, NULL::int, 1::bigint,
    100::float8,
    d.agent_pct,
    php_round2f(100::float8 - d.agent_pct)
  FROM scoped s
  LEFT JOIN mem_stats ms ON ms.tid = s.id
  LEFT JOIN person p     ON p.name = s.agent
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN COALESCE(p.profile->>(CASE WHEN s.is_lease THEN 'lease_comm_pct' ELSE 'agent_comm_pct' END), '') <> ''
        THEN desk_php_float(p.profile->>(CASE WHEN s.is_lease THEN 'lease_comm_pct' ELSE 'agent_comm_pct' END))
      ELSE CASE WHEN s.is_lease THEN 95::float8 ELSE 90::float8 END
    END AS agent_pct
  ) d
  WHERE ms.tid IS NULL AND s.agent IS NOT NULL AND s.agent <> ''
),
/*
 * Per-deal facts about the member set, computed once.
 *
 * first_agent_pct is members[0].agent_pct — the value the listing variant sizes its whole agent pool
 * with. Reading it with a correlated ORDER BY ord LIMIT 1 per deal is the same quadratic trap as the
 * primary-row lookup above; one grouped pass answers it for every deal at once.
 */
mem_deal AS MATERIALIZED (
  SELECT tid, (ARRAY_AGG(agent_pct ORDER BY ord))[1] AS first_agent_pct
  FROM members GROUP BY tid
)`;

/**
 * The STANDARD variant's per-member T4A.
 *
 * agentCommissionsAfterClient is a sum over every member that then feeds back into each member's
 * own line, which is why this is two passes: std_pool computes the pool across the deal's members,
 * std_lines divides it back out by each member's share. A window function could express it in one
 * pass, but the aggregate must be over the members as a SET before any member's line is known.
 *
 * min brokerage is 200 before HST here — the standard breakdown's floor. The listing variant uses
 * 499 (or 250 on a lease), which is why that block has its own.
 */
export const STANDARD_CTE = (full = false): string => `
std_base AS MATERIALIZED (
  SELECT
    s.id,
    php_round2f(
      desk_gross_base(s.price, s.comm_type, s.comm_value, s.comm_pct, s.comm_amt)
      - CASE WHEN s.comm_adjust_enabled THEN s.comm_adjust_before ELSE 0::float8 END
    ) AS commission,
    CASE WHEN s.comm_adjust_enabled THEN s.comm_adjust_before ELSE 0::float8 END AS adj_before,
    CASE WHEN s.comm_adjust_enabled THEN s.comm_adjust_after  ELSE 0::float8 END AS adj_after,
    r.ext_ref, r.client_ref
  -- No type filter here: scoped is already restricted to this variant. See VARIANTS.
  FROM scoped s JOIN refs r ON r.id = s.id
),
std_lc AS MATERIALIZED (
  SELECT b.*, php_round2f(b.commission - b.ext_ref) AS lc FROM std_base b
),
/*
 * TD-025, RESTORED TO THIS SIDE — each member's OWN entitlement, kept as well as summed.
 *
 * agentCommissionsAfterClient in commission.service.ts builds exactly this number per member
 * and keeps it in an entitlements map, because the line each person is paid is their own
 * entitlement's share of the pool — not their split's share. The transliteration summed it and
 * threw the parts away, so the pool was right and the DIVISION was flat: on deal 001 (840,000 at
 * 2.5%, split 60/20/20, rates 90/95/90) the TypeScript pays 11,340 / 3,990 / 3,780 while the SQL
 * paid 11,466 / 3,822 / 3,822. Same total to the cent, three wrong cheques — which is why the
 * headline reconciled and desk-sql-parity.spec.ts was the only thing that noticed.
 */
std_own AS MATERIALIZED (
  SELECT
    l.id, m.name, m.split,
    GREATEST(0::float8, LEAST(
      l.lc * (m.agent_pct / 100) * (m.split / 100),
      l.lc - CASE WHEN l.lc = 0 THEN 0::float8
                  -- TD-080: ex-HST against ex-HST. This was 200 * G, an HST-inclusive figure
                  -- compared against a percentage of lc, which is ex-HST.
                  ELSE GREATEST(l.lc * (m.brok_pct / 100) * (m.split / 100), 200::float8)
                       - (l.adj_before * ${G} - l.adj_after) END
    )) AS own
  FROM std_lc l LEFT JOIN members m ON m.tid = l.id
),
std_pool AS MATERIALIZED (
  SELECT
    o.id,
    php_round2f(COALESCE(SUM(o.own), 0::float8) * ${G} - MIN(l.client_ref)) AS ac_total,
    -- The UNROUNDED pool, which is what the share is taken against on the TypeScript side.
    COALESCE(SUM(o.own), 0::float8) AS pool
  FROM std_own o JOIN std_lc l ON l.id = o.id
  -- GROUPED BY THE ID ALONE. This used to list lc, adj_before, adj_after and client_ref as group
  -- keys too, and lc is a nested php_round2 over the whole four-way commission fallback — so the
  -- planner made that expression a SORT KEY and re-evaluated it for every row it compared. Measured
  -- at 80,000 deals: 4.5 s in this node alone. The columns are constant within a deal, so MIN()
  -- reads them without their being keys.
  GROUP BY o.id
),
std_raw AS MATERIALIZED (
  /*
   * THE UNROUNDED LINE, ONE ROW PER MEMBER — and it is a MATERIALIZED CTE rather than a LATERAL
   * because that is the only way to compute each value exactly once.
   *
   * This was three CROSS JOIN LATERALs feeding the projection below, on the reasoning that a
   * single-row LATERAL names a value and names are evaluated once. THEY ARE NOT. The planner
   * flattens a single-row LATERAL into the parent's target list, so every reference to it is a fresh
   * copy of its expression: a.total appears four times below and was therefore four calls to
   * php_round2f AND four calls to desk_member_deduction, per member, per run.
   *
   * A materialised CTE is a real barrier — the value is computed, stored, and read as a column.
   * Measured at 80,000 deals this node went from 4.9 s to under a second.
   */
  -- TD-025: the share is this member's own entitlement over the pool, falling back to the split
  -- when there is no pool to divide - which is what agentCommissionLine does, and never a zero.
  SELECT o.id AS tid, o.name,
         php_round2f(p.ac_total * CASE WHEN p.pool > 0 THEN o.own / p.pool ELSE o.split / 100 END) AS t4a_raw${full ? `,
         php_round2f(p.ac_total * CASE WHEN p.pool > 0 THEN o.own / p.pool ELSE o.split / 100 END - desk_member_deduction(s.adj, o.name, NULL)) AS total,
         -- TD-124: the remainder of the member's share, not a flat percentage that never
         -- consulted the minimum. The subtrahend is the share BEFORE any deduction — t4a_raw's own
         -- expression, repeated rather than named, because an output alias cannot be read inside
         -- the SELECT list that defines it. The total column above repeats it for the same reason.
         GREATEST(php_round2f((l.lc * o.split) / 100)
                  - php_round2(php_round2f(p.ac_total * CASE WHEN p.pool > 0 THEN o.own / p.pool ELSE o.split / 100 END) / ${G}),
                  0::float8) AS brok_wo` : ''}
  FROM std_pool p
  JOIN std_own o ON o.id = p.id${full ? `
  JOIN members m ON m.tid = p.id AND m.name IS NOT DISTINCT FROM o.name AND m.split IS NOT DISTINCT FROM o.split
  JOIN std_lc l  ON l.id  = p.id
  -- A PLAIN JOIN, not a correlated subquery on scoped.
  --
  -- The first version of this read the adjustments blob with a correlated
  -- CROSS JOIN LATERAL (SELECT … FROM scoped s WHERE s.id = p.id), which reads naturally and is a
  -- rescan of a materialised CTE once per member row: 49,000 rows probing a 49,000-row CTE with no
  -- index on it. Measured at 80,000 deals it took this branch from 1.4 s to 21.4 s and, because the
  -- Dashboard shares this CTE, took the Dashboard with it. Joined, it is one hash join.
  LEFT JOIN deductible s ON s.id = p.id` : ''}
),
std_lines AS MATERIALIZED (
  /*
   * t4a is the line BEFORE any deduction; agent_* is the same line AFTER it.
   *
   * That is not a redundancy — agentLines builds both, deliberately: T4A is what gets reported to
   * the Canada Revenue Agency and does not move because the brokerage advanced somebody money, while
   * the agent's own commission column on a report is what they are actually owed. The Dashboard
   * shows the first, Reports total the second.
   *
   * brokerage is the brokerage side of the same member's share, and takes the OTHER association:
   * (commissionWoHst * m.split) / 100, multiply then divide, where the agent side divides the
   * percentage first. Both are copied from agentLines as they stand.
   */
  SELECT tid, name,
         php_round2(t4a_raw / ${G}) AS t4a${full ? `,
         total                                              AS agent_w,
         php_round2(total / ${G})                           AS agent_wo,
         php_round2(total - php_round2f(total / ${G}))      AS agent_hst,
         php_round2(brok_wo)                                AS brok_wo,
         php_round2(brok_wo * ${HST})                       AS brok_hst,
         php_round2(brok_wo * ${G})                         AS brok_w` : ''}
  FROM std_raw
)`;

/**
 * The LISTING variant's per-member T4A (listing types, plus Business Sale).
 *
 * agentSplit comes from the FIRST member's agent_pct — members[0] in the TypeScript, which is
 * the lowest position. Not an average, not the per-member value: one deal-level split that sizes
 * the whole agent pool, which is then divided by each member's team share. A deal with no members at
 * all falls back to 95 on a lease and 90 otherwise, the same defaults agentDefaultSplit uses.
 *
 * The adjustments are ADDED here and subtracted in the standard variant. That is not a transcription
 * error: listComm = base + flat + lAdjBefore is what the listing breakdown does.
 */
export const LISTING_CTE = (full = false): string => `
lst_base AS MATERIALIZED (
  SELECT
    s.id, s.is_lease,
    CASE WHEN s.is_lease THEN 250::float8 ELSE 499::float8 END AS min_brok,
    (s.price * COALESCE(s.listing_comm_pct, 0)) / 100
      + COALESCE(s.listing_comm_flat, 0)
      + CASE WHEN s.listing_adj_enabled THEN s.listing_adj_before ELSE 0::float8 END AS list_comm,
    CASE WHEN s.listing_adj_enabled THEN s.listing_adj_after ELSE 0::float8 END AS l_adj_after,
    r.ext_ref, r.client_ref
  FROM scoped s JOIN refs r ON r.id = s.id
),
lst_split AS MATERIALIZED (
  SELECT
    b.id, b.client_ref,
    php_round2f((b.list_comm + b.list_comm * ${HST} + b.l_adj_after) - b.ext_ref * ${G}) AS split_total,
    b.min_brok
  FROM lst_base b
),
/*
 * TD-025 ON THE LISTING SIDE — each member at their OWN rate, not the first member's.
 *
 * This variant sized one agent pool from members[0].agent_pct and sliced it by split, so two agents
 * on a listing could never be on different plans and the per-member agent_pct was reported but
 * never used. The TypeScript stopped doing that (breakdownListing, the memberEarn/floorScale
 * block); the transliteration did not, and desk-sql-parity was the only thing that noticed.
 *
 * The rule, copied from there: each member earns splitTotal x share x their own rate, less their
 * share of the client referral; if the sum of those would leave the brokerage under its minimum,
 * every line is scaled down by the same factor rather than one member absorbing the shortfall.
 * mem_deal.first_agent_pct is no longer read here, which is what made a mixed-rate team wrong.
 */
lst_own AS MATERIALIZED (
  SELECT
    x.id, m.name, m.split,
    x.split_total * (m.split / 100) * (m.agent_pct / 100) - x.client_ref * (m.split / 100) AS raw
  FROM lst_split x LEFT JOIN members m ON m.tid = x.id
),
lst_pool AS MATERIALIZED (
  SELECT
    x.id, x.client_ref, x.split_total,
    CASE
      -- TD-080: the minimum is ex-HST here too, matching agentCommissionsAfterClient.
      WHEN COALESCE(SUM(o.raw), 0::float8) > GREATEST(x.split_total - x.min_brok, 0::float8)
       AND COALESCE(SUM(o.raw), 0::float8) > 0::float8
      THEN GREATEST(x.split_total - x.min_brok, 0::float8) / COALESCE(SUM(o.raw), 0::float8)
      ELSE 1::float8
    END AS floor_scale
  FROM lst_split x LEFT JOIN lst_own o ON o.id = x.id
  GROUP BY x.id, x.client_ref, x.split_total, x.min_brok
),
lst_raw AS MATERIALIZED (
  -- The member's unrounded share, computed once. A single-row LATERAL would be flattened and its
  -- expression copied into each of the seven references below — see the note on std_raw.
  SELECT o.id AS tid, o.name,
         GREATEST(o.raw * p.floor_scale, 0::float8) AS earned${full ? `,
         (p.split_total * (o.split / 100) - GREATEST(o.raw * p.floor_scale, 0::float8)) / ${G} AS brok_wo` : ''}
  FROM lst_pool p
  JOIN lst_own o ON o.id = p.id
),
lst_lines AS MATERIALIZED (
  /*
   * On a listing deal T4A and the agent line are the SAME triple — breakdownListing builds one
   * object and uses it for both — so agent_wo repeats t4a rather than recomputing it. There is
   * no member deduction here: the listing breakdown takes the client referral off the pool before it
   * is divided, not off each member afterwards.
   *
   * The brokerage side is what is left of the split total after the agent pool, shared out by the
   * same team percentages: line(brokFromMember / g).
   */
  SELECT tid, name,
         php_round2(earned / ${G})   AS t4a${full ? `,
         php_round2(earned / ${G})   AS agent_wo,
         php_round2((earned / ${G}) * ${HST}) AS agent_hst,
         php_round2(earned)          AS agent_w,
         php_round2(brok_wo)         AS brok_wo,
         php_round2(brok_wo * ${HST}) AS brok_hst,
         php_round2(brok_wo * ${G})  AS brok_w` : ''}
  FROM lst_raw
)`;

/**
 * The PRECONSTRUCTION variant's per-member T4A — one line per member PER TERM, summed.
 *
 * Terms are 1..precon_term_count, generated rather than read from precon_terms, because the
 * TypeScript iterates the COUNT and looks each term up: a term with no stored row contributes 0%
 * rather than being skipped, and a stored row beyond the count is ignored entirely. A LEFT JOIN
 * onto a generated series is the only shape that reproduces both.
 *
 * visibleAtTerm: a member scoped to 'Entire' appears in every term; anyone else appears only in
 * the terms listed on team_member_terms.
 *
 * Note the double rounding — the member's share is rounded, and then their agent percentage of it is
 * rounded again. That is agentLines with no agent context, and dropping either step moves the
 * total.
 *
 * AND NOTE THE ASSOCIATION: (x * split) / 100, multiply THEN divide. Everywhere else in the
 * commission engine the percentage is divided first (split = m.split / 100; … * split), and this
 * one place is not. In binary64 those are different numbers, so the difference is real and had to be
 * copied rather than tidied.
 */
export const PRECON_CTE = (full = false): string => `
pre_terms AS MATERIALIZED (
  SELECT s.id, k,
         php_round2f((s.price * COALESCE(pt.pct::float8, 0)) / 100) AS t_amt
  FROM scoped s
  CROSS JOIN LATERAL generate_series(1, GREATEST(COALESCE(s.precon_term_count, 0), 0)) k
  LEFT JOIN precon_terms pt ON pt.transaction_id = s.id AND pt.term_no = k
),
pre_raw AS MATERIALIZED (
  /*
   * One row per member PER TERM, unrounded and unsummed.
   *
   * Its own materialised CTE for the reason std_raw is: as a LATERAL, w.agent_wo is copied into
   * each of the three aggregates that read it, so the two nested roundings behind it ran three times
   * per term — and w.deduction likewise.
   */
  SELECT m.tid, m.name,
         php_round2f(php_round2f((t.t_amt * m.split) / 100) * m.agent_pct / 100) AS agent_wo${full ? `,
         -- TD-124: the remainder of this term's member share, as agentLines now takes it.
         GREATEST(php_round2f((t.t_amt * m.split) / 100)
                  - php_round2f(php_round2f((t.t_amt * m.split) / 100) * m.agent_pct / 100), 0::float8) AS brok_wo,
         desk_member_deduction(s.adj, m.name, t.k)                               AS deduction` : ''}
  FROM pre_terms t
  JOIN members m ON m.tid = t.id${full ? `
  LEFT JOIN deductible s ON s.id = t.id` : ''}
  WHERE COALESCE(m.scope, 'Entire') = 'Entire'
     OR EXISTS (SELECT 1 FROM team_member_terms tt WHERE tt.team_member_id = m.mid AND tt.term_no = t.k)
),
pre_lines AS MATERIALIZED (
  /*
   * One line per member PER TERM, then summed — so a member visible in four terms contributes four
   * lines to the totals and one entry to the Dashboard's counts, which is what the TypeScript does.
   *
   * The deduction is TERM-SCOPED here (memberDeduction(adj, m, k)), unlike the single-line
   * variants: an adjustment row carries the term it belongs to, and applying it to every term would
   * take it off the agent four times.
   */
  SELECT tid, name,
         SUM(agent_wo)                                     AS t4a${full ? `,
         SUM(agent_wo)                                     AS agent_wo,
         SUM(php_round2(agent_wo * ${HST}))                AS agent_hst,
         SUM(php_round2(agent_wo * ${G} - deduction))      AS agent_w,
         SUM(brok_wo)                                      AS brok_wo,
         SUM(php_round2(brok_wo * ${HST}))                 AS brok_hst,
         SUM(php_round2(brok_wo * ${G}))                   AS brok_w` : ''}
  FROM pre_raw
  GROUP BY tid, name
)`;

/**
 * The member lines for ONE variant, keyed by (deal, NAME) — and the key is why this collapses.
 *
 * t4aByMember accumulates into an object keyed by name, so two member rows with the same name on
 * one deal are ONE entry with their amounts added, and a preconstruction member appearing in four
 * terms is one entry, not four. That is a property of the original, not an accident of it: the
 * counts on the Dashboard tiles are counts of PEOPLE PER DEAL, and grouping by name here is what
 * keeps them so.
 *
 * Grouping WITHIN a variant is the same grouping as across all three, because a deal belongs to
 * exactly one variant — see VARIANTS.
 */
const linesCte = (variant: CommissionVariant): string => `
all_lines AS MATERIALIZED (
  SELECT tid, name, SUM(t4a) AS t4a
  FROM ${{ standard: 'std_lines', listing: 'lst_lines', precon: 'pre_lines' }[variant]} v
  WHERE name IS NOT NULL
  GROUP BY tid, name
)`;

/** The CTE chain each variant needs — only its own, since the others would compute nothing. */
const variantCte = (variant: CommissionVariant): string =>
  ({ standard: STANDARD_CTE, listing: LISTING_CTE, precon: PRECON_CTE })[variant]();

/**
 * ONE VARIANT'S paid / pending / upcoming figures.
 *
 * WHY THE QUERY IS SPLIT THREE WAYS. As a single statement this took 6,525 ms at 80,000 deals, and
 * the reason it could not be made faster is structural: every CTE in it is MATERIALIZED — it has to
 * be, because each is referenced more than once — and PostgreSQL evaluates a materialised CTE in the
 * leader process alone. No parallel workers, however many cores are idle.
 *
 * The variants partition the deals, so running them as three statements on three connections gives
 * the planner three independent plans it CAN parallelise, on three backends, over roughly a third of
 * the rows each. Wall-clock becomes the slowest branch rather than the sum of all three.
 *
 * The arithmetic is untouched, and adding the three subtotals is exact: each is a two-decimal
 * numeric and decimal addition is associative. desk-sql-parity.spec.ts compares the assembled
 * result against the original TypeScript, which is what proves the split changed nothing.
 *
 * paid → any payment row for that member says Paid · pending → not paid on a Closed deal ·
 * upcoming → not paid and not closed.
 */
export const commissionsSqlForOffice = (scope: string, variant: CommissionVariant): string => `
WITH ${scopedCte(scope, VARIANTS[variant])},
${REFS_CTE},
${MEMBERS_CTE},
${variantCte(variant)},
${linesCte(variant)},
classified AS MATERIALIZED (
  SELECT l.t4a, desk_member_paid(s.admin, l.name) AS paid, s.is_closed
  FROM all_lines l JOIN scoped s ON s.id = l.tid
)
SELECT
  COALESCE(SUM(t4a) FILTER (WHERE paid), 0)                       AS paid_total,
  COUNT(*) FILTER (WHERE paid)                                    AS paid_count,
  COALESCE(SUM(t4a) FILTER (WHERE NOT paid AND is_closed), 0)     AS pending_total,
  COUNT(*) FILTER (WHERE NOT paid AND is_closed)                  AS pending_count,
  COALESCE(SUM(t4a) FILTER (WHERE NOT paid AND NOT is_closed), 0) AS upcoming_total,
  COUNT(*) FILTER (WHERE NOT paid AND NOT is_closed)              AS upcoming_count
FROM classified
`;

/**
 * The same figures for an AGENT, whose Dashboard counts one line per visible deal — their own.
 *
 * The difference is not a filter on the office query and must not be written as one. The TypeScript
 * builds { [user.name]: t4aByName[user.name] ?? 0 }, so a deal the agent can see but is NOT a
 * member of still contributes a row: amount zero, classified by whether THEY have been paid on it.
 * Filtering all_lines to their name would drop those deals and change every count on the screen.
 *
 * A LEFT JOIN from the deals to their own line is that rule: every scoped deal of this variant,
 * their amount or zero. $1 is the agent's name.
 */
export const commissionsSqlForAgent = (scope: string, variant: CommissionVariant): string => `
WITH ${scopedCte(scope, VARIANTS[variant])},
${REFS_CTE},
${MEMBERS_CTE},
${variantCte(variant)},
${linesCte(variant)},
mine AS MATERIALIZED (
  SELECT COALESCE(l.t4a, 0) AS t4a, desk_member_paid(s.admin, $1) AS paid, s.is_closed
  FROM scoped s
  LEFT JOIN all_lines l ON l.tid = s.id AND l.name = $1
)
SELECT
  COALESCE(SUM(t4a) FILTER (WHERE paid), 0)                       AS paid_total,
  COUNT(*) FILTER (WHERE paid)                                    AS paid_count,
  COALESCE(SUM(t4a) FILTER (WHERE NOT paid AND is_closed), 0)     AS pending_total,
  COUNT(*) FILTER (WHERE NOT paid AND is_closed)                  AS pending_count,
  COALESCE(SUM(t4a) FILTER (WHERE NOT paid AND NOT is_closed), 0) AS upcoming_total,
  COUNT(*) FILTER (WHERE NOT paid AND NOT is_closed)              AS upcoming_count
FROM mine
`;

/**
 * The two figures that need no member resolution at all — the brokerage's gross commission and its
 * referral outgoings.
 *
 * Its own statement because it is cheap and touches every deal regardless of variant, so it runs
 * alongside the three variant queries rather than being computed three times and added.
 *
 * The referral totals are ROUNDED ONCE, AT THE END, not per deal. DashboardService accumulates the
 * raw amounts across every transaction and calls round2 on the total; rounding each deal first and
 * summing those is a different number, because two deals with a half-cent each are one cent together
 * and two cents apart. The sum is taken as numeric so it is exact and does not depend on the order
 * a parallel aggregate adds them in, then handed to php_round2 where the TypeScript rounds.
 */
export const commissionsSqlHeadline = (scope: string): string => `
WITH ${scopedCte(scope, 'TRUE')},
${REFS_CTE}
SELECT
  COALESCE((SELECT SUM(php_round2(desk_gross_commission(
      s.type, s.price, s.comm_type, s.comm_value, s.comm_pct, s.comm_amt,
      s.listing_comm_pct, s.coop_comm_pct, s.listing_comm_flat, s.coop_comm_flat,
      s.precon_comm_pct, s.precon_comm_amt_manual))) FROM scoped s), 0)       AS gross_total,
  php_round2(COALESCE((SELECT SUM(ext_ref::numeric)    FROM refs), 0)::float8) AS ext_ref_total,
  php_round2(COALESCE((SELECT SUM(client_ref::numeric) FROM refs), 0)::float8) AS client_ref_total
`;

/** One variant's bucket figures. numeric arrives as a string, bigint as a BigInt. */
export interface CommissionVariantRow {
  paid_total: string;
  paid_count: bigint;
  pending_total: string;
  pending_count: bigint;
  upcoming_total: string;
  upcoming_count: bigint;
}

/** The deal-level figures that need no members. */
export interface CommissionHeadlineRow {
  gross_total: string;
  ext_ref_total: string;
  client_ref_total: string;
}
