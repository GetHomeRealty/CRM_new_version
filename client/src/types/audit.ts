/** A single audit-trail entry (per-transaction and cross-module log). */
export interface AuditEntry {
  id: number | string;
  stamp?: string;
  who?: string;
  section?: string;
  field?: string;
  action?: string;
  old_value?: string | null;
  new_value?: string | null;
  details?: string;
  source?: string;
  category?: string;
  record?: string;
  [key: string]: unknown;
}

/** Paginated audit-log response (GET /api/audit-logs). */
export interface AuditLogPage {
  data: AuditEntry[];
  meta: { current_page: number; last_page: number; total: number };
  categories?: string[];
}
