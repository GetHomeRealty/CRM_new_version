/**
 * Company settings (GET /api/company-settings) — printed on invoices, statements,
 * receipts. Many fields are consumed across the invoice/document components; the
 * commonly-used ones are declared and the rest are `unknown`-indexed.
 */
export interface CompanySettings {
  name?: string;
  address?: string;
  phone?: string;
  email?: string;
  hst_number?: string;
  thank_you_note?: string;
  deposit_heading?: string;
  /** Cadence (days) for recurring lawyer-detail reminder emails. 0 = off. */
  lawyer_reminder_days?: number;
  default_terms?: string;
  default_tax_rate?: number;
  broker_name?: string;
  bank_name?: string;
  bank_beneficiary?: string;
  transit_no?: string;
  institution_no?: string;
  account_no?: string;
  /** Stored path of the uploaded brand logo; null/absent means "use the text wordmark". */
  logo_path?: string | null;
  /** Changes whenever settings are saved — used to cache-bust the logo image. */
  updated_at?: string | null;
  [key: string]: unknown;
}
