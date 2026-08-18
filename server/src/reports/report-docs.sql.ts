/**
 * Per-deal document counts, computed by the database.
 *
 * WHY. The three heavy Documentation reports have to know how many pending, invalid, valid and
 * missing-mandatory documents each deal holds — to filter on it, to sort on it, and to print it in
 * the footer. The only way to know that was to LOAD EVERY DOCUMENT: at 80,000 deals and 800,000
 * documents, hydrating that relation through Prisma cost 12 seconds on top of the 9 the deals
 * themselves cost, for a page of twenty-five lines.
 *
 * The same counts as one grouped scan of `documents`: 797 ms.
 *
 * WHAT IS TRANSLITERATED HERE, AND WHAT IS NOT. Only `docStatus` and `docCounts` from
 * report-documents.ts — a three-way CASE on `validation` and six counters over it. Everything else a
 * documentation report shows (the category rules, the waiver and amendment grouping, the condition
 * expiry ladder) stays in TypeScript and is computed for the twenty-five deals on the page, exactly
 * as before. This file is deliberately the smallest thing that lets the OTHER 79,012 deals stay
 * unread.
 *
 * Guarded by `report-needs.spec.ts`, which runs every report through this path and through the
 * original enrichment and requires identical rows, totals and counts.
 */

import type { ReportFilters } from './report.types';

/**
 * `docStatus(d)` as SQL — Invalid beats Valid beats everything else.
 *
 * `lower(btrim(...))` is `String(d.validation ?? '').trim().toLowerCase()`, including the NULL case:
 * `btrim(NULL)` is NULL, no branch matches, and the ELSE gives 'Pending' — which is what the
 * TypeScript does with an absent validation.
 */
const DOC_STATUS_SQL = `CASE lower(btrim(d.validation))
  WHEN 'invalid' THEN 'Invalid'
  WHEN 'valid'   THEN 'Valid'
  ELSE 'Pending' END`;

/**
 * One row per transaction that HAS documents, with the six counts `docCounts` produces.
 *
 * A deal with no documents has no row here at all and is LEFT JOINed to zeros below, which is the
 * same `{ total: 0, pending: 0, … }` an empty array produces.
 */
const COUNTS_CTE = `
doc_counts AS MATERIALIZED (
  SELECT
    d.transaction_id AS tid,
    COUNT(*)                                                        AS total,
    COUNT(*) FILTER (WHERE ${DOC_STATUS_SQL} = 'Pending')           AS pending,
    COUNT(*) FILTER (WHERE ${DOC_STATUS_SQL} = 'Invalid')           AS invalid,
    COUNT(*) FILTER (WHERE ${DOC_STATUS_SQL} = 'Valid')             AS valid,
    COUNT(*) FILTER (WHERE d.mandatory)                             AS mandatory,
    COUNT(*) FILTER (WHERE d.mandatory AND ${DOC_STATUS_SQL} <> 'Valid') AS missing_mandatory,
    -- last_doc_update is max(reviewed_at) over the deal's documents, and reviewed_at is
    -- dateStr(updated_at) — the DAY, compared as a string. Taking max() of the date is the same
    -- answer as max() of the timestamps reduced to dates, because the reduction is monotonic.
    MAX(d.updated_at::date)                                         AS last_doc_update
  FROM documents d
  WHERE d.deleted_at IS NULL AND d.transaction_id = ANY($1::int[])
  GROUP BY d.transaction_id
)`;

/**
 * The candidate deals with their counts — zeros where a deal has no documents.
 *
 * `$1` is the id list the report's own filters and the ownership rule already produced through
 * Prisma. The rule is not restated here: this narrows an id set somebody else authorised.
 */
const CANDIDATE_CTE = `
cand AS MATERIALIZED (
  SELECT
    t.id, t.trade_no, t.property, t.type, t.agent, t.closing_date, t.offer_date,
    t.created_at, t.updated_at, t.price, t.listing_price,
    COALESCE(t.reco_audit_ready, '')                        AS reco_flag,
    COALESCE(c.total, 0)::int             AS total_docs,
    COALESCE(c.pending, 0)::int           AS pending_docs,
    COALESCE(c.invalid, 0)::int           AS invalid_docs,
    COALESCE(c.valid, 0)::int             AS valid_docs,
    COALESCE(c.mandatory, 0)::int         AS mandatory_docs,
    COALESCE(c.missing_mandatory, 0)::int AS missing_mandatory,
    c.last_doc_update
  FROM transactions t
  LEFT JOIN doc_counts c ON c.tid = t.id
  WHERE t.id = ANY($1::int[])
)`;

