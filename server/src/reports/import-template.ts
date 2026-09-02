import { TRANSACTION_TYPES, isListingType, statusOptionsFor } from '../reference/transaction.constants';

/**
 * The bulk-import column contract. Every column any layout offers is declared here once —
 * the downloadable template, the parser, the validator and the error report all read from
 * this list, so they can never drift apart.
 *
 * Two upload layouts are supported and both are generated into the same template workbook:
 *
 *  1. MULTI-SHEET (full fidelity) — a `Transactions` sheet plus one child sheet per area
 *     (Team Split, Clients, Financial, Adjustments, Conditions). Child rows are tied to
 *     their transaction by the `Ref` column, so a deal may carry any number of clients,
 *     team members or adjustments.
 *
 *  2. ONE-SHEET / CSV (capped fidelity) — a single wide sheet where repeating data lives
 *     in numbered columns ("Client 1 Name", "Team 2 Agent %"). Plain CSV can only ever be
 *     one sheet, so this is the layout that makes CSV usable; the cost is a fixed ceiling
 *     on how many children each deal can carry (see `flatMax`).
 *
 * The parser detects which layout a file uses; the validator and writer work on a single
 * normalised shape either way.
 */

export interface ImportField {
  /** Column header exactly as it appears in the template. */
  column: string;
  /** Key sent to the transaction write path. */
  key: string;
  type: 'text' | 'number' | 'date' | 'enum' | 'yesno' | 'list';
  /** Required for every row (listing-only/deal-only requirements are handled separately). */
  required?: boolean;
  /** Required only for non-listing deal types (price, dates, commission). */
  requiredForDeals?: boolean;
  /** Listing types only: allowed on a listing, refused on an offer-side deal. Unlike
   *  requiredForListings this does not make the column mandatory. */
  listingOnly?: boolean;
  /** Required only for listing types. */
  requiredForListings?: boolean;
  options?: readonly string[];
  /** Shown in the template's "Accepted values / format" row. */
  hint: string;
  example: string;
}

/** How a child row is attached to its transaction in the multi-sheet layout. */
export const REF_COLUMN = 'Ref';

const PAYMENT_TYPES = ['N/A', 'TDB-EFT', 'CTA-BA Transfer', 'Cheque', 'Wire'] as const;
const ACCESS_LEVELS = ['full', 'docs'] as const;
const YES_NO = ['Yes', 'No'] as const;
export const CONDITION_TYPES = ['Financing', 'Home Inspection', 'Sale of Property', 'Status Certificate Review', 'Custom'] as const;
export const ADJUSTMENT_SECTIONS = ['Agent Adjustment', 'Advance Payment', 'Client Referral', 'External Referral'] as const;

// ---------------------------------------------------------------- Transactions
/**
 * The main sheet: one row per transaction. Basic Info, the 1:1 lawyer block and the deal's
 * headline commission. Everything one-to-many lives on a child sheet.
 */
