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
  deposit_signatory?: string;
  /** Invoice Settings: the default Terms & Conditions copied onto each new invoice. */
  invoice_terms_conditions?: string | null;
  /** Invoice Settings: the default signature (PNG data URL) copied onto each new invoice. */
  invoice_signature?: string | null;
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

/** Triggers screen - the scheduled reminders' switches and days (29 Oct 2026). */
export interface ReminderDaysRule { on: boolean; days: number[] }
export interface ReminderAfterRule { on: boolean; first: number; every: number; until: number }
export interface ReminderRules {
  lawyer: ReminderDaysRule;
  closing: ReminderDaysRule;
  condition: ReminderDaysRule;
  listing_expiry: ReminderDaysRule;
  deposit: { on: boolean; days: number };
  commission: { on: boolean };
  void_cheque: { on: boolean; before: number; after: number; gap: number; never: number[]; always: number[] };
  after_status: ReminderAfterRule;
  after_docs: ReminderAfterRule;
  after_lawyer: ReminderAfterRule;
  after_closing_from: string | null;
  after_started: Partial<Record<'after_status' | 'after_docs' | 'after_lawyer', string>>;
}
export interface ReminderRulesResponse { data: ReminderRules; can_edit: boolean; max_days: number }
