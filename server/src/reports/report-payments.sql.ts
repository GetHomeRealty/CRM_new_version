/**
 * Transaction Payment Status, answered from the cached columns.
 *
 * WHAT IT REPLACES. The report classifies every deal through a five-rung ladder and groups the
 * result into four in-table sections, and every rung read something derived: the agent commission
 * total from the commission engine, the paid names from the `admin_activities` blob, the closed flag
 * from `transaction_statuses`. None of it was expressible in SQL, so the only way to serve a page
 * was to enrich the whole brokerage. Measured at 80,000 deals: 10.3 s -- and it exhausted Node's
 * default heap doing it, which is the more serious half of that sentence.
 *
 * The three derived inputs are now columns on `transactions`, maintained on write by
 * `PaymentCacheService` and checked row for row by `verify-payment-cache.cjs`. So the ladder becomes
 * a CASE, the sections become a CASE, and the filter becomes a WHERE.
 *
 * THE LADDER IS TRANSLITERATED FROM `agentPaymentStatus`, RUNG FOR RUNG AND IN ORDER. The order is
 * the whole logic: a recorded 'Yes' beats a zero commission, which beats a full count of paid names,
 * which beats a partial one. Reordering any two of them changes the answer for a real deal.
 *
 * NULL FALLS BACK. A row whose `calc_at` is NULL has never been computed, and no CASE over its
 * columns would mean anything -- so the caller excludes those rows from this path entirely and lets
 * the enrichment path answer the whole report. That is coarse on purpose: a report half-answered
 * from the cache and half from enrichment would need the two to agree about ordering and paging as
 * well as about values, and "there is at least one uncomputed row" is a condition that disappears
 * the moment the backfill finishes.
 */

/**
 * `agentPaymentStatus(tracker, statuses, paid, names, agentCommTotal)` as SQL.
 *
 *   faq === 'Yes'                        -> 'Paid'
 *   faq === 'N/A' | 'Not Applicable'     -> 'Not Applicable'
 *   agentCommTotal <= 0                  -> 'Not Applicable'
 *   names.length > 0 && paid >= names    -> 'Paid'
 *   paid > 0                             -> 'Partially Paid'
 *   statuses includes 'Closed'           -> 'Pending'
 *   else                                 -> 'Upcoming'
 *
 * The TypeScript compares `faq` with `===` against an unparsed JSON value, so a non-string never
 * matches; `calc_faq_paid_status` stores the value as text and NULL when it was absent, and neither
 * equals the two literals here. Same answer, without a coercion either side has to agree about.
 */
export const PAYMENT_STATUS_SQL = `CASE
  WHEN t.calc_faq_paid_status = 'Yes'                                   THEN 'Paid'
  WHEN t.calc_faq_paid_status IN ('N/A', 'Not Applicable')              THEN 'Not Applicable'
  WHEN COALESCE(t.calc_agent_comm_total, 0) <= 0                        THEN 'Not Applicable'
  WHEN COALESCE(t.calc_agent_name_count, 0) > 0
       AND COALESCE(t.calc_paid_name_count, 0) >= t.calc_agent_name_count THEN 'Paid'
  WHEN COALESCE(t.calc_paid_name_count, 0) > 0                          THEN 'Partially Paid'
  WHEN EXISTS (SELECT 1 FROM transaction_statuses st
               WHERE st.transaction_id = t.id AND st.status = 'Closed')  THEN 'Pending'
  ELSE 'Upcoming' END`;

/**
 * `paymentSection(t)` as SQL.
 *
 *   is_mutual_release -> 'mutual_release'
 *   !is_closed        -> 'yet_to_close'
 *   status === 'Paid' -> 'closed_paid' else 'closed_pending'
 *
 * `is_mutual_release` and `is_closed` are `statuses.includes(...)` on the enriched row, which is a
 * row of `transaction_statuses`. Mutual release is tested FIRST and wins over closed, so a deal
 * carrying both lands in `mutual_release` -- which is what the section list means by it.
 */
