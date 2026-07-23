/** Reports module — client types mirroring the NestJS reports API. */

export type ReportColumnType = 'text' | 'currency' | 'percent' | 'number' | 'date' | 'datetime' | 'status';

export interface ReportColumn {
  key: string;
  label: string;
  type: ReportColumnType;
  default: boolean;
  sortable?: boolean;
  total?: boolean;
  average?: boolean;
  mandatory?: boolean;
  width?: number;
}

export interface ReportListItem {
  type: string;
  name: string;
  description: string;
  category: string;
}

export interface ReportSection { key: string; label: string; description?: string; count?: number; totals?: ReportTotals }

export interface ReportFilterDef {
  key: string;
  label: string;
  type: 'text' | 'select' | 'multiselect' | 'date' | 'daterange' | 'year';
  options?: { value: string; label: string }[];
  dynamic?: boolean;
}

export interface ReportMeta {
  type: string;
  name: string;
  description: string;
  category: string;
  columns: ReportColumn[];
  filters: ReportFilterDef[];
  sections?: ReportSection[];
  defaultSort: { key: string; dir: 'asc' | 'desc' };
  /** Section-grouped reports render in fixed section order — column sorting is disabled. */
  noSort?: boolean;
  /** Rows can be expanded to show the deal's individual documents. */
  expandable?: boolean;
  /** Non-transaction data source ('loans' | 'reminders') — those rows aren't selectable. */
  custom?: string;
}

/** One document inside an expanded deal (GET /api/reports/documents/:transactionId). */
export interface ReportDocument {
  id: number;
  name: string;
  category: string;
  status: 'Pending' | 'Invalid' | 'Valid';
  required: string;
  uploaded: boolean;
  uploaded_at: string | null;
  reviewed_at: string | null;
  invalid_reason: string | null;
  notes: string | null;
  reminder_status: string;
}

// ---- documentation reminders ----

/** Which documents a reminder targets. Pending and invalid are never combined. */
export type ReminderScope = 'pending' | 'invalid' | 'all';

export interface ReminderRequest {
  transaction_ids: number[];
  document_ids?: number[];
  scope: ReminderScope;
  channel?: string;
}

/** Resolved before sending, so the user sees the applicable document count first. */
export interface ReminderPreview {
  deals: number;
  documents: number;
  pending: number;
  invalid: number;
  recipients: string[];
  missing_recipients: { trade_no: string; reason: string }[];
  duplicate_warnings: { trade_no: string; document: string; sent_at: string | null }[];
}

export interface ReminderResult {
  batch_id: string;
  sent: number;
  failed: number;
  skipped: number;
  documents: number;
  deals: { trade_no: string; recipient: string | null; status: string; documents: number; reason?: string }[];
}

/** A deal expanded to its documents, grouped so pending and invalid stay separate. */
export interface ReportDocuments {
  transaction: { id: number; trade_no: string; property: string | null; agent: string | null; clients: string[] };
  counts: Record<string, number>;
  groups: { key: string; label: string; documents: ReportDocument[] }[];
}

export type ReportRow = Record<string, string | number | null>;
export type ReportTotals = Record<string, number>;

export interface ReportResult {
  report: { type: string; name: string; description: string };
  columns: ReportColumn[];
  rows: ReportRow[];
  totals: ReportTotals;
  total_count: number;
  page: number;
  per_page: number;
  last_page: number;
  applied_filters: { label: string; value: string }[];
  sections?: ReportSection[];
}

export interface ReportFilterOptions {
  deal_type: { value: string; label: string }[];
  payment_type: { value: string; label: string }[];
  agent: { value: string; label: string }[];
  split_ratio: { value: string; label: string }[];
  /** Agent commission payment statuses (Paid / Partially Paid / Pending / Upcoming / N-A). */
  payout_status: { value: string; label: string }[];
  /** Distinct closing-date years, newest first (the "Closing Year" filter; "" = All). */
  year: { value: string; label: string }[];
}

/** The filter payload sent to /search and /export (all optional). */
export interface ReportFilterValues {
  search?: string;
  deal_type?: string[];
  agent?: string[];
  payment_type?: string[];
  year?: number | string;
  offer_date_from?: string;
  offer_date_to?: string;
  closing_date_from?: string;
  closing_date_to?: string;
  payout_status?: string;
  /** RECO Audit Readiness: '' (All) | 'Yes' | 'No'. */
  reco_ready?: string;
  status?: string;
  split_ratio?: string[];
  sections?: string[];
  match_mode?: 'any' | 'all';
  advance_paid_from?: string;
  advance_paid_to?: string;
  cashback_from?: string;
  cashback_to?: string;
  referral_from?: string;
  referral_to?: string;
}

export interface ReportSearchBody {
  filters: ReportFilterValues;
  page?: number;
  per_page?: number;
  sort?: string;
  dir?: 'asc' | 'desc';
  columns?: string[];
}
