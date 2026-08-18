import {
  DEDUCTIBLE_CTE, G, HST, MEMBERS_CTE, PRECON_CTE, REFS_CTE, STANDARD_CTE, LISTING_CTE,
  VARIANTS, scopedCte, type CommissionVariant,
} from '../dashboard/desk-commission.sql';

/**
 * A report's footer totals, computed by the database.
 *
 * WHY. `ReportsService.compute` enriches every deal that matches the filters before it can show one
 * page, and the reason is the footer: the totals describe the COMPLETE filtered set, so a page
 * cannot be served until every matching row has a value. Measured at 80,000 deals, an unfiltered
 * commission report spent 8.9 s reading and hydrating rows and 4.4 s enriching them — to print
 * twenty-five lines and nine numbers.
 *
 * This computes those nine numbers where the data is. With the totals answered, the page itself is
 * an `ORDER BY … LIMIT 25`, and only those twenty-five rows are enriched.
 *
 * IT REUSES THE DASHBOARD'S CTEs RATHER THAN RESTATING THEM. `scopedCte`, `MEMBERS_CTE` and the
 * three variant chains are imported from `dashboard/desk-commission.sql`, so there is one SQL
 * transliteration of the commission engine and not two. The variant line CTEs already emit the agent
 * and brokerage triples this needs.
 *
 * SCOPE OF THE FAST PATH, and why it is narrow on purpose. `ReportsService.fastPath` will only use
 * this when the report emits one row per transaction, its predicate is fully expressed in SQL, its
 * sort key is a stored column, and every column it totals is one of the keys below. Anything else
 * takes the original path, unchanged. `report-totals.spec.ts` runs both and requires identical
 * output — a report that quietly qualified when it should not have would show a footer that does not
 * add up to its own rows.
 */

/**
 * The column keys this can total, and which field of the aggregate answers each.
 *
 * Two columns share one field on purpose: `closed_price` IS the transaction price — `baseRow` sets
 * `closed_price: num(t.price)` — so both total the same sum rather than the aggregate carrying it
 * twice. `report-needs.spec.ts` caught the first version of this, where `closed_price` had no
 * mapping and quietly totalled zero.
 *
 * `listing_price` here is the BASE row's meaning: the stored column, null when unset.
 * `deal-list-price-comparison` shows the closed price instead of a blank and declares
 * `sqlTotalOverrides` rather than changing that meaning for every other report.
 */
export const SQL_TOTAL_COLUMNS = {
  price: 'price',
  closed_price: 'price',
  listing_price: 'listing_price',
  gift_coupon_value: 'gift_coupon_value',
  total_wo: 'total_wo',
  total_hst: 'total_hst',
  total_w: 'total_w',
  agent_wo: 'agent_wo',
  agent_hst: 'agent_hst',
  agent_w: 'agent_w',
  brok_wo: 'brok_wo',
  brok_hst: 'brok_hst',
  brok_w: 'brok_w',
  // Sales Statement: what the agent has actually been paid, and the split of it. See PAY_CTE.
  agent_paid_w: 'agent_paid_w',
  agent_paid_wo: 'agent_paid_wo',
  agent_paid_hst: 'agent_paid_hst',
  /*
   * Transaction Payment Status. `adjustments` on the row is `sum([adjust.before, adjust.after])` —
   * the two stored columns, ungated by `comm_adjust_enabled`, which is what `bd.adjust` carries.
   *
   * Only the SECTION aggregate computes it; `reportTotalsSql` does not, because no report that uses
   * the grand total shows the column. `isSqlTotalColumn` is what gates entry to either path, so it
   * has to know the key — and `sqlTotals` would answer zero for it, which is why the payments fast
   * path uses `reportSectionTotalsSql` and never the grand total.
   */
  adjustments: 'adjustments',
} as const;

export type SqlTotalColumn = keyof typeof SQL_TOTAL_COLUMNS;

export const isSqlTotalColumn = (key: string): key is SqlTotalColumn =>
  Object.prototype.hasOwnProperty.call(SQL_TOTAL_COLUMNS, key);

/**
 * The transaction-level figures, per deal — the `total` triple, plus the two stored prices.
 *
 * `summarize()` rounds the gross, then takes 13% OF THE ROUNDED VALUE, then adds the two. Computing
 * the HST from the unrounded gross would be a cent out on a good fraction of deals, which is why the
 * rounding is spelled out at each step rather than folded together.
 */
