import type { ReportColumn, ReportFilterDef, ReportCategory, ReportSectionDef, ReportFilters, ReportRow } from './report.types';
import type { EnrichedTxn } from './report-data.service';
import { col, baseRow, HEAD, HEAD_MULTI } from './report-columns';
import { isAmendment, remainingTime } from './report-documents';

/** A report definition: metadata + optional row predicate / row-value extension / sectioning. */
export interface ReportDef {
  type: string;
  name: string;
  description: string;
  category: ReportCategory;
  columns: ReportColumn[];
  /** report-specific filters (global filters are added by the engine for every report). */
  filters: ReportFilterDef[];
  sections?: ReportSectionDef[];
  defaultSort: { key: string; dir: 'asc' | 'desc' };
  /** Row inclusion beyond the global filters. */
  predicate?: (t: EnrichedTxn, f: ReportFilters) => boolean;
  /** Row values (defaults to baseRow); return report-specific keys merged over the base. */
  map?: (t: EnrichedTxn) => ReportRow;
  /** Emit MULTIPLE rows per transaction (e.g. one row per split agent). Overrides `map`. */
  expand?: (t: EnrichedTxn) => ReportRow[];
  /** Section key for section-grouped reports (rendered as in-table horizontal sections). */
  section?: (t: EnrichedTxn) => string | null;
  /** Section keys whose subtotal row is suppressed (e.g. Mutual Release). */
  sectionsWithoutTotals?: string[];
  /** Section-grouped reports are presented in fixed section order — sorting is disabled. */
  noSort?: boolean;
  /** Rows can be expanded to reveal the deal's individual documents (documentation reports). */
  expandable?: boolean;
  /** Non-transaction data source (Agent Loan report / reminder history). */
  custom?: 'loans' | 'reminders';
}

/**
 * Agent commission payment statuses, as derived in ReportDataService.agentPaymentStatus():
 * Agent FAQ Center → Agent Commission Paid Status, else all/some/no split agents paid.
 */
export const AGENT_PAYMENT_STATUSES = ['Paid', 'Partially Paid', 'Pending', 'Upcoming', 'Not Applicable'];

/** Reminder types recorded on the reminder log (individual / whole deal / bulk). */
export const REMINDER_TYPES = ['individual', 'deal_pending', 'deal_invalid', 'deal_all', 'bulk_pending', 'bulk_invalid', 'bulk_all'];

/** Transaction-level documentation statuses (§1) — pending and invalid stay separate. */
export const DOCUMENTATION_STATUSES = ['Pending Documentation', 'Invalid Documentation'];
/** Condition expiry statuses (§4), computed from the condition status + deadline. */
export const EXPIRY_STATUSES = ['Active', 'Expiring Soon', 'Expired', 'Fulfilled', 'Waived', 'Extended'];

/**
 * RECO audit readiness (§2). A deal is Ready only when it is explicitly marked ready AND
 * nothing is outstanding: no invalid documents and no mandatory document left unvalidated.
 * The explicit flag alone is not enough — the spec requires all mandatory documentation and
 * compliance requirements to be completed and validated.
 */
export function recoReady(t: EnrichedTxn): string {
  const clean = t.doc_counts.invalid === 0 && t.doc_counts.missing_mandatory === 0;
  return t.reco_audit_ready === 'Yes' && clean ? 'Yes' : 'No';
}

// ---- shared filter descriptors (report-specific; global ones are injected by the engine) ----
const statusFilter = (label: string, values: string[]): ReportFilterDef => ({
  key: 'status', label, type: 'select', options: [{ value: '', label: 'All' }, ...values.map((v) => ({ value: v, label: v }))],
});
const dateRange = (key: string, label: string): ReportFilterDef => ({ key, label, type: 'daterange' });

// ---- shared column groups ----
const TOTAL3 = (): ReportColumn[] => [col.totalWo(), col.totalHst(), col.totalW()];
const AGENT3 = (): ReportColumn[] => [col.agentWo(), col.agentHst(), col.agentW()];
const BROK3 = (): ReportColumn[] => [col.brokWo(), col.brokHst(), col.brokW()];

