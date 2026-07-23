/** Bulk transaction import types (mirrors TransactionImportService). */

/** One problem found on one row of the uploaded file. */
export interface ImportIssue {
  row: number;
  reference: string;
  field: string;
  value: string;
  message: string;
  fix: string;
  severity: 'error' | 'warning' | 'duplicate';
}

/** The result of validating a file — nothing has been created yet. */
export interface ImportPreview {
  batch_id: string;
  file_name: string;
  total_rows: number;
  valid_rows: number;
  invalid_rows: number;
  duplicate_rows: number;
  warning_rows: number;
  issues: ImportIssue[];
  sample: Record<string, unknown>[];
}

/** The result of confirming an import. Invalid rows are skipped, never blocking. */
export interface ImportResult {
  batch_id: string;
  status: string;
  total_rows: number;
  imported_rows: number;
  failed_rows: number;
  duplicate_rows: number;
  issues: ImportIssue[];
  created: { row: number; trade_no: string; property: string | null }[];
}

// ---- bulk export / download ----

/** Which documents a ZIP download should contain. */
export type BulkDocFilter = 'all' | 'pending' | 'invalid' | 'valid' | 'mandatory';

/** What to export: explicit ids, or everything matching the current filters. */
export interface BulkSelection {
  transaction_ids: number[];
  all_matching?: boolean;
  filters?: Record<string, unknown>;
  documents?: BulkDocFilter;
  categories?: string[];
  uploaded_from?: string;
  uploaded_to?: string;
}

/** Confirmation summary shown before a bulk export runs. */
export interface BulkSummary {
  transactions: number;
  documents_available: number;
  documents_unavailable: number;
  documents_selected: number;
  categories: { name: string; count: number }[];
  transactions_without_documents: number;
  estimated_files: number;
  filters: { label: string; value: string }[];
}

/** A queued/processed bulk export in the Export & Download Centre. */
export interface ExportJob {
  export_id: string;
  action_type: string;
  action_label: string;
  format: string;
  status: 'Queued' | 'Processing' | 'Completed' | 'Partially Completed' | 'Failed' | 'Expired';
  transaction_count: number;
  document_count: number;
  skipped_count: number;
  file_name: string | null;
  file_size: number | null;
  filters: { label: string; value: string }[];
  requested_by: string | null;
  requested_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  expires_at: string | null;
  download_status: string;
  downloaded_at: string | null;
  download_count: number;
  failure_reason: string | null;
  /** Only present while the file is live and downloadable. */
  download_token: string | null;
}

/** One row of the bulk import history. */
export interface ImportBatch {
  batch_id: string;
  file_name: string | null;
  uploaded_by: string | null;
  uploaded_at: string | null;
  completed_at: string | null;
  total_rows: number;
  valid_rows: number;
  imported_rows: number;
  failed_rows: number;
  duplicate_rows: number;
  warning_rows: number;
  status: string;
}