/** `documentationStatus(counts)` as SQL, for the reports that filter or sort on it. */
export const DOCUMENTATION_STATUS_SQL = `CASE
  WHEN total_docs = 0   THEN 'No Documents'
  WHEN invalid_docs > 0 THEN 'Invalid Documentation'
  WHEN pending_docs > 0 THEN 'Pending Documentation'
  ELSE 'Complete' END`;

/**
 * `recoReady(t)` as SQL — the stored flag AND a clean documentation state.
 *
 * The flag is normalised exactly as `ReportDataService.yesNo` normalises it: true, 1, 'yes', 'y',
 * '1' and 'true', case-insensitively and ignoring surrounding space. Anything else is 'No'. The
 * boolean column arrives as 'true'/'false' text through this comparison, which is why 'true' is in
 * the list.
 */
export const RECO_READY_SQL = `CASE
  WHEN lower(btrim(reco_flag)) IN ('yes', 'y', '1', 'true')
   AND invalid_docs = 0 AND missing_mandatory = 0
  THEN 'Yes' ELSE 'No' END`;

/** The count columns a documentation report may total, and the expression that answers each. */
export const DOC_TOTAL_COLUMNS: Record<string, string> = {
  pending_docs: 'pending_docs',
  invalid_docs: 'invalid_docs',
  valid_docs: 'valid_docs',
  total_docs: 'total_docs',
  missing_mandatory: 'missing_mandatory',
};

/**
 * The sort keys this path can order by.
 *
 * Deliberately short. A key that is not here sends the report down the original enrichment path
 * rather than being approximated — the same rule the commission fast path follows, and for the same
 * reason: a page in the wrong order is a wrong answer, not a slow one.
 */
export const DOC_SORT_COLUMNS: Record<string, string> = {
  txn_id: 'id',
  trade_no: 'trade_no',
  property: 'property',
  type: 'type',
  agent: 'agent',
  price: 'price',
  listing_price: 'listing_price',
  closing_date: 'closing_date',
  offer_date: 'offer_date',
  created_at: 'created_at',
  updated_at: 'updated_at',
  pending_docs: 'pending_docs',
  invalid_docs: 'invalid_docs',
  valid_docs: 'valid_docs',
  total_docs: 'total_docs',
  missing_mandatory: 'missing_mandatory',
  last_doc_update: 'last_doc_update',
  documentation_status: DOCUMENTATION_STATUS_SQL,
  reco_audit_ready: RECO_READY_SQL,
};

/**
 * The report predicates, as SQL over the candidate view.
 *
 * EXACT, not a superset — these decide `total_count` and the footer, so a generous clause would
 * print a count that does not match the rows. `null` means "this filter combination cannot be
 * expressed", and the caller falls back to the enrichment path.
 */
export const DOC_PREDICATES: Record<string, (f: ReportFilters) => string | null> = {
  /*
   * if (total === 0) return false
   * if (!status)     return pending > 0 || invalid > 0
   * if (status === 'Pending Documentation') return pending > 0
   * if (status === 'Invalid Documentation') return invalid > 0
   * return documentationStatus(counts) === status
   *
   * The `total > 0` guard is kept on every branch because the original applies it first — which is
   * what makes a 'No Documents' filter return nothing rather than every empty deal.
   */
  'deal-documentation-status': (f) => {
    const status = (f.status ?? '').trim();
    if (status === '') return 'total_docs > 0 AND (pending_docs > 0 OR invalid_docs > 0)';
    if (status === 'Pending Documentation') return 'total_docs > 0 AND pending_docs > 0';
    if (status === 'Invalid Documentation') return 'total_docs > 0 AND invalid_docs > 0';
    if (status === 'Complete') return 'total_docs > 0 AND invalid_docs = 0 AND pending_docs = 0';
    if (status === 'No Documents') return 'FALSE';
    return null;
  },

  /* !f.reco_ready || recoReady(t) === f.reco_ready */
  'reco-audit-readiness': (f) => {
    const want = ((f as Record<string, unknown>).reco_ready as string | undefined ?? '').trim();
    if (want === '') return 'TRUE';
    if (want === 'Yes') return `(${RECO_READY_SQL}) = 'Yes'`;
    if (want === 'No') return `(${RECO_READY_SQL}) = 'No'`;
    return null;
  },
};

