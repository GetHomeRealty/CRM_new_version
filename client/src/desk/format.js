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
];

export const isListingType = (t) => LISTING_TYPES.includes(t);

export const isPreconType = (t) => t === 'Preconstruction';

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
];

export const emailLooksValid = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((s || '').trim());