const DEAL_CTE = `
deal AS MATERIALIZED (
  SELECT
    s.id,
    s.price,
    t.listing_price::float8    AS listing_price,
    t.gift_coupon_value::float8 AS gift_coupon_value,
    php_round2f(desk_gross_commission(
      s.type, s.price, s.comm_type, s.comm_value, s.comm_pct, s.comm_amt,
      s.listing_comm_pct, s.coop_comm_pct, s.listing_comm_flat, s.coop_comm_flat,
      s.precon_comm_pct, s.precon_comm_amt_manual)) AS amount
  FROM scoped s JOIN transactions t ON t.id = s.id
)`;

/**
 * The CTE chain, the line source, and the source of the AGENT NAME MULTISET for one variant.
 *
 * `lines` is one row per agent line, which is what the money columns are summed over.
 *
 * `names` is subtly different and the difference is load-bearing. `agentPaymentsPaid` iterates
 * `agentLines(bd).map(l => l.name)` — a LIST, not a set — and a preconstruction deal emits one line
 * per agent PER TERM, so an agent on a four-term deal has their payments counted four times. That is
 * what the reports show today. `pre_lines` groups those terms away, so the precon variant takes its
 * names from `pre_raw`, which still has one row per term.
 */
const variantChain = (variant: CommissionVariant): { cte: string; lines: string; names: string } => ({
  // `true` asks each chain for the agent and brokerage triples as well as T4A. The Dashboard asks
  // for T4A alone, and the difference is not cosmetic: computing the extra columns on the standard
  // branch — five eighths of the brokerage — cost it about six seconds at 80,000 deals.
  standard: { cte: STANDARD_CTE(true), lines: 'std_lines', names: 'std_raw' },
  listing: { cte: LISTING_CTE(true), lines: 'lst_lines', names: 'lst_raw' },
  precon: { cte: PRECON_CTE(true), lines: 'pre_lines', names: 'pre_raw' },
})[variant];

/**
 * What the agent has been PAID, and the two figures Sales Statement derives from it.
 *
 *   ratio          = agentComm.total > 0 ? agent_paid / agentComm.total : 0
 *   agent_paid_w   = agent_paid
 *   agent_paid_wo  = Math.round(agentComm.commission * ratio * 100) / 100
 *   agent_paid_hst = Math.round(agentComm.hst      * ratio * 100) / 100
 *
 * THE ARITHMETIC IS COPIED, INCLUDING WHERE IT IS SLOPPY. `Math.round` is half toward POSITIVE
 * infinity, not half away from zero — `Math.round(-2.5)` is -2 — so it is `floor(x + 0.5)` here and
 * not `php_round2`. The multiplication is in binary64 because that is what JavaScript does, and the
 * association is left to right for the same reason. The sums around it are `numeric`, because the
 * TypeScript adds them with decimal.js.
 *
 * A deal with no agent lines has no paid figure and no ratio: zero, which is what `ZERO_TRIPLE` and
 * `money(0)` produce.
 */