/** The footer and the row count, over the whole filtered set. */
export const docTotalsSql = (predicate: string): string => `
WITH ${COUNTS_CTE},
${CANDIDATE_CTE}
SELECT
  COUNT(*)::int                     AS count,
  COALESCE(SUM(pending_docs), 0)::int     AS pending_docs,
  COALESCE(SUM(invalid_docs), 0)::int     AS invalid_docs,
  COALESCE(SUM(valid_docs), 0)::int       AS valid_docs,
  COALESCE(SUM(total_docs), 0)::int       AS total_docs,
  COALESCE(SUM(missing_mandatory), 0)::int AS missing_mandatory
FROM cand
WHERE ${predicate}
`;

/**
 * The ids on one page, in the report's order.
 *
 * THE TIEBREAK IS COPIED FROM `ReportsService.sort`, not invented: most recent closing date, then
 * trade number. A count column ties constantly — thousands of deals have two pending documents —
 * so without the same tiebreak this page would be a different twenty-five from the one the
 * enrichment path produces, and page two would overlap page one.
 *
 * NULLS ARE ALSO COPIED. `cmp` returns "nulls last" and the direction multiplier is applied to its
 * result, so a null sorts LAST ascending and FIRST descending — which is exactly PostgreSQL's
 * default for each direction. Stating NULLS LAST here would have introduced the difference rather
 * than removed it.
 */
export const docPageSql = (predicate: string, orderExpr: string, dir: 'asc' | 'desc'): string => `
WITH ${COUNTS_CTE},
${CANDIDATE_CTE}
SELECT id
FROM cand
WHERE ${predicate}
ORDER BY (${orderExpr}) ${dir === 'asc' ? 'ASC' : 'DESC'}, closing_date DESC, trade_no ASC
OFFSET $2 LIMIT $3
`;

/** One row of `docTotalsSql`. Every column is cast to `int`, so these arrive as numbers. */
export interface DocTotalsRow {
  count: number;
  pending_docs: number;
  invalid_docs: number;
  valid_docs: number;
  total_docs: number;
  missing_mandatory: number;
}

// ---------------------------------------------------------------------------------------------
// The DOCUMENT-ROW report: Pending and Invalid Documents, one row per document.
// ---------------------------------------------------------------------------------------------

/**
 * The report types the document-row path answers.
 *
 * A set rather than a literal comparison so `report-docs-rows.spec.ts` can take the path away and
 * run the same report through the original enrichment — which is how the two are compared.
 */
/**
 * The reports whose ROWS ARE DOCUMENTS rather than deals, and how each one selects them.
 *
 * WHY A DESCRIPTOR AND NOT A SET. This was `new Set(['pending-invalid-documents'])` with the row
 * predicate, the section split and the ordering all hard-coded into the two builders below — which
 * was right while one report used them. Two more have the same shape: Amendment Documentation emits
 * one row per amendment document, and both it and Pending/Invalid were paying the same price for it.
 * Amendment measured 51 s at 80,000 deals, because answering it meant enriching every deal in the
 * brokerage and building 56,000 rows in memory to show twenty-five.
 *
 * So the parts that differ per report move into this table and the builders take them as arguments.
 * No new path: `runFastDocRows` still decides the page and the counts in SQL, and `def.expand` still
 * builds every row from an enriched deal, exactly as before.
 *
 * EVERY FIELD IS A CORRECTNESS STATEMENT, not a tuning knob:
 *
 *   rowWhere   which documents become rows at all
 *   sectionSql the section a row belongs to, or the literal `'all'` for a report with no sections
 *   qualify    a DEAL-level condition from the report's own filter — see `amendment-documentation`,
 *              where it is emphatically not the same as filtering the rows
 *   joinTxn    whether the ordering needs columns off `transactions`
 *   order      the ORDER BY tail, which must reproduce the enrichment path's comparator exactly
 */
export interface DocRowSource {
  /** Which documents are rows. A SQL predicate over `d`. */
  rowWhere: string;
  /** The section each row belongs to. `'all'` when the report declares no sections. */
  sectionSql: string;
  /**
   * A deal-level qualification from the report's own filter, applied as `tid IN (…)`, or `null`
   * when this filter value cannot be expressed — in which case the enrichment path answers it.
   */
  qualify: (f: ReportFilters) => string | null;
  /** Whether the ordering reads `transactions` columns, which costs a join. */
  joinTxn: boolean;
  /**
   * The ORDER BY tail. Reproduces `ReportsService.sort` — see the note on `AMENDMENT_ORDER` for why
   * the null placement is left to the SQL defaults rather than spelled out.
   */
  order: string;
  /**
   * The sort key this order encodes. `runFastDocRows` refuses a request for any other, because the
   * order above is the only one it can produce — the same rule the deal-level path applies.
   */
  sortKey: string | null;
}

