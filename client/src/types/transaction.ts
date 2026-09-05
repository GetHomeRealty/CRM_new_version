/**
 * Transaction domain types. These mirror TransactionResource on the backend and
 * are grown field-by-field as each transactions-feature component is converted,
 * so every property here is actually consumed by typed code.
 */

import type { AuditEntry } from './audit';
import type { Adjustments, CommissionAmounts, NumericInput } from './commission';

/** CommissionService::summarize output (the list-level commission triple + paid flag). */
export interface CommissionSummary {
  amount: number;
  hst: number;
  total: number;
  paid: boolean;
}

/** A team-split member as edited in TeamSplitModal / returned in `team`. */
export interface TeamMemberData {
  id?: number;
  name: string;
  // split / agent_pct / brok_pct are filled by the backend from the agent's User
  // profile when unset, so they are optional here.
  split?: number | string | null;
  agent_pct?: number | string | null;
  brok_pct?: number | string | null;
  is_primary?: boolean;
  access?: string;
  scope?: string;
  terms?: number[];
}

/** name → registered agent split from their User profile (GET /api/agent-commissions). */
/**
 * Commission plans by agent NAME, as `/api/agent-commissions` returns them.
 *
 * TD-102 — `active_agent` says whether the plan's account is somebody the application would let
 * you put on a deal today (role agent, status Active). Plans for departed agents and for non-agent
 * seats are still here on purpose — a deal that already carries such a name must keep resolving the
 * rate it was paid at — so the flag is how a screen tells one from the other.
 */
export type AgentCommissionMap = Record<string, {
  agent_pct?: number | null;
  lease_pct?: number | null;
  active_agent?: boolean;
}>;

/** name → outstanding agent loan balance (GET /api/agent-loans). */
export type AgentLoanMap = Record<string, { loan_balance?: number; loan_repaid?: number; repayments?: import('./users').LoanRepayment[] }>;

/**
 * The transaction.adjustments JSON blob as edited/rendered (superset of the
 * calculator's minimal Adjustments in commission.ts). Rows are free-form.
 */
export interface AdjustmentEntry {
  agent?: string;
  client_name?: string;
  amount?: NumericInput;
  status?: string;
  remarks?: string;
  is_loan?: boolean;
  term?: NumericInput;
  paid_type?: string;
  paid_date?: string;
  batch_no?: string;
  paid_status?: string;
  void_cheque?: string;
}
export interface ExtReferral {
  agent_name?: string;
  brokerage?: string;
  amount?: NumericInput;
  pct?: NumericInput;
  invoice_received?: string;
  hst_no?: string;
  paid_type?: string;
  paid_date?: string;
  batch_no?: string;
  paid_status?: string;
  total?: NumericInput;
}

/** A listing/co-op commission section (pct + commission/HST/total triple). */
export interface FinancialSection {
  pct?: NumericInput;
  commission?: number;
  hst?: number;
  total?: number;
  [key: string]: unknown;
}

/**
 * Backend Financial breakdown (CommissionService::breakdown). Variant-specific
 * fields are many; the ones consumed by typed code are declared and the rest are
 * `unknown`-indexed (progressively promoted to explicit fields as slices land).
 */
export interface FinancialAgentLine {
  name?: string;
  t4a?: CommissionAmounts;
  agent?: CommissionAmounts;
  brokerage?: CommissionAmounts;
  brokerage_from_member?: number;
  split?: NumericInput;
  earned?: number;
  cash_to_pay?: number;
  [key: string]: unknown;
}
export interface FinancialTerm {
  agents?: FinancialAgentLine[];
  [key: string]: unknown;
}
export interface FinancialTrust {
  payable_to_client?: number;
  receivable_from_lawyer?: number;
}
export interface FinancialBreakdown {
  variant?: string;
  terms?: FinancialTerm[];
  agents?: FinancialAgentLine[];
  members?: FinancialAgentLine[];
  trust?: FinancialTrust;
  listing?: FinancialSection;
  coop?: FinancialSection;
  ext_referral?: ExtReferral;
  // Variant summary triples read by commissionSummary().
  totals?: CommissionAmounts;   // listing variant
  master?: CommissionAmounts;   // precon variant
  commission?: number;          // standard variant
  hst?: number;
  total?: number;
  // Some documents read these at the top level (fall back to trust / summary).
  payable_to_client?: number;
  receivable_from_lawyer?: number;
  [key: string]: unknown;
}