export const IMPORT_FIELDS: ImportField[] = [
  { column: 'Transaction Type', key: 'type', type: 'enum', required: true, options: TRANSACTION_TYPES, hint: 'One of: ' + TRANSACTION_TYPES.join(' | '), example: 'Residential Buying' },
  { column: 'Property Address', key: 'property', type: 'text', required: true, hint: 'Free text, max 255 characters', example: '123 Main Street, Toronto, ON' },
  { column: 'Deal Status', key: 'status', type: 'text', hint: 'Must be valid for the transaction type (see the Reference sheet). Blank uses the type default.', example: 'Open' },
  { column: 'Primary Agent', key: 'primary_agent', type: 'text', hint: 'Must match an active agent name exactly. Blank leaves the deal unassigned.', example: 'Ramesh Gollu' },
  { column: 'Split Agents', key: 'team_members', type: 'list', hint: 'Other agents on the deal, separated by commas. Requires Primary Agent. For per-agent split %, use the Team Split sheet instead.', example: 'Veena Marpina, ashwini' },
  { column: 'List Price', key: 'listing_price', type: 'number', listingOnly: true, hint: 'Listing types only. The asking price. Numbers only. Reports read this, or the sale price once the deal has sold.', example: '1150000' },
  { column: 'Price', key: 'price', type: 'number', requiredForDeals: true, hint: 'Numbers only — no $ or commas. Listing types must leave this blank.', example: '850000' },
  { column: 'Deposit', key: 'deposit', type: 'number', hint: 'Numbers only', example: '25000' },
  { column: 'Offer Date', key: 'offer_date', type: 'date', requiredForDeals: true, hint: 'YYYY-MM-DD. Listing types must leave this blank.', example: '2026-03-14' },
  { column: 'Closing Date', key: 'closing_date', type: 'date', requiredForDeals: true, hint: 'YYYY-MM-DD. Listing types must leave this blank.', example: '2026-06-30' },
  { column: 'Listing Contract Date', key: 'listing_contract_date', type: 'date', requiredForListings: true, hint: 'YYYY-MM-DD. Listing types only.', example: '2026-03-01' },
  { column: 'Listing Expiry Date', key: 'listing_expiry_date', type: 'date', requiredForListings: true, hint: 'YYYY-MM-DD. Listing types only.', example: '2026-09-01' },
  { column: 'Commission Type', key: 'comm_type', type: 'enum', requiredForDeals: true, options: ['%', 'Fixed'], hint: '% or Fixed. Listing types must leave this blank.', example: '%' },
  { column: 'Commission Value', key: 'comm_value', type: 'number', requiredForDeals: true, hint: 'The percentage (2.5) or the fixed amount (5000). Listing types must leave this blank.', example: '2.5' },
  { column: 'MLS Type', key: 'mls_type', type: 'enum', options: ['mls', 'exclusive'], hint: 'mls or exclusive. Blank defaults to mls.', example: 'mls' },
  { column: 'MLS Number', key: 'mls_num', type: 'text', hint: 'Free text', example: 'W1234567' },
  { column: 'MLS Verified', key: 'mls_verified', type: 'yesno', options: YES_NO, hint: 'Yes or No', example: 'No' },
  { column: 'Payment Type', key: 'payment_type', type: 'enum', options: PAYMENT_TYPES, hint: 'One of: ' + PAYMENT_TYPES.join(' | '), example: 'Cheque' },
  { column: 'Conditional Offer', key: 'conditional_offer', type: 'yesno', options: YES_NO, hint: 'Yes or No. Yes means the Conditions sheet rows for this Ref are applied.', example: 'No' },
  { column: 'Inter-Board Listing', key: 'inter_board_enabled', type: 'yesno', options: YES_NO, hint: 'Yes or No', example: 'No' },
  { column: 'Lawyer Name', key: 'lawyer_name', type: 'text', hint: 'Free text', example: 'A. Solicitor' },
  { column: 'Lawyer Email', key: 'lawyer_email', type: 'text', hint: 'A valid email address', example: 'lawyer@example.com' },
  { column: 'Lawyer Phone', key: 'lawyer_phone', type: 'text', hint: 'Free text', example: '416-555-0100' },
  { column: 'Lawyer Address', key: 'lawyer_address', type: 'text', hint: 'Free text', example: '1 Queen St W, Toronto' },
  { column: 'Co-Op Brokerage Name', key: 'brokerage_name', type: 'text', hint: 'The other side’s brokerage. Free text.', example: 'Sample Realty Inc.' },
  { column: 'Co-Op Brokerage Email', key: 'brokerage_email', type: 'text', hint: 'A valid email address', example: 'office@samplerealty.ca' },
  { column: 'Co-Op Brokerage Phone', key: 'brokerage_phone', type: 'text', hint: 'Free text', example: '905-555-0110' },
  { column: 'Co-Op Brokerage Address', key: 'brokerage_address', type: 'text', hint: 'Free text', example: '99 King St E, Oshawa' },
  { column: 'Co-Op Brokerage Agents', key: 'brokerage_agents', type: 'list', hint: 'The other side’s agent name(s), separated by commas.', example: 'J. Cooper, R. Singh' },
];