/**
 * Amendment Documentation's ordering, which is `ReportsService.sort` transliterated.
 *
 * The comparator is: the sort key, then closing date DESCENDING regardless of the primary direction,
 * then trade number ascending, then whatever order the rows were built in.
 *
 * NULL PLACEMENT IS DELIBERATELY LEFT TO THE SQL DEFAULTS, and that is not laziness — it is the
 * answer. `cmp` treats null, undefined and the empty string alike and returns "a goes after b" for
 * them, and the caller multiplies that by the direction. So an empty value sorts LAST ascending and
 * FIRST descending, which is exactly what `ASC NULLS LAST` / `DESC NULLS FIRST` already mean in
 * Postgres. Writing `NULLS LAST` on a DESC key would invert it and quietly move every deal with no
 * uploaded amendment to the wrong end of the report.
 *
 * The empty string still has to be folded into NULL, because SQL does not consider `''` null and
 * `cmp` does — hence `NULLIF` on the date expressions.
 *
 * `position, id` is the final tiebreak, matching `docRowPageSql` and for the same reason: documents
 * are loaded `ORDER BY position ASC`, `Array.prototype.sort` is stable, so two rows equal on every
 * key above keep load order — and `id` makes it deterministic where positions also tie.
 */
const AMENDMENT_ORDER = `NULLIF(a.uploaded_at::text, '') DESC, t.closing_date DESC, t.trade_no ASC, a.position ASC, a.id ASC`;

export const DOC_ROW_SOURCES: Record<string, DocRowSource> = {
  /*
   * Unchanged from the hard-coded version this replaces: every document that is not Valid, split
   * into the two sections by whether it is Invalid, ordered by deal then category then title.
   */
  'pending-invalid-documents': {
    rowWhere: `lower(btrim(d.validation)) <> 'valid'`,
    sectionSql: `CASE lower(btrim(d.validation)) WHEN 'invalid' THEN 'invalid' ELSE 'pending' END`,
    qualify: () => 'TRUE',
    joinTxn: false,
    order: `a.tid, a.category, a.title, a.position, a.id`,
    sortKey: null,
  },

  /**
   * Amendment Documentation — one row per amendment document.
   *
   * THE FILTER QUALIFIES DEALS, NOT ROWS, and getting that backwards would silently change the
   * report. Its predicate is `amendments.some(d => d.status === f.status)` and its `expand` then
   * emits EVERY amendment of that deal — so asking for Pending shows a deal's Valid amendments too,
   * as long as one of them is Pending. Filtering the rows instead would drop those, which is a
   * different report that happens to look plausible.
   *
   * `Missing` is not here. It selects deals with NO amendment document and emits a synthetic row per
   * deal, which is not a document row at all — there is nothing for this path to page over. It
   * returns `null` and the enrichment path answers it, exactly as an unsupported sort does.
   */
  'amendment-documentation': {
    rowWhere: `d.title ~* 'amend'`,
    sectionSql: `'all'`,
    qualify: (f) => {
      const status = (f.status ?? '').trim();
      if (status === '') return 'TRUE';
      if (status === 'Missing') return null;          // a deal-level row; see above
      if (!['Pending', 'Invalid', 'Valid'].includes(status)) return null;
      return `EXISTS (SELECT 1 FROM amend x WHERE x.tid = a.tid AND x.doc_status = '${status}')`;
    },
    joinTxn: true,
    order: AMENDMENT_ORDER,
    sortKey: 'doc_uploaded_at',
  },
};

/** Kept for readers who only need to ask "is this one of them?". */
export const DOC_ROW_REPORTS = new Set<string>(Object.keys(DOC_ROW_SOURCES));

/**
 * `docCategory(title)` as SQL — the thirteen rules of report-documents.ts, in their order.
 *
 * THE ORDER IS THE RULE. "Amendment to Agreement" is an Amendment and not an Agreement only because
 * /amend/ is tested first, so this CASE must keep them in exactly the sequence CATEGORY_RULES lists
 * them. It is transliterated rather than reused because the report orders its rows by category, and
 * ordering three hundred thousand document rows in Node is the thing being removed.
 *
 * `~*` is a case-insensitive POSIX match, which is what the /…/i literals are. The one construct
 * that differs in spelling is the word boundary: JavaScript's `\bid\b` is `\yid\y` here.
 *
 * Guarded by `report-docs-rows.spec.ts`, which compares this against `docCategory` over every
 * document title in the database and over the titles that discriminate the rules.
 */