/** Admin Activities JSON blob (per-agent payment tracking + many other fields). */
export interface AgentPayment {
  paid_status?: string;
  paid_type?: string;
  paid_date?: string;
  batch_no?: string;
  t4a_year?: string;
  cta?: string;
  date?: string;
}
export interface AdminAgentRecord {
  invoice_received?: string;
  payments?: AgentPayment[];
  cta?: AgentPayment[];
}
export interface AdminDeposit { date?: string; received_via?: string; receipt_sent?: string; }
export interface AdminNote { text?: string; date?: string; created_at?: string; author?: string; role?: string; }
export interface LawyerPayment { paid_status?: string; amount?: NumericInput; via?: string; date?: string; }
export interface RecvLawyer { enabled?: string; via?: string; date?: string; }
export interface PaidLawyer { enabled?: string; via?: string; date?: string; batch?: string; paid_status?: string; amount?: NumericInput; payments?: LawyerPayment[]; }
export interface PaidClient { enabled?: string; via?: string; date?: string; batch?: string; }
export interface CoopInvoice { enabled?: string; gst_hst?: string; via?: string; date?: string; batch?: string; }
export interface TaCta { enabled?: string; date?: string; batch?: string; }
export interface TermAdmin {
  invoice_sent?: string;
  invoice_number?: string;
  commission_received_date?: string;
  commission_received_via?: string;
  remarks?: string;
  agents?: Record<string, AdminAgentRecord>;
}
export interface AdminActivities {
  invoice_sent_status?: string;
  invoice_number?: string;
  commission_received_date?: string;
  commission_received_via?: string;
  deposits?: AdminDeposit[];
  void_cheque_received?: string;
  lawyer_statement_sent?: string;
  recv_lawyer?: RecvLawyer;
  paid_lawyer?: PaidLawyer;
  paid_client?: PaidClient;
  coop_invoice?: CoopInvoice;
  ta_cta?: TaCta;
  agents?: Record<string, AdminAgentRecord>;
  notes?: AdminNote[];
  term_admin?: Record<string, TermAdmin>;
  [key: string]: unknown;
}

/** Free-form activity tracker flags. */
export interface ActivityTracker {
  agent_commission_paid_status?: string;
  deposit_slips?: { name?: string; data?: string }[];
  [key: string]: unknown;
}

/** §12.4 auto invoice fields surfaced into Admin Activities (read-only). */
export interface InvoiceAdminBlock {
  invoice_number?: string | null;
  /**
   * TD-048 — what the invoice SAYS (Draft / Unpaid / Partially Paid / Paid / Due / Overdue / Void),
   * derived once on the server and identical to the invoice list's badge and the API's
   * `display_status`.
   */
  invoice_status?: string | null;
  /** Whether it has gone OUT: Pending to Raise / Draft / Sent / Paid / Void. A different question. */
  invoice_sent_status?: string;
  commission_received_date?: string | null;
  commission_received_via?: string | null;
}
export interface InvoiceAdmin extends InvoiceAdminBlock {
  by_term?: Record<string, InvoiceAdminBlock>;
}

export interface PreconTermData { term_no: number; pct?: number | null; closing_date?: string | null; }
export interface EditRequest {
  id: number;
  status: string;
  scope?: string | null;
  status_at_request?: string;
  requested_by_name?: string;
  reason?: string;
  reviewed_by_name?: string;
  reviewed_at?: string | null;
  stamp?: string;
}
export interface ClientLite { id?: number; name?: string; email?: string; phone?: string; }
export interface BrokerageLite { name?: string; address?: string; email?: string; invoice_email?: string; agent_email?: string; phone?: string; hst_number?: string; agents?: string[]; }
/** Common shape of the document email/send endpoints. */
export interface SendResult { message?: string; sent_at?: string }
/** A salesperson's Notice-of-Sale signature block. */
export interface AgentSignature { signature?: string | null; signed_date?: string | null; sent_at?: string | null; }
/** GET/PUT/SEND /api/transactions/{id}/notice-of-sale. */
export interface NoticeOfSaleData {
  buyers?: string[];
  sellers?: string[];
  agents?: Record<string, AgentSignature>;
  sent_at?: string | null;
  message?: string;
}
export interface DeleteRequestLite { id: number; status: string; reason?: string; requested_by_name?: string; forwarded_by_name?: string; forward_reason?: string; stamp?: string; }
export interface InvoiceLite { id: number; invoice_no?: string; status?: string; total?: number; sent_at?: string | null; }
export interface AgentChange { id?: number; who?: string; section?: string; field?: string; action?: string; old_value?: string | null; new_value?: string | null; stamp?: string; }
/**
 * TD-110 — the caller's OWN changes on this deal, sent to agents.
 *
 * `agent_changes` above is the office's review queue and is not sent to agents at all — it holds
 * colleagues' pending edits on a team deal. This is the agent's own history: what they changed,
 * when, and whether the office has dealt with it.
 */
