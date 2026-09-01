import type { ReportColumn, ReportRow } from './report.types';
import type { EnrichedTxn } from './report-data.service';

/** Column factories — keep labels consistent across every report (e.g. always "Trade No."). */
export const col = {
  tradeNo: (): ReportColumn => ({ key: 'trade_no', label: 'Trade No.', type: 'text', default: true, sortable: true, mandatory: true, width: 12 }),
  offerDate: (): ReportColumn => ({ key: 'offer_date', label: 'Offer Date', type: 'date', default: true, sortable: true, width: 12 }),
  closingDate: (): ReportColumn => ({ key: 'closing_date', label: 'Closing Date', type: 'date', default: true, sortable: true, width: 12 }),
  property: (): ReportColumn => ({ key: 'property', label: 'Property Address', type: 'text', default: true, sortable: true, width: 30 }),
  /** "Type of Deal" — the transaction type; hidden from the table when exactly one deal type is selected. */
  typeOfDeal: (): ReportColumn => ({ key: 'type', label: 'Type of Deal', type: 'text', default: true, sortable: true, width: 16 }),
  paymentType: (): ReportColumn => ({ key: 'payment_type', label: 'Payment Type', type: 'text', default: true, sortable: true, width: 14 }),
  agent: (): ReportColumn => ({ key: 'agent', label: 'Agent Name', type: 'text', default: true, sortable: true, width: 18 }),
  agentNames: (): ReportColumn => ({ key: 'agent_names', label: 'Agent Names', type: 'text', default: true, width: 22 }),
  commission: (): ReportColumn => ({ key: 'comm_display', label: 'Commission % / Amount', type: 'text', default: true, width: 14 }),
  price: (label = 'Price'): ReportColumn => ({ key: 'price', label, type: 'currency', default: true, sortable: true, total: true, width: 14 }),
  listingPrice: (): ReportColumn => ({ key: 'listing_price', label: 'Listing Price', type: 'currency', default: true, sortable: true, total: true, width: 14 }),
  closedPrice: (): ReportColumn => ({ key: 'closed_price', label: 'Closed Price', type: 'currency', default: true, sortable: true, total: true, width: 14 }),

  totalWo: (): ReportColumn => ({ key: 'total_wo', label: 'Commission', type: 'currency', default: true, total: true, width: 16 }),
  totalHst: (): ReportColumn => ({ key: 'total_hst', label: 'HST', type: 'currency', default: true, total: true, width: 14 }),
  totalW: (): ReportColumn => ({ key: 'total_w', label: 'Total Commission', type: 'currency', default: true, total: true, width: 16 }),
  agentWo: (): ReportColumn => ({ key: 'agent_wo', label: 'Agent Commission', type: 'currency', default: true, total: true, width: 16 }),
  coopWo: (): ReportColumn => ({ key: 'coop_wo', label: 'Co-op Payout', type: 'currency', default: true, total: true, width: 14 }),
  agentHst: (): ReportColumn => ({ key: 'agent_hst', label: 'Agent HST', type: 'currency', default: true, total: true, width: 14 }),
  agentW: (): ReportColumn => ({ key: 'agent_w', label: 'Total Agent Commission', type: 'currency', default: true, total: true, width: 16 }),
  brokWo: (): ReportColumn => ({ key: 'brok_wo', label: 'Brokerage Commission', type: 'currency', default: true, total: true, width: 16 }),
  brokHst: (): ReportColumn => ({ key: 'brok_hst', label: 'Brokerage HST', type: 'currency', default: true, total: true, width: 14 }),
  brokW: (): ReportColumn => ({ key: 'brok_w', label: 'Total Brokerage Commission', type: 'currency', default: true, total: true, width: 16 }),

  agentPaymentStatus: (): ReportColumn => ({ key: 'agent_payment_status', label: 'Agent Payment Status', type: 'status', default: true, sortable: true, width: 14 }),
  paymentStatus: (): ReportColumn => ({ key: 'payment_status', label: 'Payment Status', type: 'status', default: true, sortable: true, width: 14 }),
  splitRatio: (): ReportColumn => ({ key: 'split_ratio', label: 'Split Ratio', type: 'text', default: true, sortable: true, width: 10 }),

  advanceAmount: (): ReportColumn => ({ key: 'advance', label: 'Advance Amount Paid', type: 'currency', default: true, total: true, width: 14 }),
  advanceDate: (): ReportColumn => ({ key: 'advance_date', label: 'Advance Paid Date', type: 'date', default: true, sortable: true, width: 12 }),
  balanceDue: (): ReportColumn => ({ key: 'agent_balance', label: 'Balance Due', type: 'currency', default: true, sortable: true, total: true, width: 14 }),
  agentPaid: (label = 'Total Amount Paid'): ReportColumn => ({ key: 'agent_paid', label, type: 'currency', default: true, total: true, width: 14 }),
  agentPaidDate: (): ReportColumn => ({ key: 'agent_paid_date', label: 'Agent Paid Date', type: 'date', default: true, sortable: true, width: 12 }),
  createdDate: (): ReportColumn => ({ key: 'created_at', label: 'Created Date', type: 'date', default: false, sortable: true, width: 12 }),
  updatedDate: (): ReportColumn => ({ key: 'updated_at', label: 'Updated Date', type: 'date', default: false, sortable: true, width: 12 }),

  // ---- documentation reporting ----
  txnId: (): ReportColumn => ({ key: 'txn_id', label: 'Transaction ID', type: 'number', default: true, sortable: true, width: 9 }),
  dealNo: (): ReportColumn => ({ key: 'trade_no', label: 'Deal Number', type: 'text', default: true, sortable: true, mandatory: true, width: 12 }),
  clientName: (): ReportColumn => ({ key: 'client_names', label: 'Client Name', type: 'text', default: true, width: 20 }),
  docStatus: (): ReportColumn => ({ key: 'documentation_status', label: 'Documentation Status', type: 'status', default: true, sortable: true, width: 16 }),
  pendingDocs: (): ReportColumn => ({ key: 'pending_docs', label: 'Pending Documents', type: 'number', default: true, sortable: true, total: true, width: 11 }),
  invalidDocs: (): ReportColumn => ({ key: 'invalid_docs', label: 'Invalid Documents', type: 'number', default: true, sortable: true, total: true, width: 11 }),
  validDocs: (): ReportColumn => ({ key: 'valid_docs', label: 'Valid Documents', type: 'number', default: false, sortable: true, total: true, width: 11 }),
  totalDocs: (): ReportColumn => ({ key: 'total_docs', label: 'Total Required Documents', type: 'number', default: true, sortable: true, total: true, width: 12 }),
  missingMandatory: (): ReportColumn => ({ key: 'missing_mandatory', label: 'Missing Mandatory Documents', type: 'number', default: true, sortable: true, total: true, width: 13 }),
  lastDocUpdate: (): ReportColumn => ({ key: 'last_doc_update', label: 'Last Document Update', type: 'date', default: true, sortable: true, width: 13 }),
  responsibleUser: (): ReportColumn => ({ key: 'responsible_user', label: 'Responsible User / Agent', type: 'text', default: true, sortable: true, width: 16 }),
  recoReady: (): ReportColumn => ({ key: 'reco_audit_ready', label: 'RECO Audit Ready', type: 'status', default: true, sortable: true, width: 11 }),
  recoReadyDate: (): ReportColumn => ({ key: 'reco_ready_date', label: 'Audit Readiness Date', type: 'date', default: true, sortable: true, width: 13 }),
  reviewedBy: (): ReportColumn => ({ key: 'reviewed_by', label: 'Reviewed By', type: 'text', default: true, sortable: true, width: 14 }),
  lastReviewDate: (): ReportColumn => ({ key: 'last_review_date', label: 'Last Review Date', type: 'date', default: true, sortable: true, width: 12 }),

  docName: (): ReportColumn => ({ key: 'doc_name', label: 'Document Name', type: 'text', default: true, sortable: true, width: 24 }),
  docCategory: (): ReportColumn => ({ key: 'doc_category', label: 'Document Category', type: 'text', default: true, sortable: true, width: 14 }),
  docRowStatus: (): ReportColumn => ({ key: 'doc_status', label: 'Document Status', type: 'status', default: true, sortable: true, width: 12 }),
  docRequired: (): ReportColumn => ({ key: 'doc_required', label: 'Required', type: 'status', default: true, sortable: true, width: 9 }),
  docUploaded: (): ReportColumn => ({ key: 'doc_uploaded_at', label: 'Date Uploaded', type: 'date', default: true, sortable: true, width: 12 }),
  docReviewed: (): ReportColumn => ({ key: 'doc_reviewed_at', label: 'Date Reviewed', type: 'date', default: true, sortable: true, width: 12 }),
  docNotes: (): ReportColumn => ({ key: 'doc_notes', label: 'Validation Notes', type: 'text', default: true, width: 22 }),
  docInvalidReason: (): ReportColumn => ({ key: 'invalid_reason', label: 'Invalid Reason', type: 'text', default: true, width: 20 }),
  reminderStatus: (): ReportColumn => ({ key: 'reminder_status', label: 'Reminder Status', type: 'status', default: true, sortable: true, width: 12 }),
};

