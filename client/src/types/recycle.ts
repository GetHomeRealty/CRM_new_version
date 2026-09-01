/** Recycle Bin (soft-deleted records) domain types. */

/** Standard trash-list envelope. */
export interface TrashedResponse<T> { items: T[]; }

export interface TrashedTransaction {
  id: number | string;
  trade_no?: number | string;
  type?: string;
  property?: string;
  agent?: string;
  price?: number | string;
  deleted_at?: string;
  /** TD-091 — who actually removed it, resolved from the audit trail. Null on pre-trail rows. */
  deleted_by?: string | null;
  requested_by?: string;
  reason?: string;
  [key: string]: unknown;
}

export interface TrashedDocument {
  id: number | string;
  title: string;
  status?: string;
  validation?: string;
  has_file?: boolean;
  file_count?: number;
  deleted_at?: string;
  transaction_id?: number | string | null;
  trade_no?: number | string;
  transaction_trashed?: boolean;
  [key: string]: unknown;
}

export interface TrashedInvoice {
  id: number | string;
  invoice_no?: string;
  customer_name?: string;
  total?: number | string;
  status?: string;
  reason?: string;
  deleted_at?: string;
  transaction_id?: number | string | null;
  trade_no?: number | string;
  transaction_trashed?: boolean;
  [key: string]: unknown;
}

export interface TrashedPayment {
  id: number | string;
  amount?: number | string;
  method?: string;
  reference?: string;
  paid_on?: string;
  deleted_at?: string;
  invoice_id?: number | string | null;
  invoice_no?: string;
  invoice_trashed?: boolean;
  [key: string]: unknown;
}

export interface TrashedRowItem {
  id: number | string;
  kind_label?: string;
  agent?: string;
  summary?: string;
  who?: string;
  label?: string;
  deleted_at?: string;
  transaction_id?: number | string | null;
  trade_no?: number | string;
  transaction_trashed?: boolean;
  [key: string]: unknown;
}

export interface DeletionLogEntry {
  id: number | string;
  stamp?: string;
  who?: string;
  action?: string;
  section?: string;
  field?: string;
  details?: string;
  old_value?: string | null;
  /** TD-019 — a `common`-domain deletion, shown in both areas' logs rather than owned by either. */
  shared?: boolean;
  transaction_id?: number | string | null;
  trade_no?: number | string;
  transaction_trashed?: boolean;
  [key: string]: unknown;
}
