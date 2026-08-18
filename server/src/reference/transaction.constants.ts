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
export function statusSetProblem(type: string, statuses: readonly string[]): string | null {
  const set = [...new Set(statuses.filter((s) => s !== ''))];
  if (set.length === 0) return null;

  const allowed = statusOptionsFor(type);
  const foreign = set.filter((s) => !allowed.includes(s));
  if (foreign.length) {
    return `${foreign.map((s) => `"${s}"`).join(', ')} ${foreign.length === 1 ? 'is not a status' : 'are not statuses'} a ${type} transaction can have. `
      + `Allowed: ${allowed.join(', ')}.`;
  }

  const terminal = set.filter(isTerminalStatus);
  if (terminal.length > 1) {
    return `A transaction cannot be ${terminal.map((s) => `"${s}"`).join(' and ')} at the same time — `
      + 'these describe different ways of ending, so only one may be set.';
  }

  return null;
}
