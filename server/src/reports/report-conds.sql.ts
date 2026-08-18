/**
 * Per-condition rows for the Conditional Offers and Expiry report, computed by the database.
 *
 * WHY THIS IS ITS OWN FILE AND NOT A ROW SOURCE IN `report-docs.sql.ts`. That module's row CTE
 * selects `FROM documents` and identifies a row by `documents.id`, which the report's `expand` puts
 * on every row as `doc_id`. Conditional Offers is the same SHAPE — one child row per result, paged
 * and counted in SQL, built by `def.expand` from an enriched deal — and shares none of that
 * substance: its children are `conditions`, its rows carry no id at all, and a deal with no
 * conditions still produces one row. Bending the document CTE around those three differences would
 * have produced a builder whose every clause had two meanings.
 *
 * WHAT IT REPLACES. The report enriched every conditional deal in the brokerage, with its documents
 * AND its conditions, to show twenty-five rows. Measured at 80,000 deals: 8.2 s.
 *
 * WHAT STAYS IN TYPESCRIPT. Everything a row SAYS. `waiver_status`, `amendment_status`,
 * `remaining_time` and the transaction status list are all computed by `def.expand` from the deals
 * on the page, exactly as before — this file decides only WHICH conditions are on the page, in what
 * order, and how many there are in total.
 *
 * Guarded by `report-conds-rows.spec.ts`, which runs the report both ways and requires identical
 * rows, totals and paging.
 */

/**
 * `expiryStatus(cond, today)` as SQL — an explicitly recorded outcome always beats the date.
 *
 * TODAY IS A PARAMETER, NOT `current_date`, AND THAT IS A CORRECTNESS DECISION. The TypeScript
 * derives it as `new Date().toISOString().slice(0, 10)`, which is the UTC date. `current_date` is
 * the date in the SESSION's timezone, and this application runs with `TZ=America/Toronto` — so for
 * the five hours after Toronto midnight the two disagree, and every condition whose deadline is
 * today or tomorrow would be reported differently by the two paths. A report that changes its
 * answer depending on the hour it is run is worse than a slow one.
 *
 * `daysUntil` rounds a millisecond difference between two UTC midnights, which for two dates is
 * exact whole days; subtracting two `date` values in Postgres is the same integer.
 */
export const expiryStatusSql = (today: string): string => `CASE
  WHEN lower(btrim(c.status)) IN ('fulfilled', 'completed', 'satisfied') THEN 'Fulfilled'
  WHEN lower(btrim(c.status)) = 'waived'   THEN 'Waived'
  WHEN lower(btrim(c.status)) = 'extended' THEN 'Extended'
  WHEN c.deadline IS NULL                  THEN 'Active'
  WHEN (c.deadline - ${today}::date) < 0   THEN 'Expired'
  WHEN (c.deadline - ${today}::date) <= 3  THEN 'Expiring Soon'
  ELSE 'Active' END`;

/** The expiry values the filter may carry. Anything else is not expressible and declines. */
export const EXPIRY_VALUES = ['Active', 'Expiring Soon', 'Expired', 'Fulfilled', 'Waived', 'Extended'];

/**
 * Every row this report can show, for the candidate deals.
 *
 * TWO SOURCES, UNIONED, because `expand` has two branches:
 *
 *   · one row per condition, in `t.conditions` order
 *   · ONE row for a deal that has no conditions at all — the "—" line, which `expand` gives
 *     `expiry_status: 'Active'` outright. It is a real row of the report and has to be counted,
 *     ordered and paged like any other, so it is materialised here rather than special-cased later.
 *
 * `ord` is the row's index within its deal, and it is how a page row is matched back to the object
 * `expand` builds. The report puts no id on its rows — there is nothing to match on — so position
 * within the deal is the identity. `t.conditions` is loaded `ORDER BY position ASC`, so that is the
 * ordering here, with `id` breaking the ties Prisma leaves undefined.
 *
 * `$1` is the id list Prisma produced from the ownership rule and the global filters. Today is
 * inlined by the caller rather than bound, so the only bound values are the ids and the page window
 * -- Postgres requires the placeholders to be contiguous, and a gap left by a removed parameter is
 * reported as a count mismatch rather than as the missing $2 it actually is.
 */
const condRowsCte = (today: string, qualifySql: string): string => `
cond_rows AS MATERIALIZED (
  SELECT
    c.transaction_id AS tid,
    c.deadline,
    ${expiryStatusSql(today)} AS expiry_status,
    (ROW_NUMBER() OVER (PARTITION BY c.transaction_id ORDER BY c.position, c.id) - 1)::int AS ord
  FROM conditions c
  WHERE c.transaction_id = ANY($1::int[])

  UNION ALL

  SELECT
    t.id AS tid,
    NULL::date AS deadline,
    'Active'::text AS expiry_status,
    0 AS ord
  FROM unnest($1::int[]) AS t(id)
  WHERE NOT EXISTS (SELECT 1 FROM conditions c WHERE c.transaction_id = t.id)
),
/*
 * THE FILTER QUALIFIES DEALS, NOT ROWS -- the same rule Amendment Documentation follows, and the
 * same trap. The predicate asks whether SOME condition of the deal has the wanted expiry status,
 * and expand() then emits EVERY condition of that deal, so asking for Expired shows that deal's
 * Active conditions too. Filtering the rows would drop them and produce a shorter report that
 * looks right. (No backticks in here: this comment lives inside a template literal.)
 */
qual AS MATERIALIZED (
  SELECT DISTINCT tid FROM cond_rows r WHERE ${qualifySql}
)`;

/** The deal-level condition for a status filter, or `null` when the value is not one we know. */
export const condQualify = (status: string | undefined): string | null => {
  const want = (status ?? '').trim();
  if (want === '') return 'TRUE';
  if (!EXPIRY_VALUES.includes(want)) return null;
  // Quoting is safe: `want` is one of the compiled values above, never caller text.
  return `EXISTS (SELECT 1 FROM cond_rows x WHERE x.tid = r.tid AND x.expiry_status = '${want}')`;
};

/** How many rows the report has in total, over the complete filtered set. */
export const condRowCountsSql = (today: string, qualifySql: string): string => `
WITH ${condRowsCte(today, qualifySql)}
SELECT COUNT(*)::int AS n
FROM cond_rows r
JOIN qual q ON q.tid = r.tid
`;

/**
 * One page, in the order the report presents it.
 *
 * `ReportsService.sort` transliterated for this report's default: condition expiry ascending, then
 * closing date descending regardless, then trade number, then the row's own position in its deal.
 *
 * Null placement is left to the SQL defaults deliberately — `cmp` sorts an absent value last in an
 * ascending sort, which is what `ASC` already does, and the "—" row for a condition-less deal
 * carries a NULL deadline precisely so it lands there.
 */
export const condRowPageSql = (today: string, qualifySql: string): string => `
WITH ${condRowsCte(today, qualifySql)}
SELECT r.tid, r.ord
FROM cond_rows r
JOIN qual q ON q.tid = r.tid
JOIN transactions t ON t.id = r.tid
ORDER BY r.deadline ASC, t.closing_date DESC, t.trade_no ASC, r.ord
OFFSET $2 LIMIT $3
`;