/** Columns whose value is a lawyer/brokerage/basic field written straight to the transaction. */
export const REQUIRED_COLUMNS = IMPORT_FIELDS.filter((f) => f.required).map((f) => f.column);

// ------------------------------------------------------------------ Financial
/**
 * The 1:1 Financial block. Separate sheet in the multi-sheet layout (the Transactions sheet
 * is already wide); inlined as plain columns in the one-sheet layout.
 */
export const FINANCIAL_FIELDS: ImportField[] = [
  { column: 'Listing Commission %', key: 'listing_comm_pct', type: 'number', hint: 'Listing side percentage, e.g. 2.5', example: '2.5' },
  { column: 'Co-Op Commission %', key: 'coop_comm_pct', type: 'number', hint: 'Co-operating side percentage, e.g. 2.5', example: '2.5' },
  { column: 'Listing Commission Flat', key: 'listing_comm_flat', type: 'number', hint: 'Flat listing-side amount instead of a percentage', example: '5000' },
  { column: 'Co-Op Commission Flat', key: 'coop_comm_flat', type: 'number', hint: 'Flat co-op-side amount instead of a percentage', example: '5000' },
  { column: 'Trust Payable', key: 'trust_payable', type: 'number', hint: 'Amount payable from trust', example: '12000' },
  { column: 'Commission Adjust', key: 'comm_adjust_enabled', type: 'yesno', options: YES_NO, hint: 'Yes to apply the before/after adjustment amounts below', example: 'No' },
  { column: 'Commission Adjust Before', key: 'comm_adjust_before', type: 'number', hint: 'Adjustment applied before the split', example: '0' },
  { column: 'Commission Adjust After', key: 'comm_adjust_after', type: 'number', hint: 'Adjustment applied after the split', example: '0' },
  { column: 'Listing Adjust', key: 'listing_adj_enabled', type: 'yesno', options: YES_NO, hint: 'Yes to apply the listing-side before/after amounts', example: 'No' },
  { column: 'Listing Adjust Before', key: 'listing_adj_before', type: 'number', hint: 'Listing-side adjustment before the split', example: '0' },
  { column: 'Listing Adjust After', key: 'listing_adj_after', type: 'number', hint: 'Listing-side adjustment after the split', example: '0' },
  { column: 'Co-Op Adjust', key: 'coop_adj_enabled', type: 'yesno', options: YES_NO, hint: 'Yes to apply the co-op-side before/after amounts', example: 'No' },
  { column: 'Co-Op Adjust Before', key: 'coop_adj_before', type: 'number', hint: 'Co-op-side adjustment before the split', example: '0' },
  { column: 'Co-Op Adjust After', key: 'coop_adj_after', type: 'number', hint: 'Co-op-side adjustment after the split', example: '0' },
  { column: 'Commission Status', key: 'comm_status', type: 'enum', options: ['Pending', 'Received'], hint: 'Pending or Received', example: 'Pending' },
  { column: 'Agent Paid Status', key: 'comm_paid_status', type: 'enum', options: YES_NO, hint: 'Yes once the agent commission has been paid', example: 'No' },
  // Preconstruction-only
  { column: 'Precon Listing Type', key: 'precon_listing_type', type: 'enum', options: ['mls', 'exclusive'], hint: 'Preconstruction only — mls or exclusive', example: 'mls' },
  { column: 'Precon Term Count', key: 'precon_term_count', type: 'number', hint: 'Preconstruction only — number of commission terms', example: '2' },
  { column: 'Precon Commission %', key: 'precon_comm_pct', type: 'number', hint: 'Preconstruction only', example: '3' },
  { column: 'Precon Net of HST', key: 'precon_net_of_hst', type: 'yesno', options: YES_NO, hint: 'Preconstruction only — Yes if the commission is net of HST', example: 'No' },
  { column: 'Commission Agent', key: 'commission_agent', type: 'text', hint: 'Preconstruction only — the agent the commission is paid to', example: 'Ramesh Gollu' },
];