const PAY_CTE = (names: string, lines: string): string => `
/*
 * THE PAID FIGURE COMES FROM THE CACHED COLUMN, AND FROM THE BLOB ONLY WHERE THERE IS NO CACHE.
 *
 * transactions.calc_paid_total is agentPaymentsPaid(admin, names).totalPaid -- the same sum over the
 * same names, recomputed on every write by PaymentCacheService and checked row for row by
 * verify-payment-cache.cjs. So this reads a numeric column where it used to call desk_agent_paid
 * once per agent line, parsing the JSON blob each time.
 *
 * Measured over 80,000 deals: desk_agent_paid per row 903 ms, summing the column 163 ms.
 *
 * THE FALLBACK IS NOT DECORATION. A row whose calc_at is NULL has never been computed -- the
 * backfill has not reached it, or a write failed to refresh it -- and for those the blob is still
 * the only truth. They are parsed exactly as before, so the answer is right whatever state the cache
 * is in; the cache only decides how fast it is. With the backfill complete this CTE is empty.
 *
 * (No backticks in this comment: it lives inside a template literal.)
 */
fallback_paid AS MATERIALIZED (
  SELECT n.tid, round(SUM(desk_agent_paid(s.admin, n.name)), 2) AS paid
  FROM ${names} n JOIN scoped s ON s.id = n.tid
  WHERE s.calc_at IS NULL
  GROUP BY n.tid
),
agent_deal AS MATERIALIZED (
  SELECT tid,
         SUM(agent_wo::numeric)  AS a_wo,
         SUM(agent_hst::numeric) AS a_hst,
         SUM(agent_w::numeric)   AS a_tot
  FROM ${lines} GROUP BY tid
),
paid_deal AS MATERIALIZED (
  -- money(total): decimal.js ROUND_HALF_UP is half AWAY FROM ZERO, which is what round(numeric, 2)
  -- does. The cached column was rounded the same way when it was written, by the same \`money()\`.
  SELECT
    s.id AS tid,
    CASE WHEN s.calc_at IS NOT NULL THEN COALESCE(s.calc_paid_total, 0)
         ELSE COALESCE(f.paid, 0) END AS paid
  FROM scoped s
  LEFT JOIN fallback_paid f ON f.tid = s.id
),
pay_deal AS MATERIALIZED (
  SELECT
    s.id,
    COALESCE(p.paid, 0)  AS paid,
    COALESCE(a.a_wo, 0)  AS a_wo,
    COALESCE(a.a_hst, 0) AS a_hst,
    CASE WHEN COALESCE(a.a_tot, 0) > 0
         THEN COALESCE(p.paid, 0)::float8 / a.a_tot::float8
         ELSE 0::float8 END AS ratio
  FROM scoped s
  LEFT JOIN paid_deal p  ON p.tid = s.id
  LEFT JOIN agent_deal a ON a.tid = s.id
),
pay_totals AS MATERIALIZED (
  SELECT
    COALESCE(SUM(paid), 0) AS agent_paid_w,
    COALESCE(SUM((floor(((a_wo::float8)  * ratio) * 100 + 0.5::float8) / 100::float8)::numeric), 0) AS agent_paid_wo,
    COALESCE(SUM((floor(((a_hst::float8) * ratio) * 100 + 0.5::float8) / 100::float8)::numeric), 0) AS agent_paid_hst
  FROM pay_deal
)`;

/**
 * One variant's contribution to a report footer.
 *
 * `$1` is the id list — the deals the report's predicate matched, resolved by Prisma so the
 * ownership rule and the report filters keep their single definition. Passing them as an array
 * rather than interpolating an `IN` list keeps the statement one line of SQL whatever the brokerage
 * size; at 80,000 ids the interpolated form is half a megabyte of query text to parse.
 *
 * The three variants partition the deals, so the caller runs all three and adds. Every value is a
 * two-decimal `numeric` by then, and decimal addition is associative, so the order cannot move a
 * cent — the same property the Dashboard's split relies on.
 *
 * The agent and brokerage figures are sums over the deal's LINES; the price and total figures are
 * per deal and must not be multiplied by the number of members, which is why they are aggregated
 * separately and joined rather than summed alongside.
 */
export const reportTotalsSql = (variant: CommissionVariant): string => {
  const { cte, lines, names } = variantChain(variant);
  return `
WITH ${scopedCte('t.id = ANY($1::int[])', VARIANTS[variant], 'stale')},
${REFS_CTE},
${DEDUCTIBLE_CTE},
${MEMBERS_CTE},
${cte},
${PAY_CTE(names, lines)},
${DEAL_CTE},
line_totals AS MATERIALIZED (
  SELECT
    COALESCE(SUM(agent_wo), 0)  AS agent_wo,
    COALESCE(SUM(agent_hst), 0) AS agent_hst,
    COALESCE(SUM(agent_w), 0)   AS agent_w,
    COALESCE(SUM(brok_wo), 0)   AS brok_wo,
    COALESCE(SUM(brok_hst), 0)  AS brok_hst,
    COALESCE(SUM(brok_w), 0)    AS brok_w
  FROM ${lines}
),
deal_totals AS MATERIALIZED (
  SELECT
    COUNT(*)                                                     AS count,
    COALESCE(SUM(php_round2(price)), 0)                          AS price,
    COALESCE(SUM(php_round2(listing_price)), 0)                  AS listing_price,
    COALESCE(SUM(php_round2(COALESCE(listing_price, price))), 0) AS listing_price_or_closed,
    COALESCE(SUM(php_round2(gift_coupon_value)), 0)              AS gift_coupon_value,
    COALESCE(SUM(php_round2(amount)), 0)                         AS total_wo,
    COALESCE(SUM(php_round2(amount * ${HST})), 0)                AS total_hst,
    COALESCE(SUM(php_round2(amount + php_round2f(amount * ${HST}))), 0) AS total_w
  FROM deal
)
SELECT d.*, l.agent_wo, l.agent_hst, l.agent_w, l.brok_wo, l.brok_hst, l.brok_w,
       y.agent_paid_w, y.agent_paid_wo, y.agent_paid_hst
FROM deal_totals d CROSS JOIN line_totals l CROSS JOIN pay_totals y
`;
};

