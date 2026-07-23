import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { PrismaService } from '../prisma/prisma.service';
import { CommissionService } from '../transactions/commission.service';
import { commissionInclude, normalizeCommissionTxn } from '../transactions/commission.loader';
import { parseJsonObject } from '../common/serialize';
import {
  Triple, ZERO_TRIPLE, num, money, sum, brokerageCommission,
  splitRatios, agentPaymentsPaid, advancePayments, cashback, referral, loanRepayments,
  type CashbackInfo, type ReferralInfo, agentLines, addTriple,
} from './report-financials';
import {
  docStatus, docCategory, docCounts, documentationStatus, groupStatus, expiryStatus,
  isAmendment, isWaiver, type DocRow, type DocCounts, type CondRow,
} from './report-documents';

const dateStr = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);
/** Configured currency format (matches the app's formatCurrency: en-CA, always 2 decimals). */
const fmtNum = (n: number): string => Number(n).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const trimPct = (n: number): string => (Number.isInteger(n) ? String(n) : String(money(n)));
/** Decimal-safe a − b − c … clamped at ≥ 0 (agent balances never go negative). */
const balanceOf = (due: number, ...deductions: number[]): number =>
  money(Decimal.max(0, deductions.reduce((acc, d) => acc.minus(num(d)), new Decimal(num(due)))));

/** A fully-computed transaction row with every field any of the 14 reports may need. */
export interface EnrichedTxn {
  id: number;
  trade_no: string;
  type: string;                 // Type of Deal (existing transaction type)
  property: string | null;
  offer_date: string | null;
  closing_date: string | null;
  created_at: string | null;
  updated_at: string | null;
  agent: string | null;         // primary agent
  agent_names: string[];        // all split agents (scoped for agent users)
  is_team: boolean;
  split_ratios: string[];
  /** Every split agent's own line (one entry per agent, incl. single-agent deals). */
  splits: { name: string; ratio: string; split: number; agent: Triple; brokerage: Triple }[];
  /** 'Yes' once any CTA→BA transfer row is Yes; otherwise 'No' (Admin Activities → CTA to BA). */
  cta_to_ba: string;
  price: number;
  listing_price: number | null;
  closed_price: number | null;
  comm_type: string | null;
  comm_value: number;
  comm_pct: number | null;
  comm_amt: number | null;
  comm_display: string;         // "2.5%" or "$5,000" — Commission % / Amount
  payment_type: string | null;
  total: Triple;                // transaction total commission (§9A)
  agentComm: Triple;            // agent commission totals (§9B, scoped)
  brokerageComm: Triple;        // brokerage split totals, excl. min brokerage (§9D)
  agent_payment_status: string; // from Agent FAQ Center agent_commission_paid_status
  agent_paid: number;           // agent commission actually paid (admin_activities)
  agent_paid_date: string | null;
  any_agent_paid: boolean;
  advance: number;
  advance_date: string | null;
  agent_balance: number;        // agent commission due − advance − other agent payments (≥0)
  adjustments_total: number;    // commission adjustments (before+after HST)
  cashback: CashbackInfo;
  referral: ReferralInfo | null;
  statuses: string[];
  is_closed: boolean;
  is_mutual_release: boolean;
  commission_received: boolean;  // transaction comm_status === 'Received' (brokerage received)
  // new backward-compatible columns (null on legacy records)
  lead_source: string | null;
  lead_assigned_date: string | null;
  lead_converted_date: string | null;
  review_email_sent_at: string | null;
  review_received_at: string | null;
  gift_coupon_value: number | null;
  gift_coupon_issued_at: string | null;

  // ---- documentation reporting (§ Documentation Reports) ----
  /** Client names on the deal (buyer/seller/landlord/tenant), joined for display. */
  client_names: string[];
  /** Every non-deleted document on the transaction, with its reporting status + category. */
  docs: DocRow[];
  doc_counts: DocCounts;
  documentation_status: string;   // Pending / Invalid Documentation / Complete / No Documents
  last_doc_update: string | null; // most recent document change
  reco_audit_ready: string;       // 'Yes' | 'No'
  reco_audit_remarks: string | null;
  reco_review_at: string | null;  // transactions.agent_review_at (compliance review)
  conditional_offer: string;      // 'Yes' | 'No'
  conditions: CondRow[];
  /** Waiver / amendment documentation, reported separately from each other. */
  waiver_status: string;
  amendment_status: string;
}

