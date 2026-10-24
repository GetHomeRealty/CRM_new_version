/**
 * Company Settings -> Invoice Settings: what a NEW invoice starts with.
 *
 * Copied onto the invoice when it is created, never read live, so each deal can change or clear its
 * own Customer Notes, Terms & Conditions and signature before sending, and a later change to the
 * defaults does not rewrite an invoice that has already gone out.
 *
 * The default Customer Notes is the existing `thank_you_note` setting (shown as "Default Customer
 * Notes" on the Settings screen); the other two are the Invoice Settings columns.
 */
export interface InvoiceDocDefaults {
  customer_notes: string | null;
  terms_conditions: string | null;
  signature_path: string | null;
}

type SettingsLike = {
  thank_you_note?: string | null;
  invoice_terms_conditions?: string | null;
  invoice_signature?: string | null;
} | null | undefined;

const orNull = (v: string | null | undefined): string | null => (v && v.trim() ? v : null);

export function invoiceDocDefaults(s: SettingsLike): InvoiceDocDefaults {
  return {
    customer_notes: orNull(s?.thank_you_note),
    terms_conditions: orNull(s?.invoice_terms_conditions),
    signature_path: orNull(s?.invoice_signature),
  };
}