/**
 * The same footer, but one row PER SECTION, in a single pass.
 *
 * WHY THIS EXISTS. Transaction Payment Status groups its rows into four in-table sections and each
 * section carries its own money footer over the COMPLETE filtered set — not over the page. That is
 * the one thing `reportTotalsSql` cannot do: it returns a grand total, so the report fell back to
 * enriching all 80,000 deals to add up four subtotals. Measured: 10.5 s, and it exhausted Node's
 * default heap doing it, which is the more serious half.
 *
 * ONE GROUPED AGGREGATION, NOT FOUR QUERIES. Running `reportTotalsSql` once per section would mean
 * four passes over the same CTE chain — four times the work to answer a cheaper question. The
 * section is computed once per deal in `sect` and every aggregate below groups by it, so the whole
 * footer costs what one grand total costs.
 *
 * `sectionSql` IS EVALUATED AGAINST `transactions t`, joined back to `scoped`. It has to be: the
 * payment section reads the cached columns and the status rows, which `scoped` does not carry. The
 * join also restricts `sect` to THIS VARIANT's deals, so a section with no deals in this variant
 * simply has no row here and contributes nothing when the three variants are added.
 *
 * ADJUSTMENTS IS THE ONE FIGURE NOT ALREADY IN THE GRAND TOTAL. It is
 * `sum([num(adjust.before), num(adjust.after)])` per deal — the two stored columns, ungated by
 * `comm_adjust_enabled`, which is what `bd.adjust` carries and therefore what the report shows.
 */
