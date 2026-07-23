/**
 * Shared contract for the Reports module. Every report is a *definition* over the same
 * engine: a set of typed columns, a row-mapper, filter handling, and footer aggregations.
 * The controller, service, engine and both export renderers all speak these types.
 */

export type ColumnType = 'text' | 'currency' | 'percent' | 'number' | 'date' | 'datetime' | 'status';

/** A single displayable/exportable column in a report. */
export interface ReportColumn {
  /** Stable key used in row objects, customize-fields, sorting and exports. */
  key: string;
  /** Human label shown in the table and export headers (kept consistent across reports). */
  label: string;
  type: ColumnType;
  /** Included in the default view (all defaults are checked initially in Customize Fields). */
  default: boolean;
  /** May the user sort on this column? (server-side) */
  sortable?: boolean;
  /** For currency/number columns: sum this column in the footer totals. */
  total?: boolean;
  /** For percent columns: the footer shows an AVERAGE (never a sum) when true. */
  average?: boolean;
  /** Mandatory identifier that must always appear in exports even if unchecked (e.g. Trade No.). */
  mandatory?: boolean;
  /** Approx width hint (chars) for export column sizing. */
  width?: number;
}

/** A selectable option for a filter dropdown (returned by /filter-options). */
export interface FilterOption { value: string; label: string }

/** Report-specific filter descriptor surfaced to the frontend so filters aren't hardcoded. */
export interface ReportFilterDef {
  key: string;
  label: string;
  type: 'text' | 'select' | 'multiselect' | 'date' | 'daterange' | 'year';
  /** Options for select/multiselect; resolved dynamically where noted. */
  options?: FilterOption[];
  /** Marks a filter whose options come from /filter-options at runtime. */
  dynamic?: boolean;
}

/** Report categories for the dashboard grouping. */
export type ReportCategory =
  | 'Deal Reports'
  | 'Commission Reports'
  | 'Payment Reports'
  | 'Agent Reports'
  | 'Client and Referral Reports'
  | 'Review and Marketing Reports'
  | 'Documentation and Compliance Reports';

/** Optional report "sections" (only the Transaction Payment Status report uses these). */
export interface ReportSectionDef { key: string; label: string; description?: string }

/** Static metadata about a report (drives the dashboard cards + column endpoints). */
export interface ReportMeta {
  type: string;            // url slug, e.g. 'sales-statement'
  name: string;            // precise display name
  description: string;
  category: ReportCategory;
  columns: ReportColumn[];
  filters: ReportFilterDef[];
  sections?: ReportSectionDef[];
  /** Default sort column key + direction. */
  defaultSort: { key: string; dir: 'asc' | 'desc' };
}

/** Normalized, validated filter payload (all optional; empty means "no constraint"). */
export interface ReportFilters {
  search?: string;
  deal_type?: string[];        // exact transaction types
  agent?: string[];            // agent names (admin only; agents are auto-scoped)
  payment_type?: string[];
  year?: number;
  offer_date_from?: string;    // YYYY-MM-DD inclusive
  offer_date_to?: string;
  closing_date_from?: string;
  closing_date_to?: string;
  payout_status?: string;      // report-defined payout/payment status
  /** RECO Audit Readiness report: '' (All) | 'Yes' | 'No'. */
  reco_ready?: string;
  /** Reminder history: reminder type + sent-date range. */
  reminder_type?: string;
  sent_from?: string;
  sent_to?: string;
  status?: string;             // report-specific status (Paid/Pending/…, Active/Overdue, …)
  split_ratio?: string[];      // e.g. ['90/10','95/5']
  sections?: string[];         // Transaction Payment Status sections
  match_mode?: 'any' | 'all';  // multi-agent match mode (Team Split)
  advance_paid_from?: string;
  advance_paid_to?: string;
  cashback_from?: string;
  cashback_to?: string;
  referral_from?: string;
  referral_to?: string;
  review_sent_from?: string;
  review_sent_to?: string;
  review_recv_from?: string;
  review_recv_to?: string;
  coupon_from?: string;
  coupon_to?: string;
}

/** Pagination + sorting request. */
export interface ReportQuery {
  filters: ReportFilters;
  page?: number;
  per_page?: number;
  sort?: string;               // column key
  dir?: 'asc' | 'desc';
  columns?: string[];          // selected (customized) column keys, in order
}

/** One report row: column key -> value (numbers for currency/percent, strings/null for text/date). */
export type ReportRow = Record<string, string | number | null>;

/** Footer totals: column key -> aggregated numeric value (already decimal-safe). */
export type ReportTotals = Record<string, number>;

/** The full paginated search result. */
export interface ReportResult {
  report: { type: string; name: string; description: string };
  columns: ReportColumn[];            // the resolved (selected) columns, in order
  rows: ReportRow[];                  // current page
  totals: ReportTotals;               // over the COMPLETE filtered dataset (not just the page)
  total_count: number;                // deals in the filtered dataset
  page: number;
  per_page: number;
  last_page: number;
  applied_filters: { label: string; value: string }[]; // for the report header + exports
  /** In-table sections (payment-status report): order, counts and per-section subtotals. */
  sections?: { key: string; label: string; count: number; totals?: ReportTotals }[];
}

/** Everything an export renderer needs. */
export interface ExportPayload {
  reportName: string;
  generatedAt: Date;
  generatedBy: string;
  appliedFilters: { label: string; value: string }[];
  dealTypeHeading: string | null;     // shown in header when exactly one deal type is selected
  columns: ReportColumn[];            // selected columns, in order (hidden columns already removed)
  rows: ReportRow[];                  // COMPLETE filtered dataset (not paginated)
  totals: ReportTotals;
  branding: string;                   // company/brokerage name from settings
  /**
   * Section-grouped reports (Transaction Payment Status): the enabled sections in order, with
   * counts and per-section subtotals. When present the renderer emits one banded block per
   * section — heading + count, its own column headers, its rows and its subtotal row — instead
   * of a single flat table. A section with `totals: undefined` (Mutual Release) shows no
   * financial subtotal. Rows are matched to a section via `row.section`.
   */
  sections?: { key: string; label: string; count: number; totals?: ReportTotals }[];
}
