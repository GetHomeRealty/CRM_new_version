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
    t.precon_comm_bonus::float8         AS precon_comm_bonus,
    t.precon_net_of_hst,
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
      -- TD-163. 'is_closed' MEANS CLOSED AGAIN, AND 'HAS ENDED' IS ITS OWN FLAG BELOW.
      --
      -- TD-084 broadened this single predicate to every ending status so a dead deal would shed
      -- from the upcoming figures. It did - and landed in closed_pending instead, because one
      -- boolean drove both. The Dashboard then reported commission RECEIVABLE on a deal that will
      -- never pay: 6677, mutually released, sat in Pending for 15,750.00 of a 700,000 deal.
      --
      -- Ruled by the brokerage 2026-09-10: a DFT, mutually released, terminated or void deal earns
      -- nothing and belongs in NONE of paid, pending or upcoming. That is already how Reports
      -- behaves - paymentSection() tests is_mutual_release FIRST and gives it its own section - so
      -- this returns the Dashboard to a rule the product already had rather than inventing one.
      --
      -- DEAD WINS OVER CLOSED, matching that same paymentSection ordering: a deal carrying both is
      -- dead. Measured before choosing - 0 deals in this database carry both, so the alternative
      -- reading moves no figure today and consistency decided it.
      SELECT 1 FROM transaction_statuses st
      WHERE st.transaction_id = t.id AND st.status = 'Closed'
    )                                   AS is_closed,
    EXISTS (
      SELECT 1 FROM transaction_statuses st
      WHERE st.transaction_id = t.id
        AND st.status IN ('DFT', 'Mutual Release', 'Terminated', 'Void')
    )                                   AS is_dead
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
  /*
   * TD-158 - THE ENTITLEMENT IS RAW HERE NOW; THE FLOOR IS A DEAL-LEVEL FIGURE AND MOVED BELOW.
   *
   * What stood here capped each member with LEAST(own, lc - floor) - a MEMBER-sized entitlement
   * against a DEAL-sized cap. With one member on 100% those are the same size and the minimum was
   * enforced; with two the left halved and the right did not, so the cap could not bind and the
   * brokerage collected nothing extra: a 1,500.00 commission kept 200.00 with one agent and 150.00
   * with two or three, while the panel printed 200.00 in every case. The brokerage ruled 2026-09-09
   * that it is ONE fee per deal, shared.
   *
   * brok_share is carried out alongside it because the deal-level floor needs the SUM of the
   * members brokerage percentages, which cannot be seen from inside a single member row.
   *
   * NO BACKTICKS IN ANY COMMENT IN THIS FILE. These CTEs sit inside a TypeScript template literal
   * and a backtick terminates the string. It fails at build rather than at runtime, but it fails.
   */
  SELECT
    l.id, m.name, m.split,
    GREATEST(0::float8, l.lc * (m.agent_pct / 100) * (m.split / 100)) AS own,
    l.lc * (m.brok_pct / 100) * (m.split / 100)                       AS brok_share
  FROM std_lc l LEFT JOIN members m ON m.tid = l.id
),
std_deal AS MATERIALIZED (
  /*
   * ONE ROW PER DEAL: the raw pool, the brokerage's own percentage, and the adjustment relief.
   *
   * THE RELIEF IS EX-HST, which is the other half of TD-158 and the money half of TD-128.
   * adj_before * G - adj_after is a tax-INCLUSIVE figure and it was being subtracted from a floor
   * that is pre-HST - min_brokerage reads {200.00, 26.00, 226.00}, so 200.00 is the ex-HST number.
   * agentCommissionsAfterClient now computes adjBefore - adjAfter / g, once for the deal rather
   * than once per member, and this is that expression.
   */
  SELECT
    l.id, l.lc, l.client_ref,
    COALESCE(SUM(o.own), 0::float8)        AS gross,
    COALESCE(SUM(o.brok_share), 0::float8) AS brok_pct_sum,
    (l.adj_before - l.adj_after / ${G})    AS relief_ex
  FROM std_lc l LEFT JOIN std_own o ON o.id = l.id
  GROUP BY l.id, l.lc, l.client_ref, l.adj_before, l.adj_after
),
std_pool AS MATERIALIZED (
  /*
   * TD-158 - ONE FLOOR FOR THE DEAL, AND THE ENTITLEMENTS TRIMMED IN PROPORTION WHEN THEY EXCEED
   * THE ROOM ABOVE IT. This is agentCommissionsAfterClient line for line:
   *
   *   floor = lc = 0 ? 0 : max(brok_pct_sum, 200) - relief_ex
   *   room  = max(0, lc - floor)
   *   scale = gross > room ? (gross > 0 ? room / gross : 0) : 1
   *   pool  = gross > room ? room : gross
   *
   * THE OPERATION ORDER IS COPIED DELIBERATELY. (own * scale) / pool is algebraically own / gross,
   * and in binary floating point it is NOT the same double - desk-sql-parity.spec.ts compares with
   * no tolerance, so the multiply-then-divide is reproduced rather than simplified away.
   *
   * Prorating each member's floor separately would also be headcount-invariant and is the obvious
   * alternative, but it COLLECTS MORE THAN ONE MINIMUM on mixed plans - 237.30 rather than 226.00
   * on a 1,500.00 deal split 90/10 and 85/15 - and the ruling was one fee per deal, not one per
   * share. THE LISTING VARIANT ALREADY WORKS THIS WAY; the standard path simply never got it.
   */
  SELECT
    r.id,
    php_round2f((CASE WHEN r.gross > r.room THEN r.room ELSE r.gross END) * ${G} - r.client_ref) AS ac_total,
    -- The UNROUNDED pool, which is what the share is taken against on the TypeScript side.
    CASE WHEN r.gross > r.room THEN r.room ELSE r.gross END AS pool,
    CASE WHEN r.gross > r.room
         THEN (CASE WHEN r.gross > 0::float8 THEN r.room / r.gross ELSE 0::float8 END)
         ELSE 1::float8 END AS scale
  FROM (
    SELECT d.id, d.client_ref, d.gross,
           GREATEST(0::float8,
             d.lc - CASE WHEN d.lc = 0::float8 THEN 0::float8
                         ELSE GREATEST(d.brok_pct_sum, 200::float8) - d.relief_ex END) AS room
    FROM std_deal d
  ) r
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
         php_round2f(p.ac_total * CASE WHEN p.pool > 0 THEN (o.own * p.scale) / p.pool ELSE o.split / 100 END) AS t4a_raw${full ? `,
         php_round2f(p.ac_total * CASE WHEN p.pool > 0 THEN (o.own * p.scale) / p.pool ELSE o.split / 100 END - desk_member_deduction(s.adj, o.name, NULL)) AS total,
         -- TD-124: the remainder of the member's share, not a flat percentage that never
         -- consulted the minimum. The subtrahend is the share BEFORE any deduction — t4a_raw's own
         -- expression, repeated rather than named, because an output alias cannot be read inside
         -- the SELECT list that defines it. The total column above repeats it for the same reason.
         GREATEST(php_round2f((l.lc * o.split) / 100)
                  - php_round2(php_round2f(p.ac_total * CASE WHEN p.pool > 0 THEN (o.own * p.scale) / p.pool ELSE o.split / 100 END) / ${G}),
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
      WHEN COALESCE(SUM(o.raw), 0::float8) > GREATEST(x.split_total - x.min_brok * ${G}, 0::float8)
       AND COALESCE(SUM(o.raw), 0::float8) > 0::float8
      THEN GREATEST(x.split_total - x.min_brok * ${G}, 0::float8) / COALESCE(SUM(o.raw), 0::float8)
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
  /*
   * TD-163 - THIS COMPUTED THE TERM FEE FROM THE PERCENTAGE ALONE, AND IGNORED BOTH THE FIXED
   * AMOUNT AND NET OF HST. Two of the three divergences that had desk-sql-parity.spec.ts
   * failing, and the larger one.
   *
   * precon_terms.amt is TD-130's column, added 2026-09-07 for the case no percentage can
   * express: 7,500 of 859,900 is 0.8721944412...%, which Decimal(8,4) cannot hold. Such a term
   * stores amt with pct NULL - so COALESCE(pt.pct, 0) made it ZERO and the Dashboard paid the
   * agent nothing for the term. THIRTEEN of the eighteen term rows in this database are that
   * shape, 86,990.00 of fees the agent figures could not see.
   *
   * NET OF HST is the second half, and it is TD-024 in this file: a term must use the same HST
   * treatment as the master. breakdownPrecon divides the term gross by 1.13 when the deal is
   * tax-inclusive, and t_amt feeds every agent and brokerage line below, so without it every
   * one of them was 13% high on a net-of-HST deal.
   *
   * THE DIVISOR IS THE LITERAL 1.13, matching breakdownPrecon, NOT this file's (1 + 0.13)
   * gross-up constant. They are different doubles - see the header - and the TypeScript uses
   * the literal here.
   */
  SELECT id, k,
         CASE WHEN net THEN php_round2f(t_gross / 1.13::float8) ELSE t_gross END AS t_amt
  FROM (
    SELECT s.id, k, COALESCE(s.precon_net_of_hst, false) AS net,
           CASE WHEN pt.amt IS NOT NULL
                THEN php_round2f(pt.amt::float8)
                ELSE php_round2f((s.price * COALESCE(pt.pct::float8, 0)) / 100)
           END AS t_gross
    FROM scoped s
    CROSS JOIN LATERAL generate_series(1, GREATEST(COALESCE(s.precon_term_count, 0), 0)) k
    LEFT JOIN precon_terms pt ON pt.transaction_id = s.id AND pt.term_no = k
  ) x
),
pre_mem AS (
  /*
   * TD-163 - THE MEMBER SPLITS ARE REBASED TO THE TERM, WHICH THEY NEVER WERE.
   *
   * breakdownPrecon filters the members to those visible at term k and then calls rebaseToTerm on
   * what is left, scaling the survivors back up to 100. The filter was transliterated here and the
   * REBASE WAS NOT, so a term the others are not on paid out only what the remaining splits
   * happened to add up to, and the rest went NOWHERE - not to the agent, not to the brokerage. On
   * deal 82 (five terms; Aswini on all five, Sai Ramesh on the first two) terms 3 to 5 each had a
   * single member holding a 50 split, so the SQL paid half of each term and dropped the other
   * half: 6,750.00 on that deal alone. Last of the five divergences the parity spec reported.
   *
   * BOTH OF rebaseToTerm's GUARDS ARE COPIED AND BOTH MATTER. It leaves the splits alone when they
   * sum to zero - nothing to scale - and when they already sum to 100 within 1e-9. The second is
   * not an optimisation: (split * 100) / 100 is not the identity in binary floating point for
   * every split, so rescaling a set that already totals 100 can move the last bit, and
   * desk-sql-parity.spec.ts compares with no tolerance. The association is (split * 100) / sum,
   * as the TypeScript writes it, NOT split * (100 / sum).
   *
   * THE WINDOW IS ORDERED BY m.ord FOR THE SAME REASON. reduce() adds the splits in member order;
   * an unordered SUM() may add them in any order and float addition is not associative. The
   * ORDER BY is load-bearing - do not simplify it away.
   *
   * NOT MATERIALIZED, unlike its neighbours in this file, and deliberately: it is read exactly
   * once, by pre_raw, which is itself materialised. Blocking inlining would buy nothing but a
   * second tuplestore of the same cardinality and a wider tuple.
   */
  SELECT tid, k, t_amt, name, agent_pct,
         CASE WHEN vsum <= 0::float8 OR abs(vsum - 100::float8) < 1e-9::float8
              THEN split_raw
              ELSE (split_raw * 100::float8) / vsum
         END AS split
  FROM (
    SELECT t.id AS tid, t.k, t.t_amt, m.name, m.agent_pct, m.split AS split_raw,
           SUM(m.split) OVER (PARTITION BY t.id, t.k ORDER BY m.ord
                              ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS vsum
    FROM pre_terms t
    JOIN members m ON m.tid = t.id
    WHERE COALESCE(m.scope, 'Entire') = 'Entire'
       OR EXISTS (SELECT 1 FROM team_member_terms tt WHERE tt.team_member_id = m.mid AND tt.term_no = t.k)
  ) v
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
         php_round2f(php_round2f((m.t_amt * m.split) / 100) * m.agent_pct / 100) AS agent_wo${full ? `,
         -- TD-124: the remainder of this term's member share, as agentLines now takes it.
         -- TD-164 - THE OUTER ROUNDING agentLines() APPLIES AND THIS DID NOT.
         -- brokEffective is this.r(Math.max(memberWoHst - t4a.commission, 0)) - the SUBTRACTION is
         -- rounded. Two doubles that are each the nearest double to a two-decimal value do not
         -- subtract to the nearest double of the two-decimal difference, so this sat about 1e-13
         -- from the TypeScript. Below a cent almost always, but where the true remainder ends in
         -- .50 the residue decides which way php_round2 goes and a Reports brokerage column comes
         -- out a cent low - roughly one member-term row in 2,500. GREATEST stays INSIDE the round,
         -- mirroring this.r(Math.max(...)).
         php_round2f(GREATEST(php_round2f((m.t_amt * m.split) / 100)
                  - php_round2f(php_round2f((m.t_amt * m.split) / 100) * m.agent_pct / 100), 0::float8)) AS brok_wo,
         desk_member_deduction(s.adj, m.name, m.k)                               AS deduction` : ''}
  FROM pre_mem m${full ? `
  LEFT JOIN deductible s ON s.id = m.tid` : ''}
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
  -- TD-163: a dead deal contributes no line at all. See is_dead in scopedCte.
  WHERE NOT s.is_dead
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
  -- TD-163: a dead deal contributes no line at all, and for an agent that means it leaves their
  -- deal COUNT too - which is correct: it is not in their pipeline any more.
  WHERE NOT s.is_dead
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
  COALESCE((SELECT SUM(php_round2(desk_gross_amount(
      s.type, s.price, s.comm_type, s.comm_value, s.comm_pct, s.comm_amt,
      s.listing_comm_pct, s.coop_comm_pct, s.listing_comm_flat, s.coop_comm_flat,
      s.precon_comm_pct, s.precon_comm_amt_manual,
        s.precon_comm_bonus, s.precon_net_of_hst))) FROM scoped s), 0)       AS gross_total,
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