export const reportSectionTotalsSql = (variant: CommissionVariant, sectionSql: string): string => {
  const { cte, lines, names } = variantChain(variant);
  return `
WITH ${scopedCte('t.id = ANY($1::int[])', VARIANTS[variant], 'stale')},
${REFS_CTE},
${DEDUCTIBLE_CTE},
${MEMBERS_CTE},
${cte},
${PAY_CTE(names, lines)},
${DEAL_CTE},
sect AS MATERIALIZED (
  SELECT s.id, ${sectionSql} AS section
  FROM scoped s JOIN transactions t ON t.id = s.id
),
line_totals AS MATERIALIZED (
  SELECT
    k.section,
    COALESCE(SUM(agent_wo), 0)  AS agent_wo,
    COALESCE(SUM(agent_hst), 0) AS agent_hst,
    COALESCE(SUM(agent_w), 0)   AS agent_w,
    COALESCE(SUM(brok_wo), 0)   AS brok_wo,
    COALESCE(SUM(brok_hst), 0)  AS brok_hst,
    COALESCE(SUM(brok_w), 0)    AS brok_w
  FROM ${lines} l JOIN sect k ON k.id = l.tid
  GROUP BY k.section
),
deal_totals AS MATERIALIZED (
  SELECT
    k.section,
    COUNT(*)                                                     AS count,
    COALESCE(SUM(php_round2(price)), 0)                          AS price,
    COALESCE(SUM(php_round2(listing_price)), 0)                  AS listing_price,
    COALESCE(SUM(php_round2(COALESCE(listing_price, price))), 0) AS listing_price_or_closed,
    COALESCE(SUM(php_round2(gift_coupon_value)), 0)              AS gift_coupon_value,
    COALESCE(SUM(php_round2(amount)), 0)                         AS total_wo,
    COALESCE(SUM(php_round2(amount * ${HST})), 0)                AS total_hst,
    COALESCE(SUM(php_round2(amount + php_round2f(amount * ${HST}))), 0) AS total_w
  FROM deal d JOIN sect k ON k.id = d.id
  GROUP BY k.section
),
pay_sect AS MATERIALIZED (
  SELECT
    k.section,
    COALESCE(SUM(paid), 0) AS agent_paid_w,
    COALESCE(SUM((floor(((a_wo::float8)  * ratio) * 100 + 0.5::float8) / 100::float8)::numeric), 0) AS agent_paid_wo,
    COALESCE(SUM((floor(((a_hst::float8) * ratio) * 100 + 0.5::float8) / 100::float8)::numeric), 0) AS agent_paid_hst
  FROM pay_deal p JOIN sect k ON k.id = p.id
  GROUP BY k.section
),
adj_totals AS MATERIALIZED (
  SELECT
    k.section,
    COALESCE(SUM(php_round2(COALESCE(s.comm_adjust_before, 0) + COALESCE(s.comm_adjust_after, 0))), 0) AS adjustments
  FROM scoped s JOIN sect k ON k.id = s.id
  GROUP BY k.section
)
SELECT
  k.section,
  COALESCE(d.count, 0)                   AS count,
  COALESCE(d.price, 0)                   AS price,
  COALESCE(d.listing_price, 0)           AS listing_price,
  COALESCE(d.listing_price_or_closed, 0) AS listing_price_or_closed,
  COALESCE(d.gift_coupon_value, 0)       AS gift_coupon_value,
  COALESCE(d.total_wo, 0)                AS total_wo,
  COALESCE(d.total_hst, 0)               AS total_hst,
  COALESCE(d.total_w, 0)                 AS total_w,
  COALESCE(l.agent_wo, 0)                AS agent_wo,
  COALESCE(l.agent_hst, 0)               AS agent_hst,
  COALESCE(l.agent_w, 0)                 AS agent_w,
  COALESCE(l.brok_wo, 0)                 AS brok_wo,
  COALESCE(l.brok_hst, 0)                AS brok_hst,
  COALESCE(l.brok_w, 0)                  AS brok_w,
  COALESCE(y.agent_paid_w, 0)            AS agent_paid_w,
  COALESCE(y.agent_paid_wo, 0)           AS agent_paid_wo,
  COALESCE(y.agent_paid_hst, 0)          AS agent_paid_hst,
  COALESCE(a.adjustments, 0)             AS adjustments
FROM (SELECT DISTINCT section FROM sect) k
LEFT JOIN deal_totals d ON d.section = k.section
LEFT JOIN line_totals l ON l.section = k.section
LEFT JOIN pay_sect    y ON y.section = k.section
LEFT JOIN adj_totals  a ON a.section = k.section
`;
};

/**
 * A section's footer contribution from one variant.
 *
 * LEFT JOINed from the section list rather than inner joined, because the four aggregates do not
 * cover the same deals: a deal with no members contributes to `deal_totals` and to nothing else, and
 * an inner join would have dropped its price out of its section's footer.
 */
export interface ReportSectionTotalsRow extends ReportTotalsRow {
  section: string;
  adjustments: string;
}

/** One variant's footer contribution. `numeric` arrives as a string, `bigint` as a BigInt. */
export interface ReportTotalsRow {
  count: bigint;
  price: string;
  listing_price: string;
  listing_price_or_closed: string;
  gift_coupon_value: string;
  total_wo: string;
  total_hst: string;
  total_w: string;
  agent_wo: string;
  agent_hst: string;
  agent_w: string;
  brok_wo: string;
  brok_hst: string;
  brok_w: string;
  agent_paid_w: string;
  agent_paid_wo: string;
  agent_paid_hst: string;
}

/** Every numeric field on the row, so the three variants can be added generically. */
export const TOTALS_FIELDS: (keyof ReportTotalsRow)[] = [
  'price', 'listing_price', 'listing_price_or_closed', 'gift_coupon_value',
  'total_wo', 'total_hst', 'total_w',
  'agent_wo', 'agent_hst', 'agent_w', 'brok_wo', 'brok_hst', 'brok_w',
  'agent_paid_w', 'agent_paid_wo', 'agent_paid_hst',
];

void G;