/** The transaction shape `load()` fetches, including the documentation relations. */
type LoadedTxn = Prisma.transactionsGetPayload<{ include: typeof commissionInclude }> & {
  transaction_statuses: { status: string }[];
  documents: {
    id: number; title: string; status: string; validation: string; mandatory: boolean;
    is_condition: boolean; reminder: boolean; file_path: string | null; file_name: string | null;
    remarks: string | null; created_at: Date | null; updated_at: Date | null;
  }[];
  conditions: { id: number; type: string; custom_name: string | null; deadline: Date | null; status: string }[];
  clients: { name: string }[];
};

/** Scope for a report run: an agent user is locked to their own name; admins may pass agents. */
export interface DataScope {
  /** When set, only this agent's transactions are loaded and financials are scoped to them. */
  lockedAgent?: string | null;
  /** admin/authorized: restrict to these agent names (from the Agent filter), else all. */
  agents?: string[];
}

@Injectable()
export class ReportDataService {
  constructor(private readonly prisma: PrismaService, private readonly commission: CommissionService) {}

  /** name → parsed profile, loaded once so breakdown() never does per-txn user lookups. */
  private async profileCache(): Promise<Map<string, Record<string, unknown>>> {
    const users = await this.prisma.users.findMany({ select: { name: true, profile: true } });
    const map = new Map<string, Record<string, unknown>>();
    for (const u of users) map.set(u.name, parseJsonObject(u.profile));
    return map;
  }

  /** Load every non-deleted transaction in scope, fully enriched. Single query + relations. */
  async load(scope: DataScope): Promise<EnrichedTxn[]> {
    const where: Prisma.transactionsWhereInput = { deleted_at: null };
    const scopedNames = scope.lockedAgent ? [scope.lockedAgent] : scope.agents && scope.agents.length ? scope.agents : null;
    if (scopedNames) {
      where.OR = [{ agent: { in: scopedNames } }, { team_members: { some: { name: { in: scopedNames } } } }];
    }

    const [rows, cache] = await Promise.all([
      this.prisma.transactions.findMany({
        where,
        include: {
          ...commissionInclude,
          transaction_statuses: { select: { status: true } },
          // documentation reporting: documents, their conditions, and the deal's clients
          documents: { where: { deleted_at: null }, orderBy: { position: 'asc' } },
          conditions: { orderBy: { position: 'asc' } },
          clients: { orderBy: { position: 'asc' }, select: { name: true } },
        },
        orderBy: { id: 'asc' },
      }),
      this.profileCache(),
    ]);

    const out: EnrichedTxn[] = [];
    for (const t of rows) {
      const cinput = normalizeCommissionTxn(t);
      const bd = await this.commission.breakdown(cinput, cache);
      const summary = this.commission.summarize(cinput);
      out.push(this.enrich(t, bd, summary, scope.lockedAgent ?? null));
    }
    return out;
  }