/**
 * Standard leading columns, in the required order:
 * Type of Deal | Agent Name | Offer Date | Closing Date | Property Address.
 */
export const HEAD = (): ReportColumn[] => [col.typeOfDeal(), col.agent(), col.offerDate(), col.closingDate(), col.property()];
/** Same, but for reports that list every agent on one row instead of a single agent. */
export const HEAD_MULTI = (): ReportColumn[] => [col.typeOfDeal(), col.agentNames(), col.offerDate(), col.closingDate(), col.property()];

/**
 * Universal row mapper — every common enriched field keyed by its column key. Each report
 * selects a subset via its column list; the engine hides unselected columns. Report-specific
 * values (referral party, loan fields, cashback, review/coupon) are merged in per report.
 */
export function baseRow(t: EnrichedTxn): ReportRow {
  return {
    trade_no: t.trade_no,
    offer_date: t.offer_date,
    closing_date: t.closing_date,
    created_at: t.created_at,
    updated_at: t.updated_at,
    property: t.property,
    type: t.type,
    payment_type: t.payment_type,
    agent: t.agent,
    agent_names: t.agent_names.join(', ') || (t.agent ?? null),
    comm_display: t.comm_display,
    price: t.price,
    listing_price: t.listing_price,
    closed_price: t.closed_price,
    total_wo: t.total.commission,
    total_hst: t.total.hst,
    total_w: t.total.total,
    agent_wo: t.agentComm.commission,
    agent_hst: t.agentComm.hst,
    agent_w: t.agentComm.total,
    brok_wo: t.brokerageComm.commission,
    brok_hst: t.brokerageComm.hst,
    brok_w: t.brokerageComm.total,
    coop_wo: t.coopOut.commission,
    coop_hst: t.coopOut.hst,
    coop_w: t.coopOut.total,
    agent_payment_status: t.agent_payment_status,
    payment_status: t.agent_payment_status,
    // every split agent's ratio (single-agent deals show one; teams show all, in order)
    split_ratio: t.splits.map((s) => s.ratio).join(', ') || '—',
    advance: t.advance,
    advance_date: t.advance_date,
    agent_balance: t.agent_balance,
    agent_paid: t.agent_paid,
    agent_paid_date: t.agent_paid_date,
    // documentation reporting (transaction level; document-level rows merge their own fields)
    txn_id: t.id,
    client_names: t.client_names.join(', ') || null,
    documentation_status: t.documentation_status,
    pending_docs: t.doc_counts.pending,
    invalid_docs: t.doc_counts.invalid,
    valid_docs: t.doc_counts.valid,
    total_docs: t.doc_counts.total,
    missing_mandatory: t.doc_counts.missing_mandatory,
    last_doc_update: t.last_doc_update,
    responsible_user: t.agent ?? (t.agent_names[0] ?? null),
    reco_audit_ready: t.reco_audit_ready,
    reco_ready_date: t.reco_audit_ready === 'Yes' ? t.reco_review_at : null,
    reviewed_by: t.reco_audit_remarks ? t.reco_audit_remarks : null,
    last_review_date: t.reco_review_at,
  };
}