export const DOC_CATEGORY_SQL = `CASE
  WHEN d.title ~* 'amend'                                                        THEN 'Amendments'
  WHEN d.title ~* 'waiv'                                                         THEN 'Waivers'
  WHEN d.title ~* 'notice|mutual release'                                        THEN 'Notices'
  WHEN d.title ~* 'deposit'                                                      THEN 'Deposits'
  WHEN d.title ~* 'fintrac|fintrack'                                             THEN 'FINTRAC'
  WHEN d.title ~* 'photo id|identification|\\yid\\y'                             THEN 'Identification'
  WHEN d.title ~* 'reco'                                                         THEN 'RECO Compliance'
  WHEN d.title ~* 'invoice'                                                      THEN 'Invoices'
  WHEN d.title ~* 'referral'                                                     THEN 'Referral Documents'
  WHEN d.title ~* 'commission|trade sheet'                                       THEN 'Commission Documents'
  WHEN d.title ~* 'agreement|representation|schedule|orta|co-?op|offer'          THEN 'Agreements'
  WHEN d.title ~* 'mls|listing'                                                  THEN 'Listing Documents'
  WHEN d.title ~* 'closing'                                                      THEN 'Closing Documents'
  ELSE 'Other' END`;

/**
 * Every pending or invalid document on the candidate deals, with the fields the ordering needs.
 *
 * `$1` is the id list Prisma produced from the ownership rule and the global filters. The section a
 * row belongs to is the document's own status, which is why one deal can appear under both headings.
 */
const docRowsCte = (src: DocRowSource, qualifySql: string): string => `
amend AS MATERIALIZED (
  SELECT
    d.id, d.transaction_id AS tid, d.title, d.position,
    d.created_at::date AS uploaded_at,
    ${DOC_CATEGORY_SQL} AS category,
    ${DOC_STATUS_SQL}   AS doc_status,
    ${src.sectionSql}   AS section
  FROM documents d
  WHERE d.deleted_at IS NULL
    AND d.transaction_id = ANY($1::int[])
    AND ${src.rowWhere}
),
doc_rows AS MATERIALIZED (
  SELECT a.*
  FROM amend a
  WHERE ${qualifySql}
)`;

/**
 * The CTE name is `amend` for every report, not only the amendment one.
 *
 * It reads oddly and the alternative reads worse: `qualify` writes a correlated EXISTS against the
 * unqualified set — "does this deal have another amendment that is Pending?" — so that set needs a
 * name the predicate can reference, and giving it a different name per report would mean the
 * predicates in `DOC_ROW_SOURCES` could not be written as constants. One name, stated here.
 */

/**
 * The row count overall and per section.
 *
 * The report totals nothing — every one of its columns is text — so the footer and each section
 * heading need a count and nothing else. That is the only reason this report can be answered without
 * reading its rows.
 */
export const docRowCountsSql = (src: DocRowSource, qualifySql: string): string => `
WITH ${docRowsCte(src, qualifySql)}
SELECT section, COUNT(*)::int AS n
FROM doc_rows a
WHERE section = ANY($2::text[])
GROUP BY section
`;

/**
 * One page of document rows, in the order the report presents them.
 *
 * THE ORDER IS COPIED FROM THE REPORT, not chosen here. `ReportsService.compute` lays out a section
 * report as `visibleSections.flatMap(rows of that section)`, the rows within a section arrive in
 * transaction order because that is the order deals are loaded in, and within a deal `expand()`
 * sorts by status, then category, then title. Status is constant inside a section, so what is left
 * is: section, then transaction id, then category, then title.
 *
 * `position, id` break the remaining ties. `Array.prototype.sort` is stable, so two documents with
 * the same category and title keep the order they were loaded in, which is `position ASC` — and `id`
 * makes it deterministic where positions also tie.
 */
export const docRowPageSql = (src: DocRowSource, qualifySql: string): string => `
WITH ${docRowsCte(src, qualifySql)}
SELECT a.id, a.tid
FROM doc_rows a
${src.joinTxn ? 'JOIN transactions t ON t.id = a.tid' : ''}
WHERE a.section = ANY($2::text[])
ORDER BY array_position($2::text[], a.section), ${src.order}
OFFSET $3 LIMIT $4
`;