  private enrich(
    t: LoadedTxn,
    bd: Record<string, unknown>,
    summary: { amount: number; hst: number; total: number },
    lockedAgent: string | null,
  ): EnrichedTxn {
    const adjustments = parseJsonObject(t.adjustments);
    const admin = parseJsonObject(t.admin_activities);
    const tracker = parseJsonObject(t.activity_tracker);

    const allNames = agentLines(bd).map((l) => String(l.name ?? '')).filter((n) => n !== '');
    // Agent users only ever see their own split line(s); admins see the whole split.
    const scopedNames = lockedAgent ? allNames.filter((n) => n === lockedAgent) : allNames;
    const scopedLines = lockedAgent ? agentLines(bd).filter((l) => String(l.name) === lockedAgent) : agentLines(bd);

    const agentComm = scopedLines.reduce<Triple>((a, l) => addTriple(a, { commission: num((l.agent as Record<string, unknown>)?.commission), hst: num((l.agent as Record<string, unknown>)?.hst), total: num((l.agent as Record<string, unknown>)?.total) }), { ...ZERO_TRIPLE });
    const brokerageComm = lockedAgent ? scopedLines.reduce<Triple>((a, l) => addTriple(a, { commission: num((l.brokerage as Record<string, unknown>)?.commission), hst: num((l.brokerage as Record<string, unknown>)?.hst), total: num((l.brokerage as Record<string, unknown>)?.total) }), { ...ZERO_TRIPLE }) : brokerageCommission(bd);

    const paid = agentPaymentsPaid(admin, scopedNames);
    const adv = advancePayments(adjustments, lockedAgent ? [lockedAgent] : null);
    const balance = balanceOf(agentComm.total, adv.total, paid.totalPaid);

    const statuses = t.transaction_statuses.map((s) => s.status);
    const adjust = (bd.adjust as Record<string, unknown>) ?? {};
    const adjustmentsTotal = sum([num(adjust.before), num(adjust.after)]);

    // Commission % / Amount — taken from Financial Information: whichever of
    // "Commission %" (comm_pct) or "Commission Amount" (comm_amt) is given.
    const pctVal = t.comm_pct !== null ? num(t.comm_pct) : t.comm_type === '%' ? num(t.comm_value) : 0;
    const amtVal = t.comm_amt !== null ? num(t.comm_amt) : t.comm_type === 'Fixed' ? num(t.comm_value) : 0;
    const commDisplay = pctVal > 0 ? trimPct(pctVal) + '%' : amtVal > 0 ? '$' + fmtNum(amtVal) : '—';

    // ---- documentation reporting ------------------------------------------
    const docs: DocRow[] = t.documents.map((d) => ({
      id: d.id,
      title: d.title,
      category: docCategory(d.title),
      status: docStatus(d),
      raw_status: d.status,
      validation: d.validation,
      mandatory: d.mandatory,
      is_condition: d.is_condition,
      uploaded: !!d.file_path,
      reminder_sent: d.reminder,
      file_name: d.file_name,
      uploaded_at: dateStr(d.created_at),
      reviewed_at: dateStr(d.updated_at),
      remarks: d.remarks,
    }));
    const counts = docCounts(docs);
    const lastDocUpdate = docs.reduce<string | null>((a, d) => (d.reviewed_at && (!a || d.reviewed_at > a) ? d.reviewed_at : a), null);
    const today = new Date().toISOString().slice(0, 10);
    const conditions: CondRow[] = t.conditions.map((c) => {
      const cond = { status: c.status, deadline: dateStr(c.deadline) };
      return { id: c.id, type: c.custom_name || c.type, deadline: cond.deadline, status: c.status, expiry_status: expiryStatus(cond, today) };
    });

    const rec = t as unknown as Record<string, unknown>;
    // Payment Type: the transaction column when set, else the actual method used on the
    // agent payment rows (admin_activities → paid_type), ignoring the "N/A" placeholder.
    const paymentType = rec.payment_type != null && String(rec.payment_type) !== ''
      ? String(rec.payment_type)
      : this.derivePaymentType(admin, scopedNames);
    return {
      id: t.id,
      trade_no: t.trade_no,
      type: t.type,
      property: t.property,
      offer_date: dateStr(t.offer_date),
      closing_date: dateStr(t.closing_date),
      created_at: dateStr(t.created_at),
      updated_at: dateStr(t.updated_at),
      agent: t.agent,
      agent_names: scopedNames.length ? scopedNames : (t.agent ? [t.agent] : []),
      is_team: allNames.length > 1,
      split_ratios: splitRatios(bd),
      splits: this.buildSplits(scopedLines),
      cta_to_ba: this.ctaToBa(admin, scopedNames),
      price: num(t.price),
      listing_price: rec.listing_price != null ? num(rec.listing_price) : null,
      closed_price: num(t.price),
      comm_type: t.comm_type,
      comm_value: num(t.comm_value),
      comm_pct: t.comm_pct != null ? num(t.comm_pct) : null,
      comm_amt: t.comm_amt != null ? num(t.comm_amt) : null,
      comm_display: commDisplay,
      payment_type: paymentType,
      total: { commission: money(summary.amount), hst: money(summary.hst), total: money(summary.total) },
      agentComm,
      brokerageComm,
      agent_payment_status: this.agentPaymentStatus(tracker, statuses, paid, scopedNames, agentComm.total),
      agent_paid: paid.totalPaid,
      agent_paid_date: paid.lastPaidDate,
      any_agent_paid: paid.anyPaid,
      advance: adv.total,
      advance_date: adv.lastDate,
      agent_balance: balance,
      adjustments_total: adjustmentsTotal,
      cashback: cashback(adjustments),
      referral: referral(adjustments),
      statuses,
      is_closed: statuses.includes('Closed'),
      is_mutual_release: statuses.includes('Mutual Release'),
      commission_received: t.comm_status === 'Received',
      lead_source: rec.lead_source != null && String(rec.lead_source) !== '' ? String(rec.lead_source) : null,
      lead_assigned_date: dateStr(rec.lead_assigned_date as Date | null),
      lead_converted_date: dateStr(rec.lead_converted_date as Date | null),
      review_email_sent_at: dateStr(rec.review_email_sent_at as Date | null),
      review_received_at: dateStr(rec.review_received_at as Date | null),
      client_names: t.clients.map((c) => c.name).filter(Boolean),
      docs,
      doc_counts: counts,
      documentation_status: documentationStatus(counts),
      last_doc_update: lastDocUpdate,
      // reco_audit_ready is stored as a flag/word depending on vintage — normalise to Yes/No
      reco_audit_ready: this.yesNo(rec.reco_audit_ready),
      reco_audit_remarks: rec.reco_audit_remarks != null ? String(rec.reco_audit_remarks) : null,
      reco_review_at: dateStr(t.agent_review_at),
      conditional_offer: this.yesNo(rec.conditional_offer) === 'Yes' || conditions.length > 0 ? 'Yes' : 'No',
      conditions,
      waiver_status: groupStatus(docs.filter((d) => isWaiver(d.title))),
      amendment_status: groupStatus(docs.filter((d) => isAmendment(d.title))),
      gift_coupon_value: rec.gift_coupon_value != null ? num(rec.gift_coupon_value) : null,
      gift_coupon_issued_at: dateStr(rec.gift_coupon_issued_at as Date | null),
    };
  }

