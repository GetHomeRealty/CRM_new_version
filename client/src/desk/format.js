// Formatting helpers ported from the original app.js.

export function parseNumber(val) {
  if (val === null || val === undefined || val === '') return 0;
  return parseFloat(val.toString().replace(/[^0-9.-]+/g, '')) || 0;
}

export function formatCurrency(val) {
  const n = typeof val === 'number' ? val : parseNumber(val);
  return '$' + n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// "$850,000.00" -> for inputs we usually drop the trailing .00 in the list
export function formatPrice(val) {
  return formatCurrency(val).replace('.00', '');
}

export function formatPhone(value) {
  let v = (value || '').replace(/\D/g, '');
  if (v.startsWith('1')) v = v.substring(1);
  if (v.length === 0) return '';
  let res = '+1 ';
  if (v.length > 0) res += v.substring(0, 3);
  if (v.length > 3) res += '-' + v.substring(3, 6);
  if (v.length > 6) res += '-' + v.substring(6, 10);
  return res;
}

export function typeClass(t) {
  const s = (t || '').toLowerCase();
  if (s.includes('commercial') || s.includes('business')) return 'type-commercial';
  if (s.includes('preconstruction') || s.includes('pre-construction')) return 'type-pre';
  if (s.includes('referral')) return 'type-referral';
  if (s.includes('residential buy') || s.includes('lease buyer') || (s.includes('lease') && !s.includes('listing'))) return 'type-res-buy';
  if (s.includes('sell') || s.includes('sale') || s.includes('listing')) return 'type-res-sell';
  return 'info';
}

export const LISTING_TYPES = [
  'Residential Sale Listing',
  'Residential Lease Listing',
  'Commercial Property Sale Listing',
  'Commercial Property Lease Listing',
  'Business Lease Listing',
];

// Display labels (relabel-in-place): stored type string => UI label. Stored
// strings are unchanged on existing rows; only the label differs.
export const TYPE_LABELS = {
  'Preconstruction': 'Pre-construction',
  'Residential Sale Listing': 'Sale Listing',
  'Residential Lease Listing': 'Lease Listing',
  'Business Lease Listing': 'Business Lease',
};
export const typeLabel = (t) => TYPE_LABELS[t] || t;

// Role tier labels (relabel-in-place): stored role string => UI tier name.
export const ROLE_LABELS = { admin: 'Super Admin', manager: 'Admin', agent: 'Agent' };
export const roleLabel = (r) => ROLE_LABELS[r] || (r ? r[0].toUpperCase() + r.slice(1) : '');

export const isListingType = (t) => LISTING_TYPES.includes(t);

// Types that use the listing-style (Listing + Co-op) Financial layout even though
// they aren't listing types elsewhere. Business Sale opts into the dual commission.
export const isListingFinancialType = (t) => isListingType(t) || t === 'Business Sale';

export const isPreconType = (t) => t === 'Preconstruction';

// Commercial lease types carry the extra lease calculator (structure/rent/commission).
export const isCommercialLeaseType = (t) =>
  !!t && /commercial/i.test(t) && /lease/i.test(t);

export const INVOICEABLE_TYPES = [
  'Residential Buying', 'Residential Lease', 'Preconstruction', 'Referral',
  'Commercial Property Buying', 'Commercial Property Lease', 'Business Buying',
];
export const isInvoiceableType = (t) => INVOICEABLE_TYPES.includes(t);

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
  'Business Lease',
  'Business Sale',
  'Business Lease Listing',
];

// ---- Statuses (Transaction Desk v2) -------------------------------------
// Status family is independent of layout: deal-side vs listing-side decides the
// available status set. Business Sale is listing-side for STATUS purposes while
// keeping its existing default layout.
export const STATUS_LISTING_FAMILY = [...LISTING_TYPES, 'Business Sale'];
export const isListingStatusFamily = (t) => STATUS_LISTING_FAMILY.includes(t);

export const STATUS_DEAL = ['Open', 'MPR', 'Closed', 'Mutual Release', 'DFT', 'Void'];
export const STATUS_REFERRAL = ['Open', 'Closed'];
export const AUTO_STATUSES = ['Expired']; // set automatically (listing expiry), never picked manually

// Listing statuses use "Leased/Lease Conditional" for lease listings, "Sold/Sold
// Conditional" otherwise.
export function listingStatuses(type) {
  const lease = /lease/i.test(type);
  return ['Active', lease ? 'Lease Conditional' : 'Sold Conditional', lease ? 'Leased' : 'Sold',
    'Closed', 'MPR', 'Mutual Release', 'DFT', 'Void', 'Suspended', 'Terminated', 'Expired'];
}

export function statusOptionsFor(type) {
  if (type === 'Referral') return STATUS_REFERRAL;
  if (isListingStatusFamily(type)) return listingStatuses(type);
  return STATUS_DEAL;
}

export const defaultStatusFor = (type) => (isListingStatusFamily(type) ? 'Active' : 'Open');

// Valid multi-select groupings (4.3). Selecting within a group disables statuses
// outside it; any single status alone is always valid ("All Singles").
export function statusGroups(type) {
  // Referral: Open/Closed in one group so the user can switch freely between them.
  if (type === 'Referral') return [['Open', 'Closed']];
  if (isListingStatusFamily(type)) {
    const lease = /lease/i.test(type);
    const cond = lease ? 'Lease Conditional' : 'Sold Conditional';
    const sold = lease ? 'Leased' : 'Sold';
    return [
      ['Active', cond, 'MPR', 'Suspended'],
      [sold, 'Closed', 'MPR'],
      [cond, 'Void', 'MPR', 'Mutual Release'],
    ];
  }
  return [
    ['Open', 'MPR'],
    ['Closed', 'MPR', 'Mutual Release', 'DFT', 'Void'],
  ];
}

// Given the current selection, which statuses may be selected (others disabled).
export function allowedStatuses(type, selected) {
  const all = statusOptionsFor(type).filter((s) => !AUTO_STATUSES.includes(s));
  if (!selected || selected.length === 0) return all;
  const matching = statusGroups(type).filter((g) => selected.every((s) => g.includes(s)));
  if (matching.length === 0) return [...selected]; // singles: lock to current selection
  return Array.from(new Set([...matching.flat(), ...selected]));
}

// Map legacy stored statuses to the current vocabulary for display/matching.
export function normalizeStatus(type, s) {
  if (s === 'Hold') return 'Open';
  if (s === 'Mutual release') return 'Mutual Release';
  if (s === 'Sold conditional') return /lease/i.test(type) ? 'Lease Conditional' : 'Sold Conditional';
  if (isListingStatusFamily(type)) {
    if (s === 'Open') return 'Active';
    if (s === 'Sold' && /lease/i.test(type)) return 'Leased';
  }
  return s;
}

export const emailLooksValid = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((s || '').trim());

// ISO week number (ported from getWeekNumber in app.js).
function isoWeek(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}
export const batchNo = (dateStr) => { if (!dateStr) return ''; const d = new Date(dateStr); return `W${isoWeek(d)}-${d.getFullYear()}`; };
export const t4aYear = (dateStr) => (dateStr ? String(new Date(dateStr).getFullYear()) : '');

// Variant-aware commission summary from the backend `financial` block.
export function commissionSummary(fin) {
  if (!fin) return { commission: 0, hst: 0, total: 0 };
  if (fin.variant === 'listing') return fin.totals;
  if (fin.variant === 'precon') return fin.master;
  return { commission: fin.commission, hst: fin.hst, total: fin.total };
}
