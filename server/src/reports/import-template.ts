import { TRANSACTION_TYPES, isListingType, statusOptionsFor } from '../reference/transaction.constants';

/**
 * The bulk-import column contract. Every column the template offers is declared here once —
 * the downloadable template, the parser, the validator and the error report all read from
 * this list, so they can never drift apart.
 */
export interface ImportField {
  /** Column header exactly as it appears in the template. */
  column: string;
  /** Key sent to TransactionsWriteService.store(). */
  key: string;
  type: 'text' | 'number' | 'date' | 'enum' | 'yesno' | 'list';
  /** Required for every row (listing-only/deal-only requirements are handled separately). */
  required?: boolean;
  /** Required only for non-listing deal types (price, dates, commission). */
  requiredForDeals?: boolean;
  /** Required only for listing types. */
  requiredForListings?: boolean;
  options?: readonly string[];
  /** Shown in the template's "Accepted values / format" row. */
  hint: string;
  example: string;
}

export const IMPORT_FIELDS: ImportField[] = [
  { column: 'Transaction Type', key: 'type', type: 'enum', required: true, options: TRANSACTION_TYPES, hint: 'One of: ' + TRANSACTION_TYPES.join(' | '), example: 'Residential Buying' },
  { column: 'Property Address', key: 'property', type: 'text', required: true, hint: 'Free text, max 255 characters', example: '123 Main Street, Toronto, ON' },
  { column: 'Deal Status', key: 'status', type: 'text', hint: 'Must be valid for the transaction type (see the Reference sheet). Blank uses the type default.', example: 'Open' },
  { column: 'Primary Agent', key: 'primary_agent', type: 'text', hint: 'Must match an active agent name exactly. Blank leaves the deal unassigned.', example: 'Ramesh Gollu' },
  { column: 'Split Agents', key: 'team_members', type: 'list', hint: 'Other agents on the deal, separated by commas. Requires Primary Agent.', example: 'Veena Marpina, ashwini' },
  { column: 'Price', key: 'price', type: 'number', requiredForDeals: true, hint: 'Numbers only — no $ or commas. Listing types must leave this blank.', example: '850000' },
  { column: 'Deposit', key: 'deposit', type: 'number', hint: 'Numbers only', example: '25000' },
  { column: 'Offer Date', key: 'offer_date', type: 'date', requiredForDeals: true, hint: 'YYYY-MM-DD. Listing types must leave this blank.', example: '2026-03-14' },
  { column: 'Closing Date', key: 'closing_date', type: 'date', requiredForDeals: true, hint: 'YYYY-MM-DD. Listing types must leave this blank.', example: '2026-06-30' },
  { column: 'Listing Contract Date', key: 'listing_contract_date', type: 'date', requiredForListings: true, hint: 'YYYY-MM-DD. Listing types only.', example: '2026-03-01' },
  { column: 'Listing Expiry Date', key: 'listing_expiry_date', type: 'date', requiredForListings: true, hint: 'YYYY-MM-DD. Listing types only.', example: '2026-09-01' },
  { column: 'Commission Type', key: 'comm_type', type: 'enum', requiredForDeals: true, options: ['%', 'Fixed'], hint: '% or Fixed. Listing types must leave this blank.', example: '%' },
  { column: 'Commission Value', key: 'comm_value', type: 'number', requiredForDeals: true, hint: 'The percentage (2.5) or the fixed amount (5000). Listing types must leave this blank.', example: '2.5' },
  { column: 'MLS Number', key: 'mls_num', type: 'text', hint: 'Free text', example: 'W1234567' },
  { column: 'Payment Type', key: 'payment_type', type: 'enum', options: ['N/A', 'TDB-EFT', 'CTA-BA Transfer', 'Cheque', 'Wire'], hint: 'One of: N/A | TDB-EFT | CTA-BA Transfer | Cheque | Wire', example: 'Cheque' },
  { column: 'Conditional Offer', key: 'conditional_offer', type: 'yesno', hint: 'Yes or No', example: 'No' },
  { column: 'Lawyer Name', key: 'lawyer_name', type: 'text', hint: 'Free text', example: 'A. Solicitor' },
  { column: 'Lawyer Email', key: 'lawyer_email', type: 'text', hint: 'A valid email address', example: 'lawyer@example.com' },
  { column: 'Lawyer Phone', key: 'lawyer_phone', type: 'text', hint: 'Free text', example: '416-555-0100' },
];

export const REQUIRED_COLUMNS = IMPORT_FIELDS.filter((f) => f.required).map((f) => f.column);

/** Which columns must be filled for a given transaction type (drives per-row validation). */
export function requiredColumnsFor(type: string): string[] {
  const listing = isListingType(type);
  return IMPORT_FIELDS.filter((f) =>
    f.required || (listing ? f.requiredForListings : f.requiredForDeals),
  ).map((f) => f.column);
}

/** Columns that must be EMPTY for a given type (listing deals carry no price/offer terms). */
export function forbiddenColumnsFor(type: string): string[] {
  const listing = isListingType(type);
  return IMPORT_FIELDS.filter((f) => (listing ? f.requiredForDeals : f.requiredForListings)).map((f) => f.column);
}

/** Valid deal statuses per transaction type, for the template's Reference sheet. */
export function statusReference(): { type: string; statuses: string[] }[] {
  return TRANSACTION_TYPES.map((t) => ({ type: t, statuses: statusOptionsFor(t) }));
}