  /** One entry per split agent (single-agent deals produce exactly one). */
  private buildSplits(lines: Record<string, unknown>[]): EnrichedTxn['splits'] {
    const tri = (v: unknown): Triple => { const o = (v ?? {}) as Record<string, unknown>; return { commission: num(o.commission), hst: num(o.hst), total: num(o.total) }; };
    const trim = (n: number): string => (Number.isInteger(n) ? String(n) : String(money(n)));
    return lines.map((l) => ({
      name: String(l.name ?? ''),
      ratio: `${trim(num(l.agent_pct))}/${trim(num(l.brok_pct))}`,
      split: num(l.split),
      agent: tri(l.agent),
      brokerage: tri(l.brokerage),
    }));
  }

  /**
   * CTA → BA transfer state from Admin Activities: 'Yes' once any transfer row for the
   * transaction's agents is Yes; otherwise 'No' (including when no transfer row exists yet).
   */
  private ctaToBa(admin: Record<string, unknown>, names: string[]): string {
    const agents = (admin.agents && typeof admin.agents === 'object' ? admin.agents : {}) as Record<string, unknown>;
    for (const name of names) {
      const rec = (agents[name] && typeof agents[name] === 'object' ? agents[name] : {}) as Record<string, unknown>;
      for (const row of (Array.isArray(rec.cta) ? rec.cta : [])) {
        if (String((row as Record<string, unknown>)?.cta) === 'Yes') return 'Yes';
      }
    }
    return 'No';
  }

  /** First real payment method used on this transaction's agent payment rows ("N/A" ignored). */
  private derivePaymentType(admin: Record<string, unknown>, names: string[]): string | null {
    const agents = (admin.agents && typeof admin.agents === 'object' ? admin.agents : {}) as Record<string, unknown>;
    for (const name of names) {
      const rec = (agents[name] && typeof agents[name] === 'object' ? agents[name] : {}) as Record<string, unknown>;
      const rows = Array.isArray(rec.payments) ? rec.payments : [];
      for (const p of rows) {
        const pt = (p as Record<string, unknown>)?.paid_type;
        if (pt && String(pt) !== 'N/A' && String(pt) !== '') return String(pt);
      }
    }
    return null;
  }

  /** Normalise the several truthy spellings these flag columns use into 'Yes' / 'No'. */
  private yesNo(v: unknown): string {
    if (v === true || v === 1) return 'Yes';
    const s = String(v ?? '').trim().toLowerCase();
    return s === 'yes' || s === 'y' || s === '1' || s === 'true' ? 'Yes' : 'No';
  }

  /** Active agent-role users — the same list the Transactions module's Agent dropdown uses. */
  async agentNames(): Promise<string[]> {
    const rows = await this.prisma.users.findMany({ where: { role: 'agent', status: 'Active' }, select: { name: true } });
    return rows.map((r) => r.name).sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  }

  /** Distinct years present on closing_date, newest first (drives the Closing Year filter). */
  async closingYears(): Promise<string[]> {
    const rows = await this.prisma.transactions.findMany({ where: { deleted_at: null, closing_date: { not: null } }, select: { closing_date: true } });
    return [...new Set(rows.map((r) => String(r.closing_date!.getUTCFullYear())))].sort((a, b) => Number(b) - Number(a));
  }

