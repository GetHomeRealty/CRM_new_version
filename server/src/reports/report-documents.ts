/**
 * Documentation reporting primitives — pure functions over the `documents` and `conditions`
 * tables, kept free of Prisma/Nest so they can be unit-tested directly.
 *
 * The application stores documentation state on two independent axes:
 *   documents.status      — 'Pending' | 'Received'          (has the file arrived?)
 *   documents.validation  — 'Pending' | 'Valid' | 'Invalid' (has it been checked?)
 * Reports need ONE documentation status per document, and the spec requires Pending and
 * Invalid to stay strictly separate (never merged into a single count).
 */

/** The single documentation status a report shows for a document. */
export type DocStatus = 'Pending' | 'Invalid' | 'Valid';

export interface DocRow {
  id: number;
  title: string;
  category: string;
  /** Reporting status — Invalid beats Valid beats Pending. */
  status: DocStatus;
  raw_status: string;        // documents.status ('Pending' | 'Received')
  validation: string;        // documents.validation
  mandatory: boolean;
  is_condition: boolean;
  uploaded: boolean;         // a file is actually attached
  reminder_sent: boolean;    // documents.reminder
  file_name: string | null;
  uploaded_at: string | null;
  reviewed_at: string | null;
  remarks: string | null;    // doubles as invalid reason / validation notes
}

export interface CondRow {
  id: number;
  type: string;              // 'Financing', 'Sale of Property', custom_name, …
  deadline: string | null;
  status: string;            // conditions.status
  expiry_status: string;     // Active | Expiring Soon | Expired | Fulfilled | Waived | Extended
}

/**
 * Documentation status for one document row.
 * Invalid is decisive; a document is Valid only once validation says so; everything else
 * (not received, received but unchecked) is Pending.
 */
export function docStatus(d: { status: string; validation: string }): DocStatus {
  const v = String(d.validation ?? '').trim().toLowerCase();
  if (v === 'invalid') return 'Invalid';
  if (v === 'valid') return 'Valid';
  return 'Pending';
}

/**
 * Document category, derived from the document title (the app has no category column).
 * Order matters: the first pattern that matches wins, so "Amendment to Agreement" is an
 * Amendment rather than an Agreement.
 */
const CATEGORY_RULES: [RegExp, string][] = [
  [/amend/i, 'Amendments'],
  [/waiv/i, 'Waivers'],
  [/notice|mutual release/i, 'Notices'],
  [/deposit/i, 'Deposits'],
  [/fintrac|fintrack/i, 'FINTRAC'],
  [/photo id|identification|\bid\b/i, 'Identification'],
  [/reco/i, 'RECO Compliance'],
  [/invoice/i, 'Invoices'],
  [/referral/i, 'Referral Documents'],
  [/commission|trade sheet/i, 'Commission Documents'],
  [/agreement|representation|schedule|orta|co-?op|offer/i, 'Agreements'],
  [/mls|listing/i, 'Listing Documents'],
  [/closing/i, 'Closing Documents'],
];
export function docCategory(title: string): string {
  for (const [re, name] of CATEGORY_RULES) if (re.test(title)) return name;
  return 'Other';
}

/** "Amendment" documents — the Amendment Documentation Report's population. */
export function isAmendment(title: string): boolean {
  return /amend/i.test(title);
}
/** Waiver documents, reported separately from amendments on the Conditional Offers report. */
export function isWaiver(title: string): boolean {
  return /waiv/i.test(title);
}

/** Aggregate documentation counts for one transaction. Pending and Invalid never merge. */
export interface DocCounts {
  total: number;
  pending: number;
  invalid: number;
  valid: number;
  mandatory: number;
  /** Mandatory documents that are not yet Valid — the "missing mandatory" measure. */
  missing_mandatory: number;
  uploaded: number;
  reminders_sent: number;
}
export function docCounts(docs: DocRow[]): DocCounts {
  return {
    total: docs.length,
    pending: docs.filter((d) => d.status === 'Pending').length,
    invalid: docs.filter((d) => d.status === 'Invalid').length,
    valid: docs.filter((d) => d.status === 'Valid').length,
    mandatory: docs.filter((d) => d.mandatory).length,
    missing_mandatory: docs.filter((d) => d.mandatory && d.status !== 'Valid').length,
    uploaded: docs.filter((d) => d.uploaded).length,
    reminders_sent: docs.filter((d) => d.reminder_sent).length,
  };
}

/**
 * Transaction-level documentation status. Invalid documentation is surfaced ahead of
 * pending documentation so it cannot hide behind a larger pending count.
 */
export function documentationStatus(c: DocCounts): string {
  if (c.total === 0) return 'No Documents';
  if (c.invalid > 0) return 'Invalid Documentation';
  if (c.pending > 0) return 'Pending Documentation';
  return 'Complete';
}

/** Aggregate status across a set of documents (used for waiver/amendment sub-status). */
export function groupStatus(docs: DocRow[]): string {
  if (!docs.length) return 'Missing';
  if (docs.some((d) => d.status === 'Invalid')) return 'Invalid';
  if (docs.some((d) => d.status === 'Pending')) return 'Pending';
  return 'Valid';
}

/** Days between today and a yyyy-mm-dd deadline (negative once past). */
export function daysUntil(deadline: string | null, today: string): number | null {
  if (!deadline) return null;
  const a = Date.parse(deadline + 'T00:00:00Z'), b = Date.parse(today + 'T00:00:00Z');
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((a - b) / 86400000);
}

/** Conditions expiring within this many days are reported as "Expiring Soon". */
export const EXPIRING_SOON_DAYS = 3;

/**
 * Condition expiry status, computed from the condition's own status and its deadline.
 * An explicitly recorded outcome (fulfilled / waived / extended) always wins over the date.
 */
export function expiryStatus(cond: { status: string; deadline: string | null }, today: string): string {
  const s = String(cond.status ?? '').trim().toLowerCase();
  if (s === 'fulfilled' || s === 'completed' || s === 'satisfied') return 'Fulfilled';
  if (s === 'waived') return 'Waived';
  if (s === 'extended') return 'Extended';
  const d = daysUntil(cond.deadline, today);
  if (d === null) return 'Active';
  if (d < 0) return 'Expired';
  if (d <= EXPIRING_SOON_DAYS) return 'Expiring Soon';
  return 'Active';
}

/** Human "remaining time" for a condition ("in 5 days", "today", "3 days overdue"). */
export function remainingTime(deadline: string | null, today: string): string {
  const d = daysUntil(deadline, today);
  if (d === null) return '—';
  if (d === 0) return 'Today';
  if (d < 0) return `${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'} overdue`;
  return `in ${d} day${d === 1 ? '' : 's'}`;
}
