// Formatting helpers ported from the original app.js.

import type { CommissionAmounts, FinancialBreakdown, NumericInput } from '../types';

export function parseNumber(val: NumericInput): number {
  if (val === null || val === undefined || val === '') return 0;
  return parseFloat(val.toString().replace(/[^0-9.-]+/g, '')) || 0;
}

export function formatCurrency(val: NumericInput): string {
  const n = typeof val === 'number' ? val : parseNumber(val);
  return '$' + n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// "$850,000.00" -> for inputs we usually drop the trailing .00 in the list
export function formatPrice(val: NumericInput): string {
  return formatCurrency(val).replace('.00', '');
}

export function formatPhone(value: string | null | undefined): string {
  let v = (value || '').replace(/\D/g, '');
  if (v.startsWith('1')) v = v.substring(1);
  if (v.length === 0) return '';
  let res = '+1 ';
  if (v.length > 0) res += v.substring(0, 3);
  if (v.length > 3) res += '-' + v.substring(3, 6);
  if (v.length > 6) res += '-' + v.substring(6, 10);
  return res;
}

export function typeClass(t: string | null | undefined): string {
  const s = (t || '').toLowerCase();
  if (s.includes('commercial') || s.includes('business')) return 'type-commercial';
  if (s.includes('preconstruction') || s.includes('pre-construction')) return 'type-pre';
  if (s.includes('referral')) return 'type-referral';
  if (s.includes('residential buy') || s.includes('lease buyer') || (s.includes('lease') && !s.includes('listing'))) return 'type-res-buy';
  if (s.includes('sell') || s.includes('sale') || s.includes('listing')) return 'type-res-sell';
  return 'info';
}

export const LISTING_TYPES: string[] = [
  'Residential Sale Listing',
  'Residential Lease Listing',
  'Commercial Property Sale Listing',
  'Commercial Property Lease Listing',
];

// Display labels (relabel-in-place): stored type string => UI label. Stored
// strings are unchanged on existing rows; only the label differs.
export const TYPE_LABELS: Record<string, string> = {
  'Preconstruction': 'Pre-construction',
  'Residential Sale Listing': 'Sale Listing',
  'Residential Lease Listing': 'Lease Listing',
};
export const typeLabel = (t: string): string => TYPE_LABELS[t] || t;

// Role tier labels (relabel-in-place): stored role string => UI tier name.
export const ROLE_LABELS: Record<string, string> = { admin: 'Super Admin', manager: 'Admin', agent: 'Agent', accounting: 'Accounting', documentation: 'Documentation', crm: 'CRM' };
export const roleLabel = (r: string): string => ROLE_LABELS[r] || (r ? r[0].toUpperCase() + r.slice(1) : '');

export const isListingType = (t: string): boolean => LISTING_TYPES.includes(t);

// Types that use the listing-style (Listing + Co-op) Financial layout even though
// they aren't listing types elsewhere. Business Sale opts into the dual commission.
export const isListingFinancialType = (t: string): boolean => isListingType(t) || t === 'Business Sale';

export const isPreconType = (t: string): boolean => t === 'Preconstruction';

// Commercial lease types carry the extra lease calculator (structure/rent/commission).
export const isCommercialLeaseType = (t: string | null | undefined): boolean =>
  !!t && /commercial/i.test(t) && /lease/i.test(t);

export const INVOICEABLE_TYPES: string[] = [
  'Residential Buying', 'Residential Lease', 'Preconstruction', 'Referral',
  'Commercial Property Buying', 'Commercial Property Lease', 'Business Buying',
];
export const isInvoiceableType = (t: string): boolean => INVOICEABLE_TYPES.includes(t);

export const TRANSACTION_TYPES: string[] = [
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
];

// ---- Statuses (Transaction Desk v2) -------------------------------------
// Status family is independent of layout: deal-side vs listing-side decides the
// available status set. Business Sale is listing-side for STATUS purposes while
// keeping its existing default layout.
export const STATUS_LISTING_FAMILY: string[] = [...LISTING_TYPES, 'Business Sale'];
export const isListingStatusFamily = (t: string): boolean => STATUS_LISTING_FAMILY.includes(t);

export const STATUS_DEAL: string[] = ['Open', 'Closed', 'Mutual Release', 'DFT', 'Void'];
// Buy/Lease/Business deal types use a "Secured" lifecycle instead of Active.
export const SECURED_DEAL_TYPES: string[] = [
  'Residential Buying', 'Residential Lease',
  'Commercial Property Buying', 'Commercial Property Lease', 'Business Buying',
];
export const STATUS_DEAL_SECURED: string[] = ['Secured Firm', 'Secured Conditional', 'Closed', 'Mutual Release', 'DFT', 'Void'];
export const STATUS_REFERRAL: string[] = ['Open', 'Closed'];
export const AUTO_STATUSES: string[] = ['Expired']; // set automatically (listing expiry), never picked manually

// Listing statuses use "Leased/Lease Conditional" for lease listings, "Sold/Sold
// Conditional" otherwise.
export function listingStatuses(type: string): string[] {
  const lease = /lease/i.test(type);
  return ['Active', lease ? 'Lease Conditional' : 'Sold Conditional', lease ? 'Leased' : 'Sold',
    'Closed', 'Mutual Release', 'DFT', 'Void', 'Suspended', 'Terminated', 'Expired'];
}

export function statusOptionsFor(type: string): string[] {
  if (type === 'Referral') return STATUS_REFERRAL;
  if (isListingStatusFamily(type)) return listingStatuses(type);
  if (SECURED_DEAL_TYPES.includes(type)) return STATUS_DEAL_SECURED;
  return STATUS_DEAL;
}

/**
 * TD-029 — statuses a person may PICK for a type: the type's vocabulary, less the automatic ones.
 *
 * The create modal used to carry its own `.filter(s => s !== 'Expired' && s !== 'Closed')`, which is
 * how a deal became impossible to file as Closed even though the API accepts it. Only `Expired`
 * is genuinely unpickable, because a listing expiry sets it; excluding `Closed` was a rule nothing
 * else in the system shared.
 */
export const pickableStatusesFor = (type: string): string[] =>
  statusOptionsFor(type).filter((s) => !AUTO_STATUSES.includes(s));

/**
 * TD-029 — every status any transaction type can hold, for filtering a list that mixes them.
 *
 * Derived rather than typed out. The list filter used to hold its own hardcoded eleven, which
 * disagreed with the vocabulary in both directions: it offered `Open` and `Leased` on types that
 * reject them, and — the half nobody noticed — it had no `Sold Conditional`, `Lease Conditional`,
 * `Secured Firm` or `Secured Conditional`, so conditional and secured deals could not be filtered
 * for at all. `Expired` is included here, unlike `pickableStatusesFor`: it cannot be chosen, but a
 * deal certainly reaches it and has to be findable.
 *
 * Sorted, not in first-seen order. Fifteen statuses drawn from every type do not share a lifecycle
 * — one type's `Secured Firm` has no position relative to another's `Sold Conditional` — so the
 * sequence would be an artefact of the order the types happen to be declared in. Alphabetical is
 * the order somebody can predict while looking for one entry, which is what a filter is for.
 */
export const ALL_STATUSES: string[] = Array.from(
  new Set(TRANSACTION_TYPES.flatMap((t) => statusOptionsFor(t))),
).sort((a, b) => a.localeCompare(b));

// Secured deal types start with NO status (the user picks Secured Firm/Conditionally).
export const defaultStatusFor = (type: string): string =>
  (isListingStatusFamily(type) ? 'Active' : (SECURED_DEAL_TYPES.includes(type) ? '' : 'Open'));

// Valid multi-select groupings (4.3). Selecting within a group disables statuses
// outside it; any single status alone is always valid ("All Singles").
export function statusGroups(type: string): string[][] {
  // Referral: Open/Closed in one group so the user can switch freely between them.
  if (type === 'Referral') return [['Open', 'Closed']];
  if (isListingStatusFamily(type)) {
    const lease = /lease/i.test(type);
    const cond = lease ? 'Lease Conditional' : 'Sold Conditional';
    const sold = lease ? 'Leased' : 'Sold';
    return [
      ['Active', cond, 'Suspended'],
      [sold, 'Closed'],
      [cond, 'Void', 'Mutual Release'],
    ];
  }
  return [
    ['Open'],
    ['Closed', 'Mutual Release', 'DFT', 'Void'],
  ];
}

// Given the current selection, which statuses may be selected (others disabled).
export function allowedStatuses(type: string, selected: string[] | null | undefined): string[] {
  const all = statusOptionsFor(type).filter((s) => !AUTO_STATUSES.includes(s));
  if (!selected || selected.length === 0) return all;
  const matching = statusGroups(type).filter((g) => selected.every((s) => g.includes(s)));
  if (matching.length === 0) return [...selected]; // singles: lock to current selection
  return Array.from(new Set([...matching.flat(), ...selected]));
}

// Map legacy stored statuses to the current vocabulary for display/matching.
export function normalizeStatus(type: string, s: string): string {
  // Buy/Lease/Business deal types replaced "Open" with the Secured lifecycle.
  if (SECURED_DEAL_TYPES.includes(type) && (s === 'Open' || s === 'Hold')) return 'Secured Conditional';
  if (s === 'Hold') return 'Open';
  if (s === 'Mutual release') return 'Mutual Release';
  if (s === 'Sold conditional') return /lease/i.test(type) ? 'Lease Conditional' : 'Sold Conditional';
  if (isListingStatusFamily(type)) {
    if (s === 'Open') return 'Active';
    if (s === 'Sold' && /lease/i.test(type)) return 'Leased';
  }
  return s;
}

export const emailLooksValid = (s: string | null | undefined): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((s || '').trim());

/**
 * TD-028 — at least seven digits, however they are punctuated.
 *
 * The same rule and the same threshold as the API's check in `transactions-write.service.ts`, which
 * in turn takes it from `normalizePhone`. A digit count rather than a pattern, so international
 * numbers and extensions are not refused: the point is to catch text that is not a number at all,
 * not to impose a North-American format on a brokerage that does not only write them that way.
 */
export const phoneLooksValid = (s: string | null | undefined): boolean =>
  (s || '').replace(/\D/g, '').length >= 7;

// ISO week number (ported from getWeekNumber in app.js).
function isoWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  // date - yearStart in the original relies on Date→number coercion; getTime() is identical.
  return Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}
export const batchNo = (dateStr: string | null | undefined): string => { if (!dateStr) return ''; const d = new Date(dateStr); return `W${isoWeek(d)}-${d.getFullYear()}`; };
export const t4aYear = (dateStr: string | null | undefined): string => (dateStr ? String(new Date(dateStr).getFullYear()) : '');

// Variant-aware commission summary from the backend `financial` block.
export function commissionSummary(fin?: FinancialBreakdown | null): CommissionAmounts {
  if (!fin) return { commission: 0, hst: 0, total: 0 };
  // The `?? {…}` guards only fire on a malformed block; the backend always
  // provides `totals`/`master` for those variants, so behaviour is unchanged.
  if (fin.variant === 'listing') return fin.totals ?? { commission: 0, hst: 0, total: 0 };
  if (fin.variant === 'precon') return fin.master ?? { commission: 0, hst: 0, total: 0 };
  return { commission: fin.commission ?? 0, hst: fin.hst ?? 0, total: fin.total ?? 0 };
}