export const PAYMENT_SECTION_SQL = `CASE
  WHEN EXISTS (SELECT 1 FROM transaction_statuses st
               WHERE st.transaction_id = t.id AND st.status = 'Mutual Release') THEN 'mutual_release'
  WHEN NOT EXISTS (SELECT 1 FROM transaction_statuses st
                   WHERE st.transaction_id = t.id AND st.status = 'Closed')     THEN 'yet_to_close'
  WHEN (${PAYMENT_STATUS_SQL}) = 'Paid'                                         THEN 'closed_paid'
  ELSE 'closed_pending' END`;

/** The statuses the report's own filter may carry. Anything else is not expressible and declines. */
export const PAYMENT_STATUSES = ['Paid', 'Partially Paid', 'Pending', 'Upcoming', 'Not Applicable'];

/**
 * Is any candidate deal still uncomputed?
 *
 * One cheap existence check, served by the partial index the cache migration created. If it answers
 * true the caller takes the enrichment path for the whole report -- see the header for why it is all
 * or nothing.
 */
export const anyUncomputedSql = (): string => `
SELECT EXISTS (
  SELECT 1 FROM transactions t
  WHERE t.id = ANY($1::int[]) AND t.calc_at IS NULL
) AS stale
`;

/** Section counts over the complete filtered set — the four in-table headings and the footer. */
export const paymentCountsSql = (statusFilter: string): string => `
WITH rows AS MATERIALIZED (
  SELECT ${PAYMENT_SECTION_SQL} AS section, ${PAYMENT_STATUS_SQL} AS status
  FROM transactions t
  WHERE t.id = ANY($1::int[])
)
SELECT section, COUNT(*)::int AS n
FROM rows
WHERE ${statusFilter}
GROUP BY section
`;

/**
 * One page of transaction ids, in the order the report presents them.
 *
 * SECTION ORDER FIRST, then the report's own sort. `compute` lays a section report out as
 * `visibleSections.flatMap(rows of that section)`, so the section is the primary key whatever the
 * user sorted by -- and this report is `noSort`, so the sort is always its default: closing date
 * descending, then the stable secondary `ReportsService.sort` applies.
 *
 * `cmp` treats an absent value as "after", multiplied by the direction -- so a descending sort puts
 * nulls FIRST, which is what `DESC` already does in Postgres. See `report-conds.sql.ts` for the same
 * reasoning spelled out at length.
 */
export const paymentPageSql = (statusFilter: string): string => `
WITH rows AS MATERIALIZED (
  SELECT t.id, t.closing_date, t.trade_no,
         ${PAYMENT_SECTION_SQL} AS section, ${PAYMENT_STATUS_SQL} AS status
  FROM transactions t
  WHERE t.id = ANY($1::int[])
)
SELECT id, section
FROM rows
WHERE ${statusFilter} AND section = ANY($2::text[])
ORDER BY array_position($2::text[], section), closing_date DESC, trade_no ASC
OFFSET $3 LIMIT $4
`;

/**
 * The section a deal belongs to, or NULL when the status filter excludes it.
 *
 * WHY NULL RATHER THAN A WHERE. The grouped footer aggregates over the commission CTE chain, and the
 * status filter has to apply to it — a footer showing every deal under a report filtered to
 * 'Partially Paid' would not describe its own rows. Expressing the filter as "which section is this
 * row in, or none" keeps it to one expression evaluated in one place, instead of a predicate that
 * would have to be threaded into four separate aggregates and kept identical in all of them.
 *
 * `GROUP BY` puts the excluded rows in a NULL bucket, which the caller drops.
 */
export const paymentSectionFilteredSql = (statusFilter: string): string => `CASE
  WHEN (${statusFilter.replace(/\bstatus\b/g, `(${PAYMENT_STATUS_SQL})`)}) THEN (${PAYMENT_SECTION_SQL})
  ELSE NULL END`;

/** The WHERE fragment for the report's status filter, or null when the value is not one we know. */
export const paymentStatusFilter = (status: string | undefined): string | null => {
  const want = (status ?? '').trim();
  if (want === '') return 'TRUE';
  if (!PAYMENT_STATUSES.includes(want)) return null;
  // Safe to quote: `want` is one of the compiled values above, never caller text.
  return `status = '${want}'`;
};

