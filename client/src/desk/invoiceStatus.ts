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

/**
 * TD-048 — the OTHER field on the Admin Activities panel, and the last collision between the two.
 *
 * That panel carries two fields two lines apart, and on one invoice at one moment they read:
 *
 *     Invoice Status:  Overdue
 *     Invoice Sent:    Draft
 *
 * 'Draft' is a member of INVOICE_STATUSES above, so a reader is shown two status-words for one
 * invoice — which is this entry's original complaint ("the Admin Activities panel says Draft")
 * surviving in a relabelled field rather than being resolved.
 *
 * WHY THE VALUE IS NOT RENAMED AT SOURCE. `invoice_sent_status` is DERIVED for the payload but is
 * also a STORED field on `admin_activities` that the modal reads back, so historical rows hold the
 * old word. Renaming the enum would create a fresh mismatch rather than remove one — a new defect
 * of exactly the shape this entry is about. So the stored value is left alone and the words are
 * mapped where they are rendered.
 *
 * ONLY THE TWO THAT NEED IT. 'Draft' is the collision, and 'Pending to Raise' is opaque rather than
 * wrong. 'Sent', 'Paid' and 'Void' are left: each appears only when the status field says the same
 * thing, so the two lines agree rather than contradict, and rewriting them would assert something
 * the payload does not carry — an invoice marked Paid says nothing about whether it was ever
 * emailed, and this field must not claim it was.
 */
const SENT_STATUS_WORDS: Record<string, string> = {
  Draft: 'Not sent',
  'Pending to Raise': 'Not raised',
};

/** How the "Invoice Sent" field reads. Anything unmapped shows exactly as stored. */
export const sentStatusLabel = (value: string | null | undefined): string => {
  const v = String(value ?? '').trim();
  if (!v) return '—';
  return SENT_STATUS_WORDS[v] ?? v;
};