// ----------------------------------------------------------------- Team Split
export const TEAM_FIELDS: ImportField[] = [
  { column: 'Agent', key: 'name', type: 'text', required: true, hint: 'Must match an active agent name exactly.', example: 'Ramesh Gollu' },
  { column: 'Primary', key: 'is_primary', type: 'yesno', options: YES_NO, hint: 'Yes for the deal’s primary agent. Exactly one per transaction.', example: 'Yes' },
  { column: 'Deal Share %', key: 'split', type: 'number', hint: 'This member’s share of the deal, e.g. 50. Blank means an even share.', example: '50' },
  { column: 'Agent %', key: 'agent_pct', type: 'number', hint: 'The agent’s side of the commission split, e.g. 90. Blank uses the agent’s profile default.', example: '90' },
  { column: 'Brokerage %', key: 'brok_pct', type: 'number', hint: 'The brokerage’s side. Blank is calculated as 100 − Agent %.', example: '10' },
  { column: 'Access', key: 'access', type: 'enum', options: ACCESS_LEVELS, hint: 'full = edits the deal, docs = documents only. The primary agent is always full.', example: 'full' },
];

// -------------------------------------------------------------------- Clients
export const CLIENT_FIELDS: ImportField[] = [
  { column: 'Name', key: 'name', type: 'text', required: true, hint: 'The client’s full name.', example: 'Jane Ng' },
  { column: 'Email', key: 'email', type: 'text', hint: 'A valid email address', example: 'jane@example.com' },
  { column: 'Phone', key: 'phone', type: 'text', hint: 'Free text', example: '416-555-0180' },
];

// ---------------------------------------------------------------- Adjustments
export const ADJUSTMENT_FIELDS: ImportField[] = [
  { column: 'Section', key: 'section', type: 'enum', required: true, options: ADJUSTMENT_SECTIONS, hint: 'One of: ' + ADJUSTMENT_SECTIONS.join(' | '), example: 'Agent Adjustment' },
  { column: 'Agent', key: 'agent', type: 'text', hint: 'Agent the row applies to (Agent Adjustment / Advance Payment / External Referral).', example: 'Ramesh Gollu' },
  { column: 'Client Name', key: 'client_name', type: 'text', hint: 'Client the referral applies to (Client Referral rows).', example: 'Jane Ng' },
  { column: 'Brokerage', key: 'brokerage', type: 'text', hint: 'External Referral rows only — the other brokerage.', example: 'Sample Realty Inc.' },
  { column: 'Amount', key: 'amount', type: 'number', required: true, hint: 'Numbers only. Negative values reduce the payout.', example: '500' },
  { column: 'Is Loan', key: 'is_loan', type: 'yesno', options: YES_NO, hint: 'Agent Adjustment rows only — Yes if this is a loan repayment.', example: 'No' },
  { column: 'Term', key: 'term', type: 'number', hint: 'Preconstruction only — which commission term this row belongs to.', example: '1' },
  { column: 'Paid Type', key: 'paid_type', type: 'enum', options: PAYMENT_TYPES, hint: 'One of: ' + PAYMENT_TYPES.join(' | '), example: 'Cheque' },
  { column: 'Paid Date', key: 'paid_date', type: 'date', hint: 'YYYY-MM-DD', example: '2026-05-02' },
  { column: 'Batch No', key: 'batch_no', type: 'text', hint: 'Free text', example: 'B-1042' },
  { column: 'Paid Status', key: 'paid_status', type: 'text', hint: 'Free text, e.g. Paid / Pending', example: 'Paid' },
  { column: 'Remarks', key: 'remarks', type: 'text', hint: 'Free text', example: 'Marketing contribution' },
];