// A type alias rather than an interface on purpose: `AuditEntry` carries an index signature,
// and only an alias is assignable to it — the same table renders both (see AuditTrailModal).
export type MyChange = { id: number; section?: string; field?: string; action?: string; old_value?: string | null; new_value?: string | null; handled?: boolean; stamp?: string };
export interface ConditionData { id?: number; type?: string; custom_name?: string | null; deadline?: string | null; status?: string; }
export interface InterBoardListingData { id?: number; name?: string; board_id?: string; verified?: boolean; }
export interface BuilderData { name?: string; vendor?: string; project?: string; address?: string; office_email?: string; invoice_email?: string; phone?: string; }
/** A saved-brokerage type-ahead suggestion (GET /api/suggestions/brokerages). */
export interface BrokerageSuggestion { name?: string; address?: string; email?: string; invoice_email?: string; phone?: string; }
/** A saved-lawyer type-ahead suggestion (GET /api/suggestions/lawyers). */
export interface LawyerSuggestion { name?: string; email?: string; phone?: string; address?: string; }
/** POST /api/transactions/{id}/invoices result. */
export interface GenerateInvoicesResult { existing?: boolean; count?: number; invoices?: { id: number }[] }

/** A transaction row/detail (superset; extended as feature components are typed). */
export interface Transaction {
  id: number;
  /**
   * TD-003 — bumped by the server on every save. An editor sends back the version it loaded, and a
   * save carrying a stale one is refused with a 409 instead of overwriting whoever saved first.
   * Optional because a transaction reached through an older cached payload may not carry one.
   */
  version?: number;
  trade_no: number | string;
  type: string;
  property?: string;
  agent?: string | null;
  price?: number;
  offer_date?: string | null;
  closing_date?: string | null;
  statuses?: string[];
  valid_status?: string | null;
  comm_status?: string | null;
  commission?: CommissionSummary;
  team?: TeamMemberData[];
  clients?: ClientLite[];
  brokerage?: BrokerageLite | null;
  delete_request?: DeleteRequestLite | null;
  unread_messages?: number;
  precon_term_count?: number | string | null;
  comm_paid_status?: string | null;
  // Financial fields (consumed by FinancialModal).
  deposit?: number;
  comm_type?: string;
  comm_value?: number;
  comm_pct?: number | null;
  comm_amt?: number | null;
  comm_adjust_enabled?: boolean;
  comm_adjust_before?: number;
  comm_adjust_after?: number;
  listing_comm_pct?: number | null;
  coop_comm_pct?: number | null;
  listing_comm_flat?: number | null;
  coop_comm_flat?: number | null;
  trust_payable?: number | null;
  listing_adj_enabled?: boolean;
  listing_adj_before?: number;
  listing_adj_after?: number;
  coop_adj_enabled?: boolean;
  coop_adj_before?: number;
  coop_adj_after?: number;
  precon_net_of_hst?: boolean;
  precon_comm_pct?: number | null;
  precon_comm_amt_manual?: number | null;
  precon_details_of_terms?: string;
  precon_terms?: PreconTermData[];
  edit_requests?: EditRequest[];
  adjustments?: Adjustments | null;
  financial?: FinancialBreakdown;
  admin_activities?: AdminActivities;
  activity_tracker?: ActivityTracker;
  invoice_admin?: InvoiceAdmin;
  // Basic-info / detail-page fields.
  listing_contract_date?: string | null;
  listing_expiry_date?: string | null;
  mls_type?: string;
  mls_num?: string;
  mls_verified?: boolean;
  conditional_offer?: boolean;
  inter_board_enabled?: boolean;
  conditions?: ConditionData[];
  inter_board_listings?: InterBoardListingData[];
  precon_listing_type?: string;
  commission_agent?: string;
  builder?: BuilderData;
  commercial_lease?: Record<string, unknown> | null;
  notice_of_sale?: { sent_at?: string | null; [key: string]: unknown } | null;
  trade_sheet_sent_at?: string | null;
  /** TD-088 — when the Trade Record Sheet was last produced, whether or not it was ever emailed. */
  trade_sheet_generated_at?: string | null;
  my_team_access?: string | null;
  agent_changes?: AgentChange[];
  /** TD-110 — an agent's own changes on this deal. Absent for office seats, who get `audit_logs`. */
  my_changes?: MyChange[];
  audit_logs?: AuditEntry[];
  invoices?: InvoiceLite[];
  // Lawyer details (single + buyer/seller sides).
  lawyer_name?: string | null;
  lawyer_email?: string | null;
  lawyer_phone?: string | null;
  lawyer_address?: string | null;
  buyer_lawyer_name?: string | null;
  buyer_lawyer_email?: string | null;
  buyer_lawyer_phone?: string | null;
  buyer_lawyer_address?: string | null;
  seller_lawyer_name?: string | null;
  seller_lawyer_email?: string | null;
  seller_lawyer_phone?: string | null;
  seller_lawyer_address?: string | null;
}
