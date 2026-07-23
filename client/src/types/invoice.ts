import type { CompanySettings } from './settings';

/** A single invoice line item. */
export interface InvoiceLineItem {
  id?: number;
  description?: string;
  qty?: number | string;
  rate?: number | string;
  amount?: number | string;
  is_taxable?: boolean;
}

/** A recorded invoice payment. */
export interface InvoicePayment {
  id?: number;
  amount?: number | string;
  paid_on?: string | null;
  method?: string;
  reference?: string;
  [key: string]: unknown;
}

/**
 * An invoice (list row + full editor record). Money fields may arrive as numbers
 * (backend) or strings (editor inputs). Unmodelled editor fields are `unknown`-indexed.
 */
export interface Invoice {
  id: number;
  invoice_no?: string;
  invoice_date?: string;
  due_date?: string | null;
  terms?: string;
  subject?: string;
  trade_number?: string | number;
  property_reference?: string;
  transaction_type?: string;
  listing_agent?: string;
  coop_salesperson?: string;
  customer_name?: string;
  customer_address?: string;
  customer_city?: string;
  customer_postal_code?: string;
  customer_province?: string;
  customer_country?: string;
  line_items?: InvoiceLineItem[];
  payments?: InvoicePayment[];
  sub_total?: number | string;
  tax_total?: number | string;
  tax_rate?: number | string;
  discount?: number | string;
  total?: number | string;
  amount_paid?: number | string;
  balance_due?: number | string;
  signature_path?: string | null;
  broker_name?: string;
  company?: CompanySettings;
  status?: string;
  display_status?: string;
  source?: string;
  closing_date?: string | null;
  // Editor detail fields.
  customer_id?: number | string | null;
  customer_email?: string;
  customer_phone?: string;
  transaction_id?: number | null;
  purchase_price?: number | string | null;
  customer_notes?: string;
  terms_conditions?: string;
  commission_received_date?: string | null;
  commission_received_via?: string | null;
  auto_reminder?: { mode?: string; dates?: string[] } | null;
  sent_at?: string | null;
  reminders?: unknown[];
  [key: string]: unknown;
}