// ----------------------------------------------------------------- Conditions
export const CONDITION_FIELDS: ImportField[] = [
  { column: 'Condition Type', key: 'type', type: 'enum', required: true, options: CONDITION_TYPES, hint: 'One of: ' + CONDITION_TYPES.join(' | '), example: 'Financing' },
  { column: 'Custom Name', key: 'custom_name', type: 'text', hint: 'Required when Condition Type is Custom.', example: 'Lender approval' },
  { column: 'Deadline', key: 'deadline', type: 'date', hint: 'YYYY-MM-DD', example: '2026-04-01' },
  { column: 'Status', key: 'status', type: 'enum', options: ['Pending', 'Fulfilled', 'Waived'], hint: 'Pending | Fulfilled | Waived', example: 'Pending' },
];

/**
 * A one-to-many area: its own sheet in the multi-sheet layout, numbered repeat columns in
 * the one-sheet layout. `flatMax` is the ceiling the flat layout imposes — the multi-sheet
 * layout has no ceiling, which is exactly why it exists.
 */
export interface ChildSheet {
  sheet: string;
  /** Prefix for flat columns: `${flatPrefix} ${n} ${field.column}`. */
  flatPrefix: string;
  flatMax: number;
  fields: ImportField[];
  /** Key the normalised row carries this collection under. */
  key: 'team' | 'clients' | 'adjustments' | 'conditions';
  note: string;
}

export const CHILD_SHEETS: ChildSheet[] = [
  {
    sheet: 'Team Split', flatPrefix: 'Team', flatMax: 6, fields: TEAM_FIELDS, key: 'team',
    note: 'One row per agent on the deal. Mark exactly one row Primary = Yes. Leave Agent % blank to use the agent’s profile default.',
  },
  {
    sheet: 'Clients', flatPrefix: 'Client', flatMax: 4, fields: CLIENT_FIELDS, key: 'clients',
    note: 'One row per buyer/seller/tenant on the deal.',
  },
  {
    sheet: 'Adjustments', flatPrefix: 'Adjustment', flatMax: 8, fields: ADJUSTMENT_FIELDS, key: 'adjustments',
    note: 'Agent adjustments, advance payments, client referrals and the external referral all live here — pick the area with the Section column.',
  },
  {
    sheet: 'Conditions', flatPrefix: 'Condition', flatMax: 6, fields: CONDITION_FIELDS, key: 'conditions',
    note: 'Only applied when the transaction’s Conditional Offer column is Yes.',
  },
];

/** Sheet name → child definition, for the multi-sheet parser. */
export const CHILD_BY_SHEET = new Map(CHILD_SHEETS.map((c) => [c.sheet.toLowerCase(), c]));

/** The flat column name for repeat `n` (1-based) of a child field. */
export const flatColumn = (child: ChildSheet, n: number, field: ImportField): string =>
  `${child.flatPrefix} ${n} ${field.column}`;

/** Every column the one-sheet layout offers, in order. */
export function flatColumns(): string[] {
  const cols = [...IMPORT_FIELDS.map((f) => f.column), ...FINANCIAL_FIELDS.map((f) => f.column)];
  for (const child of CHILD_SHEETS) {
    for (let n = 1; n <= child.flatMax; n++) {
      for (const f of child.fields) cols.push(flatColumn(child, n, f));
    }
  }
  return cols;
}

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
  return IMPORT_FIELDS.filter((f) => (listing ? f.requiredForDeals : (f.requiredForListings || f.listingOnly))).map((f) => f.column);
}

/** Valid deal statuses per transaction type, for the template's Reference sheet. */
export function statusReference(): { type: string; statuses: string[] }[] {
  return TRANSACTION_TYPES.map((t) => ({ type: t, statuses: statusOptionsFor(t) }));
}
