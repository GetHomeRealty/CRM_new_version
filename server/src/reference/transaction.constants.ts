/** Mirrors App\Models\Transaction::TYPES / ::LISTING_TYPES. */

export const TRANSACTION_TYPES = [
  'Residential Buying',
  'Residential Lease',
  'Residential Sale Listing',
  'Residential Lease Listing',
  'Preconstruction',
  'Referral',
  'Commercial Property Buying',
  'Commercial Property Lease',
  'Commercial Property Sale Listing',
  'Commercial Property Lease Listing',
  'Business Buying',
  'Business Sale',
] as const;

export const LISTING_TYPES = [
  'Residential Sale Listing',
  'Residential Lease Listing',
  'Commercial Property Sale Listing',
  'Commercial Property Lease Listing',
] as const;

export const SECURED_DEAL_TYPES = [
  'Residential Buying',
  'Residential Lease',
  'Commercial Property Buying',
  'Commercial Property Lease',
  'Business Buying',
] as const;

export const INVOICEABLE_TYPES = [
  'Residential Buying',
  'Residential Lease',
  'Preconstruction',
  'Referral',
  'Commercial Property Buying',
  'Commercial Property Lease',
  'Business Buying',
] as const;

/*
 * TD-050 — THE NAMES THE SCREENS SHOW, ACCEPTED WHEREVER A TYPE IS TYPED.
 *
 * Three of the twelve types are RELABELLED in the client (`TYPE_LABELS` in `client/src/desk/
 * format.ts`): the stored `Residential Sale Listing` is shown as "Sale Listing", `Residential Lease
 * Listing` as "Lease Listing", and `Preconstruction` as "Pre-construction". The dropdowns map the
 * label back to the value correctly, so the screens themselves are fine.
 *
 * The bulk importer and the API compare against the STORED value. So somebody building an import
 * file by copying the deal type off the screen — the only names the application ever showed them —
 * had three of twelve rows refused with "Not a valid transaction type", naming a list they had
 * never seen. The same is true of an API caller who sends what the UI displays.
 *
 * The labels are accepted as aliases and resolved to the stored value, rather than the screens
 * being changed to show the long names: the labels are deliberate, and the refusal was the bug.
 * This is NOT a loosening of the catalogue check (TD-068) — anything that is neither a type nor a
 * label of one is still refused. Matching ignores case, surrounding space, and the hyphen in
 * "Pre-construction", because those are the ways a person retypes a name they read on a screen.
 */
export const TYPE_LABELS: Record<string, string> = {
  Preconstruction: 'Pre-construction',
  'Residential Sale Listing': 'Sale Listing',
  'Residential Lease Listing': 'Lease Listing',
};

/** 'sale listing' / 'Pre construction' → the key each name may be typed as. */
const typeKey = (v: string): string => v.trim().toLowerCase().replace(/[-\s]+/g, ' ');

const TYPE_BY_KEY: Map<string, string> = new Map([
  ...TRANSACTION_TYPES.map((t) => [typeKey(t), t] as [string, string]),
  ...Object.entries(TYPE_LABELS).map(([value, label]) => [typeKey(label), value] as [string, string]),
]);

/**
 * The stored transaction type for whatever was typed — a type, or the label a screen shows for one.
 * `null` when it is neither, which is still a refusal.
 */
export const canonicalTransactionType = (input: string | null | undefined): string | null =>
  TYPE_BY_KEY.get(typeKey(String(input ?? ''))) ?? null;

/** The names a person may enter for a type, for the message that lists them. */
export const ACCEPTED_TYPE_NAMES: string[] = [
  ...TRANSACTION_TYPES,
  ...Object.values(TYPE_LABELS),
];

export const isListingType = (type: string | null | undefined): boolean =>
  (LISTING_TYPES as readonly string[]).includes(type ?? '');

export const isInvoiceableType = (type: string | null | undefined): boolean =>
  (INVOICEABLE_TYPES as readonly string[]).includes(type ?? '');

/** Listing lifecycle covers the listing types plus Business Sale (mirrors the desk UI). */
export const isListingStatusFamily = (type: string | null | undefined): boolean =>
  isListingType(type) || type === 'Business Sale';

// ---- transaction statuses (same vocabulary the Transactions module offers) ----
const STATUS_DEAL = ['Open', 'Closed', 'Mutual Release', 'DFT', 'Void'];
const STATUS_DEAL_SECURED = ['Secured Firm', 'Secured Conditional', 'Closed', 'Mutual Release', 'DFT', 'Void'];
const STATUS_REFERRAL = ['Open', 'Closed'];
const listingStatuses = (type: string): string[] => {
  const lease = /lease/i.test(type);
  return ['Active', lease ? 'Lease Conditional' : 'Sold Conditional', lease ? 'Leased' : 'Sold',
    'Closed', 'Mutual Release', 'DFT', 'Void', 'Suspended', 'Terminated', 'Expired'];
};

/** Statuses a transaction of this type may be given. */
export function statusOptionsFor(type: string): string[] {
  if (type === 'Referral') return STATUS_REFERRAL;
  if (isListingStatusFamily(type)) return listingStatuses(type);
  if ((SECURED_DEAL_TYPES as readonly string[]).includes(type)) return STATUS_DEAL_SECURED;
  return STATUS_DEAL;
}

/** Secured deal types deliberately start with no status — the user picks one. */
export const defaultStatusFor = (type: string): string =>
  isListingStatusFamily(type) ? 'Active' : ((SECURED_DEAL_TYPES as readonly string[]).includes(type) ? '' : 'Open');