/** The 14 reports. */
export const REPORTS: ReportDef[] = [
  // 1 -----------------------------------------------------------------
  {
    type: 'yearly-deal-summary',
    name: 'Yearly Deal & Commission Summary',
    description: 'Year-wise totals of deals, deal types and complete transaction commission information.',
    category: 'Deal Reports',
    columns: [
      ...HEAD(), col.tradeNo(), col.commission(),
      ...TOTAL3(), ...AGENT3(), ...BROK3(), col.agentPaymentStatus(), col.paymentType(),
    ],
    filters: [],
    defaultSort: { key: 'closing_date', dir: 'desc' },
  },
  // 2 -----------------------------------------------------------------
  {
    type: 'team-split-deals',
    name: 'Team Split Deals Report',
    description: 'Team/multi-agent deals split into one row per agent, with each agent’s split ratio and commission.',
    category: 'Deal Reports',
    columns: [
      ...HEAD(), col.tradeNo(),
      { key: 'split_no', label: 'Split', type: 'text', default: true, width: 11 },
      col.splitRatio(), ...AGENT3(), ...TOTAL3(), ...BROK3(), col.paymentStatus(), col.paymentType(),
    ],
    filters: [],
    defaultSort: { key: 'closing_date', dir: 'desc' },
    predicate: (t) => t.is_team,
    /**
     * One row per split agent ("Split 1 of 3", "Split 2 of 3", …). Agent + brokerage figures
     * are that agent's own share; the TRANSACTION-level totals are carried on the first split
     * row only so footer totals aren't multiplied by the number of agents.
     */
    expand: (t) => t.splits.map((s, i) => ({
      ...baseRow(t),
      agent: s.name,
      split_no: `Split ${i + 1} of ${t.splits.length}`,
      split_ratio: s.ratio,
      agent_wo: s.agent.commission, agent_hst: s.agent.hst, agent_w: s.agent.total,
      brok_wo: s.brokerage.commission, brok_hst: s.brokerage.hst, brok_w: s.brokerage.total,
      total_wo: i === 0 ? t.total.commission : null,
      total_hst: i === 0 ? t.total.hst : null,
      total_w: i === 0 ? t.total.total : null,
    })),
  },
  // 3 -----------------------------------------------------------------
  {
    type: 'brokerage-split-commission',
    name: 'Brokerage Split Ratio Commission Report',
    description: 'Transactions grouped by agent/brokerage commission split ratio (90/10, 95/5, …).',
    category: 'Commission Reports',
    columns: [
      ...HEAD(), col.tradeNo(), col.splitRatio(),
      col.totalW(), col.totalHst(), col.totalWo(), col.brokW(), col.brokHst(), col.brokWo(), col.paymentType(),
    ],
    filters: [{ key: 'split_ratio', label: 'Split Ratio', type: 'multiselect', dynamic: true }],
    defaultSort: { key: 'closing_date', dir: 'desc' },
    predicate: (t, f) => {
      const sel = f.split_ratio ?? [];
      return sel.length === 0 || t.splits.some((s) => sel.includes(s.ratio));
    },
  },
  // 4 -----------------------------------------------------------------
  {
    type: 'brokerage-lead-conversion',
    name: 'Brokerage Lead Conversion Report',
    description: 'Converted deals that originated from brokerage-provided leads.',
    category: 'Commission Reports',
    columns: [
      ...HEAD(), col.tradeNo(),
      { key: 'lead_source', label: 'Lead Source', type: 'text', default: true, width: 16 },
      { key: 'lead_assigned_date', label: 'Lead Assigned Date', type: 'date', default: true, sortable: true, width: 12 },
      { key: 'lead_converted_date', label: 'Lead Converted Date', type: 'date', default: true, sortable: true, width: 12 },
      col.price('Transaction Price'), ...TOTAL3(), col.agentW(), col.brokW(), col.paymentStatus(), col.paymentType(),
    ],
    filters: [],
    defaultSort: { key: 'lead_converted_date', dir: 'desc' },
    predicate: (t) => !!t.lead_source && /broker/i.test(t.lead_source) && !!t.lead_converted_date,
    map: (t) => ({ ...baseRow(t), lead_source: t.lead_source, lead_assigned_date: t.lead_assigned_date, lead_converted_date: t.lead_converted_date }),
  },
  // 5 -----------------------------------------------------------------
  {
    type: 'agent-advance-payments',
    name: 'Agent Advance Payment Report',
    description: 'Advance commission payments made by the brokerage to agents, with balances.',
    category: 'Payment Reports',
    columns: [
      ...HEAD(), col.tradeNo(),
      col.totalW(), col.totalHst(), col.totalWo(), col.agentW(), col.agentHst(), col.agentWo(),
      col.advanceAmount(), col.advanceDate(), col.balanceDue(),
      { key: 'balance_payment_status', label: 'Balance Payment Status', type: 'status', default: true, sortable: true, width: 14 },
      { key: 'balance_paid_date', label: 'Balance Paid Date', type: 'date', default: true, width: 12 }, col.paymentType(),
    ],
    filters: [statusFilter('Balance Status', ['Paid', 'Pending']), dateRange('advance_paid', 'Advance Paid Date')],
    defaultSort: { key: 'advance_date', dir: 'desc' },
    predicate: (t, f) => {
      if (t.advance <= 0) return false;
      const s = t.agent_balance <= 0 ? 'Paid' : 'Pending';
      return !f.status || f.status === s;
    },
    map: (t) => ({ ...baseRow(t), balance_payment_status: t.agent_balance <= 0 ? 'Paid' : 'Pending', balance_paid_date: t.agent_balance <= 0 ? t.agent_paid_date : null }),
  },
  // 6 -----------------------------------------------------------------
  {
    type: 'agent-paid-brokerage-pending',
    name: 'Agent Paid – Brokerage Receivable Pending Report',
    description: 'Deals where the agent has been paid but the commission is not yet transferred from CTA to BA.',
    category: 'Payment Reports',
    columns: [
      ...HEAD(), col.tradeNo(),
      col.totalW(), col.agentW(), col.agentPaid('Agent Paid Amount'), col.agentPaidDate(),
      col.brokW(), { key: 'cta_to_ba', label: 'CTA to BA', type: 'status', default: true, sortable: true, width: 10 },
      { key: 'brokerage_balance', label: 'Brokerage Balance Pending', type: 'currency', default: true, total: true, sortable: true, width: 16 },
      col.agentPaymentStatus(), col.paymentType(),
    ],
    filters: [],
    defaultSort: { key: 'closing_date', dir: 'desc' },
    // Agent commission fully paid (Agent FAQ Center), but the CTA → BA transfer has not been
    // done (Admin Activities → CTA to BA = No; a null/blank CTA row is treated as "No").
    predicate: (t) => t.agent_payment_status === 'Paid' && t.cta_to_ba === 'No',
    map: (t) => ({ ...baseRow(t), cta_to_ba: t.cta_to_ba, brokerage_balance: t.brokerageComm.total }),
  },
  // 7 -----------------------------------------------------------------
  {
    type: 'agent-partial-payment',
    name: 'Agent Partial Payment & Balance Due Report',
    description: 'Transactions where agent commission is partially paid and a balance remains.',
    category: 'Payment Reports',
    columns: [
      ...HEAD(), col.tradeNo(),
      col.agentWo(), col.agentHst(), col.agentW(), col.advanceAmount(),
      { key: 'other_paid', label: 'Other Amount Paid', type: 'currency', default: true, total: true, width: 14 },
      col.agentPaid('Total Amount Paid'), col.balanceDue(), { key: 'last_payment_date', label: 'Last Payment Date', type: 'date', default: true, sortable: true, width: 12 },
      col.paymentStatus(), col.paymentType(),
    ],
    filters: [statusFilter('Status', ['Partially Paid', 'Advance Paid', 'Balance Pending', 'Fully Paid'])],
    defaultSort: { key: 'closing_date', dir: 'desc' },
    predicate: (t, f) => {
      const status = partialStatus(t);
      if (f.status) return status === f.status;
      return t.agent_balance > 0;
    },
    map: (t) => ({ ...baseRow(t), other_paid: t.agent_paid, last_payment_date: t.agent_paid_date, payment_status: partialStatus(t) }),
  },
  // 8 -----------------------------------------------------------------
  {
    type: 'client-cashback',
    name: 'Client Cashback Payment Report',
    description: 'Client cashback payments — completed, scheduled or pending.',
    category: 'Client and Referral Reports',
    columns: [
      ...HEAD(), col.tradeNo(),
      { key: 'client_name', label: 'Client Name', type: 'text', default: true, width: 18 },
      { key: 'cashback_amount', label: 'Cashback Amount', type: 'currency', default: true, total: true, sortable: true, width: 14 },
      { key: 'cashback_scheduled_date', label: 'Cashback Scheduled Date', type: 'date', default: true, width: 12 },
      { key: 'cashback_paid_date', label: 'Cashback Paid Date', type: 'date', default: true, sortable: true, width: 12 },
      { key: 'cashback_status', label: 'Cashback Status', type: 'status', default: true, sortable: true, width: 12 }, col.paymentType(),
    ],
    filters: [statusFilter('Cashback Status', ['Completed', 'Scheduled', 'Pending']), dateRange('cashback', 'Cashback Paid Date')],
    defaultSort: { key: 'closing_date', dir: 'desc' },
    predicate: (t, f) => {
      if (t.cashback.total <= 0) return false;
      return !f.status || cashbackStatus(t) === f.status;
    },
    map: (t) => ({
      ...baseRow(t),
      client_name: t.cashback.rows.map((r) => r.client_name).filter(Boolean).join(', ') || '—',
      cashback_amount: t.cashback.total,
      cashback_scheduled_date: null,
      cashback_paid_date: t.cashback.rows.map((r) => r.paid_date).filter(Boolean).sort().slice(-1)[0] ?? null,
      cashback_status: cashbackStatus(t),
    }),
  },
  // 9 -----------------------------------------------------------------
  {
    type: 'referral-payment',
    name: 'Referral Payment Report',
    description: 'External referral payments — completed, scheduled or pending.',
    category: 'Client and Referral Reports',
    columns: [
      ...HEAD(), col.tradeNo(),
      { key: 'referral_party', label: 'Referral Party', type: 'text', default: true, width: 18 },
      { key: 'referral_pct', label: 'Referral %', type: 'percent', default: true, width: 10 },
      { key: 'referral_wo', label: 'Referral Amount Without HST', type: 'currency', default: true, total: true, width: 16 },
      { key: 'referral_hst', label: 'Referral HST', type: 'currency', default: true, total: true, width: 12 },
      { key: 'referral_w', label: 'Referral Amount With HST', type: 'currency', default: true, total: true, sortable: true, width: 16 },
      { key: 'referral_paid_date', label: 'Paid Date', type: 'date', default: true, sortable: true, width: 12 },
      { key: 'referral_status', label: 'Referral Payment Status', type: 'status', default: true, sortable: true, width: 12 }, col.paymentType(),
    ],
    filters: [statusFilter('Referral Status', ['Completed', 'Scheduled', 'Pending']), dateRange('referral', 'Referral Paid Date')],
    defaultSort: { key: 'closing_date', dir: 'desc' },
    predicate: (t, f) => {
      if (!t.referral) return false;
      return !f.status || t.referral.status === f.status;
    },
    map: (t) => ({
      ...baseRow(t),
      referral_party: t.referral?.party ?? '—',
      referral_pct: t.referral?.pct ?? null,
      referral_wo: t.referral?.amount ?? 0,
      referral_hst: t.referral?.hst ?? 0,
      referral_w: t.referral?.total ?? 0,
      referral_paid_date: t.referral?.paid_date ?? null,
      referral_status: t.referral?.status ?? '—',
    }),
  },
  // 10 ----------------------------------------------------------------
  {
    type: 'sales-statement',
    name: 'Sales Statement Report',
    description: 'Per-deal sales statement with commission and agent-paid breakdown.',
    category: 'Deal Reports',
    columns: [
      ...HEAD(), col.tradeNo(), col.price(), col.commission(), ...TOTAL3(),
      { key: 'agent_paid_wo', label: 'Agent Commission Paid Without HST', type: 'currency', default: true, total: true, width: 16 },
      { key: 'agent_paid_hst', label: 'Agent Commission Paid HST', type: 'currency', default: true, total: true, width: 14 },
      { key: 'agent_paid_w', label: 'Agent Commission Paid With HST', type: 'currency', default: true, total: true, width: 16 },
      col.agentPaidDate(), col.paymentStatus(), col.paymentType(),
    ],
    filters: [statusFilter('Payment Status', AGENT_PAYMENT_STATUSES)],
    defaultSort: { key: 'closing_date', dir: 'desc' },
    predicate: (t, f) => !f.status || t.agent_payment_status === f.status,
    map: (t) => {
      const ratio = t.agentComm.total > 0 ? t.agent_paid / t.agentComm.total : 0;
      return {
        ...baseRow(t),
        agent_paid_w: t.agent_paid,
        agent_paid_wo: Math.round(t.agentComm.commission * ratio * 100) / 100,
        agent_paid_hst: Math.round(t.agentComm.hst * ratio * 100) / 100,
        payment_status: t.agent_payment_status,
      };
    },
  },
  // 11 ----------------------------------------------------------------
  {
    type: 'transaction-payment-status',
    name: 'Transaction Payment Status Report',
    description: 'Transactions grouped into in-table sections by payment/close state.',
    category: 'Payment Reports',
    columns: [
      ...HEAD(), col.tradeNo(), col.price(), col.commission(),
      col.totalW(), col.totalHst(), col.brokW(),
      { key: 'adjustments', label: 'Adjustments', type: 'currency', default: true, total: true, width: 12 },
      { key: 'agent_paid_w', label: 'Agent Commission Paid With HST', type: 'currency', default: true, total: true, width: 16 },
      { key: 'paid_date', label: 'Paid Date', type: 'date', default: true, width: 12 },
      col.paymentStatus(), col.paymentType(),
    ],
    sections: [
      { key: 'closed_paid', label: 'Closed & Paid' },
      { key: 'closed_pending', label: 'Closed but Payment Pending' },
      { key: 'yet_to_close', label: 'Yet to Be Closed' },
      { key: 'mutual_release', label: 'Mutual Release' },
    ],
    sectionsWithoutTotals: ['mutual_release'],
    noSort: true,
    filters: [statusFilter('Payment Status', AGENT_PAYMENT_STATUSES)],
    defaultSort: { key: 'closing_date', dir: 'desc' },
    section: (t) => paymentSection(t),
    predicate: (t, f) => (!f.status || t.agent_payment_status === f.status),
    map: (t) => ({ ...baseRow(t), adjustments: t.adjustments_total, agent_paid_w: t.agent_paid, paid_date: t.agent_paid_date, payment_status: t.agent_payment_status }),
  },
  // 12 ----------------------------------------------------------------
  {
    type: 'agent-loan',
    name: 'Agent Loan Report',
    description: 'Agent loans and repayments with outstanding balances.',
    category: 'Agent Reports',
    custom: 'loans',
    columns: [
      { key: 'agent', label: 'Agent Name', type: 'text', default: true, sortable: true, mandatory: true, width: 20 },
      { key: 'loan_amount', label: 'Original Loan Amount', type: 'currency', default: true, sortable: true, total: true, width: 16 },
      { key: 'loan_repaid', label: 'Total Repaid', type: 'currency', default: true, total: true, width: 14 },
      { key: 'outstanding', label: 'Outstanding Balance', type: 'currency', default: true, sortable: true, total: true, width: 16 },
      { key: 'repayment_count', label: 'Repayments', type: 'number', default: true, width: 10 },
      { key: 'last_repayment', label: 'Last Repayment', type: 'date', default: true, sortable: true, width: 12 },
      { key: 'status', label: 'Loan Status', type: 'status', default: true, sortable: true, width: 12 },
    ],
    filters: [statusFilter('Loan Status', ['Active', 'Partially Repaid', 'Fully Repaid'])],
    defaultSort: { key: 'agent', dir: 'asc' },
  },
  // 13 ----------------------------------------------------------------
  {
    type: 'deal-list-price-comparison',
    name: 'Deal List & Price Comparison Report',
    description: 'Complete deal list with listing price and closed price.',
    category: 'Deal Reports',
    columns: [
      ...HEAD(), col.tradeNo(), col.listingPrice(), col.closedPrice(),
      col.commission(), ...TOTAL3(), col.paymentStatus(), col.paymentType(),
    ],
    filters: [],
    defaultSort: { key: 'closing_date', dir: 'desc' },
    map: (t) => ({ ...baseRow(t), listing_price: t.listing_price ?? t.closed_price }),
  },
  // 14 ----------------------------------------------------------------
  {
    type: 'google-review-gift-coupon',
    name: 'Google Review & Gift Coupon Report',
    description: 'Review emails sent/received and gift coupons issued per deal.',
    category: 'Review and Marketing Reports',
    columns: [
      ...HEAD(), col.tradeNo(),
      { key: 'review_email_sent', label: 'Review Email Sent', type: 'text', default: true, width: 10 },
      { key: 'review_email_sent_at', label: 'Review Email Sent Date', type: 'date', default: true, sortable: true, width: 12 },
      { key: 'review_received', label: 'Review Received', type: 'text', default: true, width: 10 },
      { key: 'review_received_at', label: 'Review Received Date', type: 'date', default: true, sortable: true, width: 12 },
      { key: 'gift_coupon_issued', label: 'Gift Coupon Issued', type: 'text', default: true, width: 10 },
      { key: 'gift_coupon_issued_at', label: 'Gift Coupon Issued Date', type: 'date', default: true, sortable: true, width: 12 },
      { key: 'gift_coupon_value', label: 'Gift Coupon Value', type: 'currency', default: true, total: true, sortable: true, width: 12 },
      { key: 'review_coupon_status', label: 'Review / Coupon Status', type: 'status', default: true, width: 14 }, col.paymentType(),
    ],
    filters: [statusFilter('Status', ['Review Email Sent', 'Review Received', 'Gift Coupon Issued', 'Review Pending', 'Coupon Pending'])],
    defaultSort: { key: 'closing_date', dir: 'desc' },
    predicate: (t, f) => {
      const has = !!t.review_email_sent_at || !!t.review_received_at || !!t.gift_coupon_issued_at || t.gift_coupon_value != null;
      if (!has) return false;
      return !f.status || reviewMatches(t, f.status);
    },
    map: (t) => ({
      ...baseRow(t),
      review_email_sent: t.review_email_sent_at ? 'Yes' : 'No',
      review_email_sent_at: t.review_email_sent_at,
      review_received: t.review_received_at ? 'Yes' : 'No',
      review_received_at: t.review_received_at,
      gift_coupon_issued: t.gift_coupon_issued_at ? 'Yes' : 'No',
      gift_coupon_issued_at: t.gift_coupon_issued_at,
      gift_coupon_value: t.gift_coupon_value,
      review_coupon_status: reviewStatus(t),
    }),
  },

  // ===================================================================
  // Documentation and Compliance Reports
  // ===================================================================
  // 15 ----------------------------------------------------------------
  {
    type: 'deal-documentation-status',
    name: 'Deal Documentation Status Report',
    description: 'Every deal with its documentation status and separate pending / invalid document counts.',
    category: 'Documentation and Compliance Reports',
    columns: [
      col.txnId(), col.dealNo(), col.property(), col.typeOfDeal(), col.agent(), col.clientName(),
      col.docStatus(), col.pendingDocs(), col.invalidDocs(), col.validDocs(), col.totalDocs(),
      col.missingMandatory(), col.lastDocUpdate(), col.responsibleUser(),
    ],
    filters: [statusFilter('Documentation Status', DOCUMENTATION_STATUSES)],
    defaultSort: { key: 'pending_docs', dir: 'desc' },
    // Pending and Invalid documentation are the two reportable categories (§1).
    predicate: (t, f) => {
      if (t.doc_counts.total === 0) return false;
      if (!f.status) return t.doc_counts.pending > 0 || t.doc_counts.invalid > 0;
      if (f.status === 'Pending Documentation') return t.doc_counts.pending > 0;
      if (f.status === 'Invalid Documentation') return t.doc_counts.invalid > 0;
      return t.documentation_status === f.status;
    },
    // A deal is expanded via GET /api/reports/documents/:transactionId, which returns its
    // individual documents split into pending / invalid / valid groups.
    expandable: true,
  },
  // 16 ----------------------------------------------------------------
  {
    type: 'reco-audit-readiness',
    name: 'RECO Audit Readiness Report',
    description: 'Deals by RECO audit readiness, with outstanding documentation and review details.',
    category: 'Documentation and Compliance Reports',
    columns: [
      col.txnId(), col.dealNo(), col.property(), col.agent(), col.typeOfDeal(),
      col.recoReady(), col.pendingDocs(), col.invalidDocs(), col.missingMandatory(),
      col.recoReadyDate(), col.reviewedBy(), col.lastReviewDate(),
    ],
    // "RECO Audit Ready" — All / Yes / No (§2)
    filters: [{ key: 'reco_ready', label: 'RECO Audit Ready', type: 'select', options: [{ value: '', label: 'All' }, { value: 'Yes', label: 'Yes' }, { value: 'No', label: 'No' }] }],
    defaultSort: { key: 'closing_date', dir: 'desc' },
    expandable: true,
    predicate: (t, f) => !f.reco_ready || recoReady(t) === f.reco_ready,
    map: (t) => ({ ...baseRow(t), reco_audit_ready: recoReady(t), reco_ready_date: recoReady(t) === 'Yes' ? t.reco_review_at : null }),
  },
  // 17 ----------------------------------------------------------------
  {
    type: 'amendment-documentation',
    name: 'Amendment Documentation Report',
    description: 'Every amendment document, listed separately when a deal holds more than one.',
    category: 'Documentation and Compliance Reports',
    columns: [
      col.txnId(), col.dealNo(), col.property(), col.agent(),
      col.docName(), { key: 'amendment_type', label: 'Amendment Type', type: 'text', default: true, sortable: true, width: 14 },
      col.docRowStatus(), col.docUploaded(), col.docReviewed(), col.reviewedBy(),
      col.docNotes(), col.reminderStatus(),
    ],
    filters: [statusFilter('Amendment Status', ['Pending', 'Invalid', 'Valid', 'Missing'])],
    defaultSort: { key: 'doc_uploaded_at', dir: 'desc' },
    predicate: (t, f) => {
      const amendments = t.docs.filter((d) => isAmendment(d.title));
      if (f.status === 'Missing') return amendments.length === 0;
      if (!amendments.length) return false;
      return !f.status || amendments.some((d) => d.status === f.status);
    },
    // one row per amendment document (§3: display them separately within a transaction)
    expand: (t) => {
      const amendments = t.docs.filter((d) => isAmendment(d.title));
      if (!amendments.length) {
        return [{ ...baseRow(t), doc_name: '— none uploaded —', amendment_type: 'Missing', doc_status: 'Missing', doc_uploaded_at: null, doc_reviewed_at: null, doc_notes: null, reminder_status: 'Not Sent' }];
      }
      return amendments.map((d) => ({
        ...baseRow(t),
        doc_id: d.id, doc_name: d.title, amendment_type: d.is_condition ? 'Condition Amendment' : d.category,
        doc_status: d.status, doc_uploaded_at: d.uploaded_at, doc_reviewed_at: d.reviewed_at,
        doc_notes: d.remarks, reminder_status: d.reminder_sent ? 'Reminder Sent' : 'Not Sent',
      }));
    },
  },
  // 18 ----------------------------------------------------------------
  {
    type: 'conditional-offers',
    name: 'Conditional Offers and Expiry Report',
    description: 'Conditional deals with condition expiry status, waiver and amendment documentation.',
    category: 'Documentation and Compliance Reports',
    columns: [
      col.txnId(), col.dealNo(), col.property(), col.agent(), col.typeOfDeal(),
      { key: 'conditional_offer', label: 'Conditional Offer', type: 'status', default: true, sortable: true, width: 10 },
      { key: 'condition_type', label: 'Condition Type', type: 'text', default: true, sortable: true, width: 16 },
      { key: 'condition_expiry', label: 'Conditional Expiry Date', type: 'date', default: true, sortable: true, width: 13 },
      { key: 'expiry_status', label: 'Expiry Status', type: 'status', default: true, sortable: true, width: 12 },
      { key: 'remaining_time', label: 'Remaining Time', type: 'text', default: true, width: 12 },
      { key: 'waiver_required', label: 'Waiver Required', type: 'status', default: true, width: 10 },
      { key: 'waiver_status', label: 'Waiver Documentation', type: 'status', default: true, sortable: true, width: 13 },
      { key: 'amendment_required', label: 'Amendment Required', type: 'status', default: true, width: 10 },
      { key: 'amendment_status', label: 'Amendment Documentation', type: 'status', default: true, sortable: true, width: 13 },
      { key: 'condition_fulfilled', label: 'Condition Fulfilled', type: 'status', default: true, sortable: true, width: 11 },
      { key: 'txn_status', label: 'Transaction Status', type: 'status', default: true, sortable: true, width: 14 },
    ],
    filters: [statusFilter('Expiry Status', EXPIRY_STATUSES)],
    defaultSort: { key: 'condition_expiry', dir: 'asc' },
    predicate: (t, f) => {
      if (t.conditional_offer !== 'Yes') return false;
      if (!f.status) return true;
      return t.conditions.length
        ? t.conditions.some((c) => c.expiry_status === f.status)
        : f.status === 'Active';
    },
    // one row per condition; a conditional deal with no condition rows still reports once
    expand: (t) => {
      const today = new Date().toISOString().slice(0, 10);
      const base = {
        ...baseRow(t),
        conditional_offer: t.conditional_offer,
        waiver_required: 'Yes',
        waiver_status: t.waiver_status,
        amendment_required: t.amendment_status === 'Missing' ? 'No' : 'Yes',
        amendment_status: t.amendment_status,
        txn_status: t.statuses.join(', ') || '—',
      };
      if (!t.conditions.length) {
        return [{ ...base, condition_type: '—', condition_expiry: null, expiry_status: 'Active', remaining_time: '—', condition_fulfilled: 'No' }];
      }
      return t.conditions.map((c) => ({
        ...base,
        condition_type: c.type,
        condition_expiry: c.deadline,
        expiry_status: c.expiry_status,
        remaining_time: remainingTime(c.deadline, today),
        condition_fulfilled: c.expiry_status === 'Fulfilled' ? 'Yes' : 'No',
      }));
    },
  },
  // 19 ----------------------------------------------------------------
  {
    type: 'pending-invalid-documents',
    name: 'Pending and Invalid Documents Report',
    description: 'Every pending or invalid document listed individually, grouped into separate status sections.',
    category: 'Documentation and Compliance Reports',
    columns: [
      col.txnId(), col.dealNo(), col.property(), col.agent(), col.clientName(),
      col.docName(), col.docCategory(), col.docRowStatus(), col.docRequired(),
      col.docUploaded(), col.docReviewed(), col.docInvalidReason(), col.docNotes(), col.reminderStatus(),
    ],
    filters: [],
    // Pending and invalid documents are never combined (§5).
    sections: [
      { key: 'pending', label: 'Pending Documents' },
      { key: 'invalid', label: 'Invalid Documents' },
    ],
    defaultSort: { key: 'trade_no', dir: 'asc' },
    noSort: true,
    // rows set their own section (per document); this is the fallback for a row that doesn't
    section: () => 'pending',
    predicate: (t) => t.doc_counts.pending > 0 || t.doc_counts.invalid > 0,
    expand: (t) => t.docs
      .filter((d) => d.status === 'Pending' || d.status === 'Invalid')
      // grouped by transaction, then documentation status, then document type
      .sort((a, b) => a.status.localeCompare(b.status) || a.category.localeCompare(b.category) || a.title.localeCompare(b.title))
      .map((d) => ({
        ...baseRow(t),
        doc_id: d.id, doc_name: d.title, doc_category: d.category, doc_status: d.status,
        doc_required: d.mandatory ? 'Yes' : 'No',
        // each DOCUMENT carries its own section, so one deal can appear under both headings
        section: d.status === 'Invalid' ? 'invalid' : 'pending',
        doc_uploaded_at: d.uploaded_at, doc_reviewed_at: d.reviewed_at,
        invalid_reason: d.status === 'Invalid' ? (d.remarks ?? 'Not specified') : null,
        doc_notes: d.remarks,
        reminder_status: d.reminder_sent ? 'Reminder Sent' : 'Not Sent',
      })),
  },
  // 20 ----------------------------------------------------------------
  {
    type: 'documentation-reminder-followup',
    name: 'Documentation Reminder and Follow-Up Report',
    description: 'Complete history of every documentation reminder sent, with delivery status and failure reasons.',
    category: 'Documentation and Compliance Reports',
    custom: 'reminders',
    columns: [
      { key: 'reminder_id', label: 'Reminder ID', type: 'number', default: true, sortable: true, width: 8 },
      { key: 'batch_id', label: 'Batch ID', type: 'text', default: false, sortable: true, width: 14 },
      { key: 'txn_id', label: 'Transaction ID', type: 'number', default: true, sortable: true, width: 9 },
      { key: 'trade_no', label: 'Deal Number', type: 'text', default: true, sortable: true, mandatory: true, width: 12 },
      { key: 'property', label: 'Property Address', type: 'text', default: true, sortable: true, width: 26 },
      { key: 'doc_id', label: 'Document ID', type: 'number', default: false, sortable: true, width: 8 },
      { key: 'doc_name', label: 'Document Name', type: 'text', default: true, sortable: true, width: 22 },
      { key: 'doc_status', label: 'Related Document Status', type: 'status', default: true, sortable: true, width: 12 },
      { key: 'recipient', label: 'Recipient', type: 'text', default: true, sortable: true, width: 20 },
      { key: 'channel', label: 'Communication Channel', type: 'text', default: true, sortable: true, width: 11 },
      { key: 'reminder_type', label: 'Reminder Type', type: 'text', default: true, sortable: true, width: 13 },
      { key: 'sent_by', label: 'Sent By', type: 'text', default: true, sortable: true, width: 14 },
      { key: 'sent_at', label: 'Sent Date and Time', type: 'datetime', default: true, sortable: true, width: 15 },
      { key: 'delivery_status', label: 'Delivery Status', type: 'status', default: true, sortable: true, width: 11 },
      { key: 'failure_reason', label: 'Failure Reason', type: 'text', default: true, width: 22 },
      { key: 'message', label: 'Reminder Message', type: 'text', default: false, width: 24 },
    ],
    filters: [
      statusFilter('Delivery Status', ['Sent', 'Failed', 'Skipped']),
      { key: 'reminder_type', label: 'Reminder Type', type: 'select', options: [{ value: '', label: 'All' }, ...REMINDER_TYPES.map((v) => ({ value: v, label: v }))] },
      dateRange('sent', 'Sent Date'),
    ],
    defaultSort: { key: 'sent_at', dir: 'desc' },
  },
];

