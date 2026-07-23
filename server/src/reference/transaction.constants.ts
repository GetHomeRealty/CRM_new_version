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