// ---- status integrity -------------------------------------------------------------------------

/**
 * The statuses that END a transaction. At most one of these may be set.
 *
 * A deal holds a SET of statuses, which is right for the live ones — a listing can be Active and
 * Sold Conditional, and `Sold` sits alongside `Closed` on the way through. It is not right for
 * these: each is a different account of how the deal finished, and two of them at once is not a
 * richer description, it is a contradiction. `Closed + DFT` says the deal both completed and fell
 * through; `Closed + Void` says it completed and never existed. Both were accepted.
 *
 * `Sold` and `Leased` are deliberately absent — they mark the deal as having been transacted, not
 * finished, and `Sold + Closed` is the ordinary end state of a listing.
 */
/**
 * The statuses that say a deal is STILL RUNNING. None may sit beside a terminal status.
 *
 * TD-027: "Active" and "Closed" were both accepted on one deal - still on the market and finished
 * at the same time. `Sold`, `Leased` and `Secured Firm` are deliberately absent: those mark a deal
 * as transacted rather than still running, and `Sold + Closed` is the ordinary end of a listing.
 * Confirmed with the brokerage 2026-08-30.
 */
export const IN_PROGRESS_STATUSES = ['Active', 'Open', 'Sold Conditional', 'Lease Conditional', 'Secured Conditional', 'Suspended'] as const;

export const TERMINAL_STATUSES = ['Closed', 'DFT', 'Void', 'Mutual Release', 'Terminated', 'Expired'] as const;

export const isTerminalStatus = (status: string): boolean =>
  (TERMINAL_STATUSES as readonly string[]).includes(status);

/**
 * What is wrong with this set of statuses for this transaction type, or null if nothing is.
 *
 * Returns a SENTENCE rather than a boolean because the caller shows it to somebody who has just
 * pressed Save and needs to know which two statuses cannot go together.
 *
 * Two rules, and no more than two on purpose — this is integrity checking, not a workflow engine.
 * Which status may follow which is a matter of how a brokerage works, and inventing that here would
 * be building a state machine nobody asked for on assumptions nobody stated.
 *
 *   1. AT MOST ONE TERMINAL STATUS. See above.
 *   2. THE STATUS MUST BELONG TO THE TYPE. `statusOptionsFor` is already the per-type vocabulary the
 *      screen offers; enforcing it server-side is what stops `Expired` being set on a Residential
 *      Buying deal, or `Secured Firm` on a listing, by a direct API call.
 */
/*
 * TD-051 — THE ONE TYPE WHOSE DATES AND STATUSES ARE CLASSIFIED DIFFERENTLY, SAID OUT LOUD.
 *
 * `Business Sale` is not a listing TYPE — `requiredColumnsFor` and `forbiddenColumnsFor` therefore
 * ask it for Offer Date, Closing Date and Price, and refuse the listing dates. But it IS in the
 * listing STATUS family (`isListingStatusFamily`), so the only statuses it may hold are Active,
 * Sold Conditional, Sold and the rest of the listing set — "Secured Firm" is refused.
 *
 * Both halves are deliberate and correct: a business sale is transacted on an offer and sold like a
 * listing. What was wrong is that nothing said so, and the two refusals arrive one at a time — a
 * person who fixes the dates is then surprised by the statuses, and concludes the type cannot be
 * imported at all. QA found it was the only one of the twelve that failed a corrected second
 * attempt, and a valid combination (offer dates + a listing status) does exist.
 *
 * So this is the sentence, attached to every message that could send somebody down that path. It is
 * derived from the two classifiers rather than naming the type, so a second type that ever sits
 * across them explains itself the same way instead of silently reopening this defect.
 */
export const splitClassificationNote = (type: string | null | undefined): string | null =>
  (isListingStatusFamily(type) && !isListingType(type))
    ? `A ${type} is transacted on an offer but sold like a listing: it takes the OFFER dates `
      + '(Offer Date, Closing Date and Price) together with the LISTING statuses.'
    : null;

export function statusSetProblem(type: string, statuses: readonly string[]): string | null {
  const set = [...new Set(statuses.filter((s) => s !== ''))];
  if (set.length === 0) return null;

  const allowed = statusOptionsFor(type);
  const foreign = set.filter((s) => !allowed.includes(s));
  if (foreign.length) {
    // TD-051 — for a type whose dates and statuses are classified differently, the allowed list
    // alone reads as a contradiction of the date rules the same caller just satisfied.
    const note = splitClassificationNote(type);
    return `${foreign.map((s) => `"${s}"`).join(', ')} ${foreign.length === 1 ? 'is not a status' : 'are not statuses'} a ${type} transaction can have. `
      + `Allowed: ${allowed.join(', ')}.${note ? ' ' + note : ''}`;
  }

  const terminal = set.filter(isTerminalStatus);
  if (terminal.length > 1) {
    return `A transaction cannot be ${terminal.map((s) => `"${s}"`).join(' and ')} at the same time — `
      + 'these describe different ways of ending, so only one may be set.';
  }

  const running = set.filter((s) => (IN_PROGRESS_STATUSES as readonly string[]).includes(s));
  if (terminal.length && running.length) {
    return `A transaction cannot be ${running.map((s) => `"${s}"`).join(' and ')} and `
      + `${terminal.map((s) => `"${s}"`).join(' and ')} at the same time — the first says the deal is `
      + 'still running and the second says it has ended.';
  }

  return null;
}