// ---- report-specific status helpers ----
function partialStatus(t: EnrichedTxn): string {
  if (t.agentComm.total <= 0 || t.agent_balance <= 0) return 'Fully Paid';
  if (t.advance > 0 && t.agent_paid <= 0) return 'Advance Paid';
  if (t.agent_paid > 0 || t.advance > 0) return 'Partially Paid';
  return 'Balance Pending';
}
function cashbackStatus(t: EnrichedTxn): string {
  return t.cashback.pendingTotal <= 0 && t.cashback.total > 0 ? 'Completed' : 'Pending';
}
function paymentSection(t: EnrichedTxn): string {
  if (t.is_mutual_release) return 'mutual_release';
  if (!t.is_closed) return 'yet_to_close';
  return t.agent_payment_status === 'Paid' ? 'closed_paid' : 'closed_pending';
}
function reviewStatus(t: EnrichedTxn): string {
  if (t.review_received_at) return 'Review Received';
  if (t.review_email_sent_at) return 'Review Pending';
  if (t.gift_coupon_issued_at) return 'Gift Coupon Issued';
  return 'Coupon Pending';
}
function reviewMatches(t: EnrichedTxn, status: string): boolean {
  switch (status) {
    case 'Review Email Sent': return !!t.review_email_sent_at;
    case 'Review Received': return !!t.review_received_at;
    case 'Gift Coupon Issued': return !!t.gift_coupon_issued_at;
    case 'Review Pending': return !!t.review_email_sent_at && !t.review_received_at;
    case 'Coupon Pending': return !t.gift_coupon_issued_at;
    default: return true;
  }
}

export const REPORT_MAP: Record<string, ReportDef> = Object.fromEntries(REPORTS.map((r) => [r.type, r]));
export const getReport = (type: string): ReportDef | undefined => REPORT_MAP[type];
void HEAD_MULTI;
