/**
 * TD-004 — the vocabularies an invoice may actually hold.
 *
 * These existed, but only as behaviour rather than as a rule: `InvoiceCalculator.TERM_DAYS` knew
 * how to turn four terms into a due date, the calculator knew which statuses it derives, and the
 * editor knew which ones to offer. Nothing refused a value outside them, so `terms: "NOT_A_TERM"`
 * and `status: "Hacked"` both stored, the first with a NULL due date that hides the invoice from
 * the overdue view and the reminder sweep for ever.
 *
 * Stated here, next to `transaction.constants.ts`, so the API and the screens can be checked
 * against one list instead of three copies of a convention.
 */

/**
 * Payment terms. The first four are `InvoiceCalculator.TERM_DAYS` — the ones that COMPUTE a due
 * date from the invoice date. The last two are the ones that cannot: a due date is carried on the
 * invoice instead, and may legitimately be absent while a closing date is still unknown.
 */
export const INVOICE_TERMS = [
  'Due on Receipt',
  'Net 7',
  'Net 15',
  'Net 30',
  'Custom',
  'Due on Closing',
] as const;

/**
 * Every status the system itself writes.
 *
 * DELIBERATELY WIDER THAN THE EDITOR'S DROPDOWN, which offers five (`STATUSES` in
 * InvoiceEditorModal). `Draft` is what a new invoice starts as, and `Unpaid` / `Partially Paid`
 * are derived by `InvoiceCalculator.status()` rather than chosen by anyone. Refusing those would
 * reject the application's own writes — the point of this list is to refuse words that are not
 * statuses at all, not to re-litigate which of the real ones a person may pick.
 */
export const INVOICE_STATUSES = [
  'Draft',
  'Unpaid',
  'Partially Paid',
  'Paid',
  'Due',
  'Overdue',
  'Void',
] as const;

/**
 * The ceiling on a tax rate, as a percentage.
 *
 * 100 rather than the column's limit. `tax_rate` is `Decimal(5,2)`, so the DATABASE refuses
 * anything over 999.99 — which is why `tax_rate: 9999` came back as a 500 rather than a 422. A
 * rate above 100% is not a tax, so the application should have an opinion well before the column
 * does, and say so in a field message instead of an internal error.
 */
export const MAX_TAX_RATE = 100;

export const isInvoiceTerm = (v: string): boolean => (INVOICE_TERMS as readonly string[]).includes(v);
export const isInvoiceStatus = (v: string): boolean => (INVOICE_STATUSES as readonly string[]).includes(v);
