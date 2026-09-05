/*
 * TD-048 — ONE INVOICE VOCABULARY, FOR EVERY SCREEN THAT SHOWS ONE.
 *
 * There were three lists and no agreement between them. The editor offered five statuses
 * (Unpaid, Paid, Overdue, Void, Due); its own colour map knew seven, adding Partially Paid and
 * Draft — so the client could render two states it gave nobody a way to choose; and the list
 * filter built a fourth list by spreading the editor's five behind two hand-written extras. The
 * API accepted a seventh the editor never offered. The result was one invoice described by four
 * different words at once.
 *
 * This mirrors `server/src/reference/invoice.constants.ts`, which is the authority: `ALL` is what
 * the column may hold and what the filter therefore offers, `SETTABLE` is what a person may pick,
 * and the difference between them is the two states the invoice writes for itself.
 */

/** Every status an invoice may hold — the filter's list, and the keys the colour maps cover. */
export const INVOICE_STATUSES = [
  'Draft',
  'Unpaid',
  'Partially Paid',
  'Paid',
  'Due',
  'Overdue',
  'Void',
] as const;

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * Set by the invoice, never chosen: a new invoice starts as a Draft, and a part payment moves it
 * to Partially Paid on its own. The API refuses either as a hand-set value, so offering them here
 * would be offering a button that answers 422.
 */
export const DERIVED_STATUSES: readonly InvoiceStatus[] = ['Draft', 'Partially Paid'];

/** What the editor's Status menu offers — the complement of the derived pair, not a second list. */
export const SETTABLE_STATUSES: readonly InvoiceStatus[] =
  INVOICE_STATUSES.filter((s) => !DERIVED_STATUSES.includes(s));

/** Pill class for the list badge. Keyed by every status, so no state falls back to a wrong colour. */
export const STATUS_PILL: Record<string, string> = {
  Draft: 'info',
  Unpaid: 'info',
  'Partially Paid': 'warn',
  Paid: 'ok',
  Due: 'info',
  Overdue: 'bad',
  Void: 'bad',
};

/** The same seven, as the editor's badge colours. Due=blue, Overdue=red, Paid=green, Void=black. */
export const STATUS_COLOR: Record<string, string> = {
  Draft: 'var(--muted)',
  Unpaid: 'var(--info)',
  'Partially Paid': 'var(--warn)',
  Paid: 'var(--ok-600)',
  Due: 'var(--info)',
  Overdue: 'var(--bad)',
  Void: 'var(--text)',
};