  /**
   * Agent payment status. Source of truth is Agent FAQ Center → Agent Commission Paid Status;
   * where that is unset we derive a transaction-level status across every split agent:
   *   all agents paid → Paid · some paid → Partially Paid · none paid → Pending (Upcoming
   *   while the deal is still open) · no commission payable → Not Applicable.
   */
  private agentPaymentStatus(
    tracker: Record<string, unknown>,
    statuses: string[],
    paid: { paidNames: string[] },
    names: string[],
    agentCommTotal: number,
  ): string {
    const faq = tracker.agent_commission_paid_status;
    if (faq === 'Yes') return 'Paid';
    if (faq === 'N/A' || faq === 'Not Applicable') return 'Not Applicable';
    if (agentCommTotal <= 0) return 'Not Applicable';

    const paidCount = paid.paidNames.length;
    if (names.length > 0 && paidCount >= names.length) return 'Paid';
    if (paidCount > 0) return 'Partially Paid';
    return statuses.includes('Closed') ? 'Pending' : 'Upcoming';
  }

  /**
   * Agent loan rows (Report 12) — derived exactly like Laravel AgentController::loans():
   * loan principal from User.profile (has_loan/loan_amount); repayments from adjustment_rows[]
   * with is_loan, aggregated per agent across all their transactions.
   */
  async loadLoans(scope: DataScope): Promise<LoanRow[]> {
    const users = await this.prisma.users.findMany({ select: { name: true, profile: true, role: true } });
    const nameFilter = scope.lockedAgent ? [scope.lockedAgent] : scope.agents && scope.agents.length ? scope.agents : null;

    // repayments across transactions, grouped by agent
    const txns = await this.prisma.transactions.findMany({ where: { deleted_at: null }, select: { trade_no: true, property: true, closing_date: true, adjustments: true } });
    const repayByAgent = new Map<string, { trade_no: string; property: string | null; closing_date: string | null; amount: number }[]>();
    for (const t of txns) {
      const adj = parseJsonObject(t.adjustments);
      for (const name of new Set(this.loanAgentsIn(adj))) {
        const reps = loanRepayments(adj, name);
        if (!reps.length) continue;
        const list = repayByAgent.get(name) ?? [];
        for (const r of reps) list.push({ trade_no: t.trade_no, property: t.property, closing_date: dateStr(t.closing_date), amount: r.amount });
        repayByAgent.set(name, list);
      }
    }

    const rows: LoanRow[] = [];
    for (const u of users) {
      if (nameFilter && !nameFilter.includes(u.name)) continue;
      const p = parseJsonObject(u.profile);
      const hasLoan = p.has_loan === true || p.has_loan === 'Yes' || p.has_loan === 1 || p.has_loan === '1';
      const principal = num(p.loan_amount);
      const reps = repayByAgent.get(u.name) ?? [];
      const repaid = sum(reps.map((r) => r.amount));
      if (!hasLoan && principal === 0 && reps.length === 0) continue; // no loan for this agent
      const outstanding = balanceOf(principal, repaid);
      rows.push({
        agent: u.name,
        loan_amount: principal,
        loan_repaid: repaid,
        outstanding,
        status: this.loanStatus(principal, repaid),
        repayment_count: reps.length,
        last_repayment: reps.map((r) => r.closing_date).filter(Boolean).sort().slice(-1)[0] ?? null,
        repayments: reps,
      });
    }
    return rows;
  }

  private loanAgentsIn(adj: Record<string, unknown>): string[] {
    if (String(adj.agent_adjust) !== 'Yes') return [];
    const rows = Array.isArray(adj.adjustment_rows) ? adj.adjustment_rows : [];
    return rows.filter((r) => r && typeof r === 'object' && (r as Record<string, unknown>).is_loan).map((r) => String((r as Record<string, unknown>).agent ?? '')).filter(Boolean);
  }

  private loanStatus(principal: number, repaid: number): string {
    if (principal <= 0) return 'Active';
    if (repaid <= 0) return 'Active';
    if (repaid >= principal) return 'Fully Repaid';
    return 'Partially Repaid';
  }
}

export interface LoanRow {
  agent: string;
  loan_amount: number;
  loan_repaid: number;
  outstanding: number;
  status: string;
  repayment_count: number;
  last_repayment: string | null;
  repayments: { trade_no: string; property: string | null; closing_date: string | null; amount: number }[];
}
