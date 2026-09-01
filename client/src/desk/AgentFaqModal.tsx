import { useState, useEffect, type CSSProperties } from 'react';
import { updateTransaction } from '../lib/api';
import { isListingType, isPreconType, formatCurrency } from './format';
import { printDoc } from './printDoc';
import { useToast } from './toast';
import { apiErrorMessage } from '../lib/apiError';
import SavedBadge from './SavedBadge';
import type {
  ActivityTracker, AdjustmentRow, Adjustments, CommissionAmounts, FinancialAgentLine, FinancialBreakdown,
  FinancialSection, InvoiceAdmin, Transaction,
} from '../types';

const lbl: CSSProperties = { fontSize: 11.5, color: 'var(--text-2)', fontWeight: 600, marginBottom: 5, display: 'block' };
const editLine: CSSProperties = { border: '1px solid #e6e8ef', borderRadius: 4, padding: '2px 6px', fontSize: 13, minWidth: 180 };

// Listing types that use the redesigned Agent Payment Readiness panel (upload cards + breakdown
// summaries). The `Faq` identifiers here are the panel's old name — see TD-049 below.
const FAQ_V2_TYPES = [
  'Residential Sale Listing',
  'Residential Lease Listing',
  'Commercial Property Sale Listing',
  'Commercial Property Lease Listing',
];

interface SlipFile { name: string; data: string; }

interface TermTrack {
  invoice_sent: string;
  invoice_number: string;
  commission_received_date: string;
  docs_cleared: string;
  final_validation: string;
  ready_to_process: string;
  agent_commission_paid_status: string;
  per_agent_paid: Record<string, string>;
  remarks: string;
}
const EMPTY_TERM: TermTrack = {
  invoice_sent: '', invoice_number: '', commission_received_date: '', docs_cleared: '', final_validation: '',
  ready_to_process: '', agent_commission_paid_status: '', per_agent_paid: {}, remarks: '',
};

interface FaqForm {
  batch_review_email: boolean;
  commission_received_date: string;
  docs_cleared: string;
  final_validation: string;
  final_validation_remarks: string;
  ready_to_process: string;
  agent_commission_paid_status: string;
  client_payment_paid: string;
  per_agent_paid: Record<string, string>;
  term_tracker: Record<number, TermTrack>;
  deposit_slips: SlipFile[];
  void_cheque: SlipFile | null;
  client_name: string;
  void_cheque_name: string;
  client_inst_no: string;
  client_transit_no: string;
  client_account_no: string;
}

interface AgentFaqModalProps {
  open: boolean;
  onClose: () => void;
  transactionId: number | string;
  txn: Transaction;
  onSaved?: (updated: Transaction) => void;
  termCount?: number;
  depositSlipOnly?: boolean;
  dftNA?: boolean;
  readOnly?: boolean;
  allowBatchEmail?: boolean;
  isAgent?: boolean;
}

export default function AgentFaqModal({ open, onClose, transactionId, txn, onSaved, termCount: termCountProp, depositSlipOnly = false, dftNA = false, readOnly = false, allowBatchEmail = false, isAgent = false }: AgentFaqModalProps) {
  const na = (v: string) => (dftNA ? 'N/A' : v); // §5.1 DFT — status dropdowns default to N/A
  const toast = useToast();
  const listing = isListingType(txn.type);
  const precon = isPreconType(txn.type);
  const referral = txn.type === 'Referral';
  const isFaqV2 = FAQ_V2_TYPES.includes(txn.type);
  const fin: FinancialBreakdown = txn.financial || {};
  const invAdmin: InvoiceAdmin = txn.invoice_admin || {}; // auto invoice fields (mirrors Admin Activities)
  const invByTerm = invAdmin.by_term || {}; // preconstruction: per-term auto invoice fields
  // Trust "Payable to Client" = 0 → Client Payment Paid must be N/A.
  const clientNA = !!fin.trust && Number(fin.trust.payable_to_client || 0) <= 0;
  const team = (txn.team && txn.team.length ? txn.team : (txn.agent ? [{ name: txn.agent }] : [])).filter((t) => t && t.name);
  const agentNames = team.map((t) => t.name);
  // Agent Commission Total (sum of each agent's payable). When it's 0 with a single agent
  // (no team split), there's nothing to pay → Ready to Process Agent Payment = N/A.
  const agentCommTotal = (fin.agents || []).reduce((s, a) => s + Number(a.agent?.total ?? 0), 0);
  const naReady = agentNames.length <= 1 && agentCommTotal <= 0.005;
  const termCount = precon ? (typeof termCountProp === 'number' ? termCountProp : (parseInt(String(txn.precon_term_count), 10) || 0)) : 0;
  const termsArr = Array.from({ length: termCount }, (_, i) => i + 1);
  const visibleAt = (k: number) => team.filter((m) => (m.scope || 'Entire') === 'Entire' || (m.terms || []).map(Number).includes(k)).map((m) => m.name).filter(Boolean);

  const [form, setForm] = useState<FaqForm>(() => {
    const a: ActivityTracker = txn.activity_tracker || {};
    const perAgent: Record<string, string> = {};
    const paidMap = (a.per_agent_paid as Record<string, string> | undefined) || {};
    agentNames.forEach((n) => { perAgent[n] = paidMap[n] || ''; });
    const termTracker: Record<number, TermTrack> = {};
    if (precon) {
      const prev = (a.term_tracker as Record<number, Partial<TermTrack>>) || {};
      termsArr.forEach((k) => {
        const pt = prev[k] || {};
        const pa: Record<string, string> = {};
        visibleAt(k).forEach((n) => { pa[n] = (pt.per_agent_paid && pt.per_agent_paid[n]) || ''; });
        termTracker[k] = {
          invoice_sent: pt.invoice_sent || '',
          invoice_number: pt.invoice_number || '',
          commission_received_date: (txn.invoice_admin?.by_term?.[k]?.commission_received_date) || pt.commission_received_date || '',
          docs_cleared: pt.docs_cleared || '',
          final_validation: pt.final_validation || '',
          ready_to_process: pt.ready_to_process || '',
          agent_commission_paid_status: pt.agent_commission_paid_status || '',
          per_agent_paid: pa,
          remarks: pt.remarks || '',
        };
      });
    }
    return {
      // Default ON: a transaction is included in batch review emails unless the user deselects it.
      // Only an explicitly stored `false` (a deliberate deselect) keeps it off.
      batch_review_email: a.batch_review_email == null ? true : !!a.batch_review_email,
      // Auto-reflected from Admin Activities (the linked invoice's Commission Received Date).
      commission_received_date: txn.invoice_admin?.commission_received_date || (a.commission_received_date as string) || txn.admin_activities?.commission_received_date || '',
      docs_cleared: (a.docs_cleared as string) || '',
      final_validation: (a.final_validation as string) || '',
      final_validation_remarks: (a.final_validation_remarks as string) || '',
      ready_to_process: (a.ready_to_process as string) || '',
      agent_commission_paid_status: a.agent_commission_paid_status || 'No',
      client_payment_paid: (a.client_payment_paid as string) || '',
      per_agent_paid: perAgent,
      term_tracker: termTracker,
      deposit_slips: Array.isArray(a.deposit_slips) ? (a.deposit_slips as SlipFile[]) : [],
      void_cheque: (a.void_cheque as SlipFile | null) || null,
      // Client Payment breakdown — editable fields.
      client_name: (a.client_name as string) || (txn.clients || []).map((c) => c.name).filter(Boolean).join(', '),
      void_cheque_name: (a.void_cheque_name as string) || '',
      client_inst_no: (a.client_inst_no as string) || '',
      client_transit_no: (a.client_transit_no as string) || '',
      client_account_no: (a.client_account_no as string) || '',
    };
  });
  const [termFilter, setTermFilter] = useState('All');
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false); // §3.2 — "Saved" then auto-close

  // Agent Commission Paid Status is auto-driven from Admin Activities: once every agent's
  // payment is resolved there (Paid Type + Paid Date entered, or the agent is fully covered
  // by advance/adjustments → N/A), this flips to Yes to reveal the agent Breakdown.
  const adminAgents = txn.admin_activities?.agents || {};
  const agentPaidResolved = (n: string) => {
    const m = (fin.members || []).find((x) => x.name === n) || (fin.agents || []).find((x) => x.name === n);
    const net = m ? Number(m.cash_to_pay ?? m.agent?.total ?? 0) : null;
    if (net != null && net <= 0.005) return true; // fully covered → N/A
    const pays = adminAgents[n]?.payments || [];
    return pays.some((p) => (p.paid_type && p.paid_type !== 'N/A' && p.paid_date) || p.paid_status === 'Paid' || p.paid_status === 'N/A');
  };
  const adminAgentPaidYes = agentNames.length > 0 && agentNames.every(agentPaidResolved);
  useEffect(() => {
    const v = adminAgentPaidYes ? 'Yes' : 'No';
    setForm((f) => (f.agent_commission_paid_status === v ? f : { ...f, agent_commission_paid_status: v }));
  }, [adminAgentPaidYes]);

  // Per-agent payment status, so each agent's status + breakdown shows independently
  // (a paid agent appears even while others are still pending). The overall
  // "Agent Commission Paid Status" field stays No until EVERY agent is resolved.
  const agentPaidLabel = (n: string): 'Paid' | 'Pending' | 'N/A' => {
    const m = (fin.members || []).find((x) => x.name === n) || (fin.agents || []).find((x) => x.name === n);
    const net = m ? Number(m.cash_to_pay ?? m.agent?.total ?? 0) : null;
    if (net != null && net <= 0.005) return 'N/A'; // fully covered by advance/adjustments
    const pays = adminAgents[n]?.payments || [];
    const paid = pays.some((p) => (p.paid_type && p.paid_type !== 'N/A' && p.paid_date) || p.paid_status === 'Paid' || p.paid_status === 'N/A');
    return paid ? 'Paid' : 'Pending';
  };
  // Reveal the per-agent breakdown as soon as ANY agent is resolved (Paid or N/A).
  const anyAgentPaid = agentNames.some((n) => agentPaidLabel(n) !== 'Pending');
  const STATUS_COLORS: Record<string, { bg: string; fg: string }> = { Paid: { bg: '#dcfce7', fg: '#166534' }, Pending: { bg: '#fef9c3', fg: '#854d0e' }, 'N/A': { bg: '#e5e7eb', fg: '#374151' } };
  const perAgentStatusCard = agentNames.length > 1 ? (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="modal-sub" style={{ marginTop: 0 }}>Agent Commission Paid — Status by Agent</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {agentNames.map((n) => {
          const st = agentPaidLabel(n); const c = STATUS_COLORS[st] || STATUS_COLORS.Pending;
          return (
            <div key={n} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, padding: '4px 0', borderBottom: '1px solid #f1f5f9' }}>
              <span style={{ fontWeight: 600 }}>{n}</span>
              <span style={{ background: c.bg, color: c.fg, fontWeight: 700, fontSize: 11, borderRadius: 999, padding: '3px 12px' }}>{st}</span>
            </div>
          );
        })}
      </div>
      <div className="help" style={{ marginTop: 8 }}>Each agent is tracked individually; the overall status above stays “No” until every agent is Paid (or N/A).</div>
    </div>
  ) : null;
  // Nothing to pay (Agent Commission total 0, single agent) → Ready to Process = N/A.
  useEffect(() => {
    if (naReady) setForm((f) => (f.ready_to_process === 'N/A' ? f : { ...f, ready_to_process: 'N/A' }));
  }, [naReady]);

  if (!open) return null;

  const set = <K extends keyof FaqForm>(k: K, v: FaqForm[K]) => setForm((f) => {
    const next: FaqForm = { ...f, [k]: v };
    if (k === 'docs_cleared' && v === 'Yes' && f.final_validation !== 'Done') next.final_validation = 'Pending';
    // Final Validation drives payment readiness: Done → Yes; any other value (Pending /
    // Invalid / unset), even on reselection → No. N/A when there's nothing to pay.
    if (k === 'final_validation' || k === 'docs_cleared') {
      if (naReady) next.ready_to_process = 'N/A';
      else if (next.final_validation === 'Done') next.ready_to_process = 'Yes';
      else next.ready_to_process = 'No';
    }
    return next;
  });
  const setTT = (k: number, patch: Partial<TermTrack>) => setForm((f) => {
    const cur = f.term_tracker[k] || EMPTY_TERM;
    const next: TermTrack = { ...cur, ...patch };
    if (patch.docs_cleared === 'Yes' && cur.final_validation !== 'Done') next.final_validation = 'Pending';
    // Same payment-readiness rule as the single form, per precon term: Done → Yes; any
    // other value (even on reselection) → No.
    if ('final_validation' in patch || 'docs_cleared' in patch) {
      if (next.final_validation === 'Done') next.ready_to_process = 'Yes';
      else next.ready_to_process = 'No';
    }
    return { ...f, term_tracker: { ...f.term_tracker, [k]: next } };
  });
  // Deposit slip (multiple) + client void cheque (single) — stored inline as data URIs.
  const addSlips = (files: FileList | null) => {
    Array.from(files || []).forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => setForm((f) => ({ ...f, deposit_slips: [...(f.deposit_slips || []), { name: file.name, data: reader.result as string }] }));
      reader.readAsDataURL(file);
    });
  };
  const rmSlip = (i: number) => setForm((f) => ({ ...f, deposit_slips: (f.deposit_slips || []).filter((_, idx) => idx !== i) }));
  const setVoidCheque = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setForm((f) => ({ ...f, void_cheque: { name: file.name, data: reader.result as string } }));
    reader.readAsDataURL(file);
  };
  const rmVoidCheque = () => setForm((f) => ({ ...f, void_cheque: null }));

  // ----- Breakdown Summary (Agent): one block per agent, shared by screen + PDF -----
  const money = (v: unknown) => formatCurrency(Number(v || 0));
  // Generated Commission rows come from the Listing Commission section (Financial Information).
  const dealComm: FinancialSection = listing ? (fin.listing || {}) : { commission: fin.commission, hst: fin.hst, total: fin.total };
  const genPct = listing ? (fin.listing?.pct ?? txn.listing_comm_pct ?? '') : (txn.comm_pct || '');
  // Adjustment / referral sources (from Adjustment & Advance Payment).
  const adj: Adjustments = txn.adjustments || {};
  const adjRows: AdjustmentRow[] = adj.agent_adjust === 'Yes' ? (adj.adjustment_rows || []) : [];
  const advanceRows: AdjustmentRow[] = adj.advance_payment === 'Yes' ? (adj.advance_rows || []) : [];
  const extReferralTotal = fin.ext_referral?.total != null
    ? Number(fin.ext_referral.total)
    : (adj.ext_referral === 'Yes' ? Number(adj.ext?.amount || 0) * 1.13 : 0);
  const clientReferralTotal = (adj.client_referral === 'Yes' ? (adj.client_rows || []) : [])
    .reduce((s, r) => s + Number(r.amount || 0), 0);
  // Adjustment Details "Amount" is stored positive=deduct / negative=add — show with that sign.
  const signedAdj = (v: number) => (v === 0 ? money(0) : `${v > 0 ? '-' : '+'}${money(Math.abs(v))}`);
  const bRow = (label: string, val: string, strong?: boolean) => `<div style="display:flex;justify-content:space-between;padding:9px 14px;border-bottom:1px solid #f1f5f9;font-size:13px"><span style="color:#334155">${label}</span><span style="${strong ? 'font-weight:600;' : ''}">${val}</span></div>`;
  const bBar = (label: string) => `<div style="background:#eef2f7;padding:8px 14px;text-align:right;font-size:11px;font-weight:700;color:#64748b;letter-spacing:.04em;text-transform:uppercase">${label}</div>`;
  const agentBlockHtml = (a: FinancialAgentLine) => {
    const m: FinancialAgentLine = (fin.members || []).find((x) => x.name === a.name) || {};
    // Agent Adjustments — the Adjustment Details "Amount" (with sign) for this agent.
    const agentAdj = adjRows.filter((r) => r.agent === a.name).reduce((s, r) => s + Number(r.amount || 0), 0);
    // Agent Advance — the Advance Payment Details "Amount" for this agent (a deduction).
    const agentAdvance = advanceRows.filter((r) => r.agent === a.name).reduce((s, r) => s + Number(r.amount || 0), 0);
    const brokerage = Number(a.brokerage?.total ?? m.brokerage_from_member ?? 0);
    // Net payable to the agent (after Agent Adjust / Advance deductions).
    const finalTotal = Number(m.cash_to_pay ?? a.agent?.total ?? 0);
    // Team Split Adjustment = this agent's split % applied to the generated commission.
    const splitPct = Number(a.split || 0);
    // Per-agent payment status badge shown at the top of each block.
    const status = agentPaidLabel(a.name || '');
    const sc = STATUS_COLORS[status] || STATUS_COLORS.Pending;
    const statusBadge = `<span style="background:${sc.bg};color:${sc.fg};font-weight:700;font-size:11px;border-radius:999px;padding:3px 12px">${status}</span>`;
    return `
      <div style="border:1px solid #e6e8ef;border-radius:10px;overflow:hidden;margin-bottom:14px">
        <div style="background:#f8fafc;padding:8px 14px;font-size:11px;font-weight:700;letter-spacing:.04em;color:#475569;text-transform:uppercase;display:flex;justify-content:space-between;align-items:center">Agent Name <span style="text-transform:none;letter-spacing:0">${statusBadge}</span></div>
        <div style="padding:8px 14px;font-weight:700;font-size:14px">${a.name || ''}</div>
        ${bBar('Property Details')}
        ${bRow('Property Name / MLS ID', `${txn.property || ''} / ${txn.mls_num || ''}`)}
        ${bRow('Type of Deal', txn.type || '')}
        ${bRow('Closing Date', txn.closing_date || '')}
        ${bRow('Deal Price', money(txn.price))}
        ${bRow('Generated Commission (% / $)', `${genPct ? genPct + '% / ' : ''}${money(dealComm.commission)}`)}
        ${bRow('Generated Commission HST', money(dealComm.hst))}
        ${bRow('Total', money(dealComm.total))}
        ${bBar('Adjustments & Commission Summary')}
        ${bRow('Team Split Adjustment', `${splitPct}% of ${money(dealComm.total)}`, true)}
        ${bRow('Agent Adjustments', signedAdj(agentAdj), true)}
        ${bRow('Agent Advance', agentAdvance ? `-${money(agentAdvance)}` : money(0), true)}
        ${bRow('External Brokerage Referral', money(extReferralTotal), true)}
        ${bRow('Client Referral', money(clientReferralTotal), true)}
        ${bRow('Brokerage Commission', money(brokerage), true)}
        <div style="display:flex;justify-content:space-between;padding:11px 14px;font-size:14px;font-weight:800"><span>Final Agent Total</span><span style="color:#c8102e">${money(finalTotal)}</span></div>
      </div>`;
  };
  // Only agents whose payment is resolved (Paid or N/A) get a breakdown block — a
  // still-pending agent shows in the status list but has no breakdown yet.
  const breakdownAgents = (fin.agents || []).filter((a) => agentPaidLabel(a.name || '') !== 'Pending');
  const agentDocHtml = breakdownAgents.length
    ? breakdownAgents.map(agentBlockHtml).join('')
    : '<div style="padding:14px;color:#64748b;font-size:13px">No agent commission breakdown available.</div>';
  const agentDocTitle = `Agent Breakdown - ${txn.trade_no || ''}`;

  // ----- Client Payment Breakdown (matches the Client Payment template) -----
  const L: FinancialSection = fin.listing || {};
  const Cc: FinancialSection = fin.coop || {};
  const T: Partial<CommissionAmounts> = fin.totals || {};
  const paidDate = txn.admin_activities?.paid_client?.date || new Date().toISOString().slice(0, 10);
  // Deposit Date comes from Admin Activities → Deposits section (first dated entry).
  const depositDate = (txn.admin_activities?.deposits || []).map((d) => d.date).filter(Boolean)[0] || '';
  const pctAmt = (sec: FinancialSection | undefined) => `${sec?.pct ? sec.pct + '% / ' : ''}${money(sec?.commission)}`;
  const clientPayment = Number(txn.deposit || 0) - Number(T.total || 0);
  const blank = '<span style="display:inline-block;min-width:240px;border-bottom:1px dotted #94a3b8">&nbsp;</span>';
  const ln = (val: unknown) => (val !== undefined && val !== null && String(val) !== '' ? String(val) : blank);
  const li = (label: string, val: string) => `<li style="margin-bottom:6px"><strong>${label}:</strong> ${val}</li>`;
  const clientDocHtml = `
    <div style="text-align:center;margin-bottom:6px">
      <div style="font-size:24px;font-weight:800;color:#c8102e">GET<span style="color:#0f172a">&#9730;</span>HOME REALTY</div>
      <div style="font-size:11px;font-style:italic;color:#64748b">"A Tradition of Trust" — Brokerage</div>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin:14px 0">
      <div style="background:#c8102e;color:#fff;font-weight:800;padding:6px 16px;border-radius:4px;font-size:18px">Client Payment :</div>
      <div style="font-weight:700">Date: ${ln(paidDate)}</div>
    </div>
    <p style="font-weight:700;margin:6px 0">Trade No: ${ln(txn.trade_no)}</p>
    <p style="font-weight:700;text-decoration:underline;margin:10px 0 4px">Property Details:</p>
    <ul style="line-height:1.7;margin:0;padding-left:20px;font-size:13px">
      ${li('Property Name / MLS ID', `${txn.property || ''}${txn.mls_num ? ' / ' + txn.mls_num : ''}`)}
      ${li('Type of Listing', ln(txn.type))}
      ${li('Listing Price', `$${money(txn.price).replace('$', '')}`)}
      ${li('Deposit Received', `$${money(txn.deposit).replace('$', '')}`)}
      ${li('Deposit Date', ln(depositDate))}
      ${li('Closing Date', ln(txn.closing_date))}
      ${li('Listing Agent', ln(txn.agent))}
    </ul>
    <p style="font-weight:700;text-decoration:underline;margin:12px 0 4px">Breakdown Summary:</p>
    <ul style="line-height:1.7;margin:0;padding-left:20px;font-size:13px">
      ${li('Client Name', ln(form.client_name))}
      ${li('Name on Received Client Void Cheque', ln(form.void_cheque_name))}
      <li style="margin-bottom:6px"><strong>Client Account Details (Payment Made To):</strong></li>
      <li style="list-style:none;margin:0 0 6px -20px">Inst no.: ${ln(form.client_inst_no)} Transit no.: ${ln(form.client_transit_no)} Account no.: ${ln(form.client_account_no)}</li>
      ${li('Deposit Received', money(txn.deposit))}
      ${li('Listing Commission (% / $)', pctAmt(L))}
      ${li('Listing Commission HST', money(L.hst))}
      ${li('Co-op Commission (% / $)', pctAmt(Cc))}
      ${li('Co-op Commission HST', money(Cc.hst))}
      ${li('Total Commission without HST', money(T.commission))}
      ${li('Total Commission HST', money(T.hst))}
      ${li('Total Commission with HST', money(T.total))}
    </ul>
    <p style="font-weight:700;font-style:italic;margin:12px 0 6px">Deposit Received - Total Commission with HST = Client Payment</p>
    <p style="font-weight:700;font-size:15px;margin:0 0 6px">${money(txn.deposit)} - ${money(T.total)} = <span style="color:#c8102e">${money(clientPayment)}</span></p>`;
  const clientDocTitle = `Client Payment - ${txn.trade_no || ''}`;

  const save = async () => {
    setSaving(true);
    try {
      const updated = await updateTransaction(transactionId, { activity_tracker: form });
      onSaved?.(updated);
      setSavedOk(true);
      setTimeout(() => { setSavedOk(false); onClose(); }, 2000);
    } catch (e) { toast(apiErrorMessage(e, 'Could not save'), 'bad'); setSaving(false); }
  };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal xl">
        <button className="close" onClick={onClose}>✕</button>
        {/*
          TD-049 — named for what it does. This panel holds no FAQ and never did: it is the
          agent-payment readiness workflow (docs cleared, final validation, ready to process,
          commission paid). Filed under "FAQ" nobody looking for a payment status would open it.
          The stored identifiers keep their old names on purpose — see the note in
          `TransactionDetailPage`'s Quick Actions button.
        */}
        <div className="modal-h">Agent Payment Readiness</div>

        {dftNA && (
          <div className="card" style={{ borderLeft: '4px solid var(--bad)', background: '#fff7ed', marginBottom: 12 }}>
            <strong style={{ color: '#9a3412' }}>🔒 DFT — Deal Fell Through.</strong>{' '}
            <span style={{ fontSize: 12.5, color: '#7c2d12' }}>All statuses default to N/A and are locked.</span>
          </div>
        )}
        {readOnly && !dftNA && !isAgent && (
          <div className="card" style={{ borderLeft: '4px solid #2563eb', background: '#eff6ff', marginBottom: 12 }}>
            <span style={{ fontSize: 12.5, color: '#1e3a8a' }}>🔒 View-only — click <strong>Edit</strong> on the transaction to make changes.</span>
          </div>
        )}

        {/* Batch review-email — editable by agents even though the rest is read-only. */}
        {!referral && !depositSlipOnly && (
        <div style={{ background: '#f9fafb', border: '1px solid var(--line)', borderRadius: 8, padding: 12, marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Send client review email (batch)</div>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <input type="checkbox" checked={form.batch_review_email} disabled={dftNA || (readOnly && !allowBatchEmail)} onChange={(e) => set('batch_review_email', e.target.checked)} /> Include this transaction in batch review emails
          </label>
        </div>
        )}

        <fieldset disabled={dftNA || readOnly} style={{ border: 0, margin: 0, padding: 0, minInlineSize: 0 }}>

        {depositSlipOnly ? (
          <div className="card">
            <div className="modal-sub" style={{ marginTop: 0 }}>Deposit Slip</div>
            <div className="help" style={{ marginBottom: 8 }}>Upload one or more deposit slip files.</div>
            <input type="file" multiple accept="image/*,application/pdf" onChange={(e) => { addSlips(e.target.files); e.target.value = ''; }} />
            {(form.deposit_slips || []).length === 0
              ? <div className="help" style={{ marginTop: 8 }}>No deposit slips uploaded yet.</div>
              : <div style={{ marginTop: 8 }}>{form.deposit_slips.map((s, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12.5, padding: '3px 0' }}>
                  <a className="prop-link" href={s.data} target="_blank" rel="noreferrer" download={s.name}>{s.name}</a>
                  <button className="row-rm" onClick={() => rmSlip(i)}>🗑️</button>
                </div>))}</div>}
          </div>
        ) : (<>

        {precon && (<>
          <div className="field" style={{ maxWidth: 280 }}><label style={lbl}>Details of Terms — Show</label>
            <select value={termFilter} onChange={(e) => setTermFilter(e.target.value)}>
              <option value="All">All Terms</option>
              {termsArr.map((k) => <option key={k} value={k}>Term {k}</option>)}
            </select></div>
          {termCount === 0 && <div className="help">Set "Commission Receivable in Terms" in Preconstruction Details first.</div>}
          {termsArr.filter((k) => termFilter === 'All' || String(termFilter) === String(k)).map((k) => {
            const t = form.term_tracker[k] || EMPTY_TERM;
            return (
              <div className="card" key={k} style={{ marginBottom: 14 }}>
                <div className="modal-sub" style={{ marginTop: 0 }}>Term {k} — Validation</div>
                <div className="g3">
                  <div className="field"><label style={lbl}>Invoice Sent</label><select value={na(t.invoice_sent)} onChange={(e) => setTT(k, { invoice_sent: e.target.value })}><option value="">Select</option><option>Yes</option><option>No</option><option>N/A</option></select></div>
                  <div className="field"><label style={lbl}>Invoice Number</label><input value={t.invoice_number} onChange={(e) => setTT(k, { invoice_number: e.target.value })} placeholder="INV-####" /></div>
                  <div className="field"><label style={lbl}>Commission Received Date</label><input type="date" value={invByTerm[k]?.commission_received_date || t.commission_received_date || ''} readOnly style={{ background: '#f9fafb' }} /><span className="help">Auto-reflected from Admin Activities.</span></div>
                </div>
                <div className="g3">
                  <div className="field"><label style={lbl}>Valid Docs Cleared from Agent</label><select value={t.docs_cleared} onChange={(e) => setTT(k, { docs_cleared: e.target.value })}><option value="">Select</option><option>Yes</option><option>No</option></select></div>
                  <div className="field"><label style={lbl}>Final Validation</label><select value={t.final_validation} onChange={(e) => setTT(k, { final_validation: e.target.value })}><option value="">Select</option><option>Done</option><option>Pending</option><option>Invalid</option></select><span className="help">Auto-set to Pending when docs cleared = Yes.</span></div>
                  <div className="field"><label style={lbl}>Ready to Process This Week</label><select value={na(t.ready_to_process)} onChange={(e) => setTT(k, { ready_to_process: e.target.value })}><option value="">Select</option><option>Yes</option><option>No</option><option>N/A</option></select></div>
                </div>
                <div className="field" style={{ marginTop: 8 }}><label style={lbl}>Remarks</label><textarea rows={2} value={t.remarks} onChange={(e) => setTT(k, { remarks: e.target.value })} placeholder={`Remarks for Term ${k}…`} /></div>
              </div>
            );
          })}
        </>)}

        {isFaqV2 && (<>
          {/* Upload cards */}
          <div className="g2" style={{ marginBottom: 14 }}>
            <div className="card">
              <div className="modal-sub" style={{ marginTop: 0 }}>Deposit Slip</div>
              <div className="help" style={{ marginBottom: 8 }}>Upload one or more deposit slip files.</div>
              <input type="file" multiple accept="image/*,application/pdf" onChange={(e) => { addSlips(e.target.files); e.target.value = ''; }} />
              {(form.deposit_slips || []).length === 0
                ? <div className="help" style={{ marginTop: 8 }}>No deposit slips uploaded yet.</div>
                : <div style={{ marginTop: 8 }}>{form.deposit_slips.map((s, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12.5, padding: '3px 0' }}>
                    <a className="prop-link" href={s.data} target="_blank" rel="noreferrer" download={s.name}>{s.name}</a>
                    <button className="row-rm" onClick={() => rmSlip(i)}>🗑️</button>
                  </div>))}</div>}
            </div>
            {!clientNA && (
              <div className="card">
                <div className="modal-sub" style={{ marginTop: 0 }}>Client Void Cheque</div>
                <div className="help" style={{ marginBottom: 8 }}>Upload the client void cheque (single file).</div>
                <input type="file" accept="image/*,application/pdf" onChange={(e) => { setVoidCheque(e.target.files?.[0]); e.target.value = ''; }} />
                {!form.void_cheque
                  ? <div className="help" style={{ marginTop: 8 }}>No void cheque uploaded yet.</div>
                  : <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12.5, marginTop: 8 }}>
                    <a className="prop-link" href={form.void_cheque.data} target="_blank" rel="noreferrer" download={form.void_cheque.name}>{form.void_cheque.name}</a>
                    <button className="row-rm" onClick={rmVoidCheque}>🗑️</button>
                  </div>}
              </div>
            )}
          </div>

          <div className="g2">
            <div className="field"><label style={lbl}>Valid Docs Cleared from Agent</label>
              <select value={form.docs_cleared} onChange={(e) => set('docs_cleared', e.target.value)}><option value="">Select</option><option>Yes</option><option>No</option></select>
              <span className="help">Auto-set to Yes when every Legal &amp; Documentation item is Received &amp; Valid.</span></div>
            <div className="field"><label style={lbl}>Final Validation</label>
              <select value={form.final_validation} onChange={(e) => set('final_validation', e.target.value)}><option value="">Select</option><option>Done</option><option>Pending</option><option>Invalid</option></select>
              <span className="help">Auto-set to Pending when Valid Docs Cleared = Yes.</span></div>
          </div>
          {form.final_validation === 'Invalid' && (
            <div className="field"><label style={lbl}>Final Validation Remarks</label><textarea rows={3} value={form.final_validation_remarks} onChange={(e) => set('final_validation_remarks', e.target.value)} placeholder="Reason for invalid validation…" /></div>
          )}
          <div className="g2">
            <div className="field"><label style={lbl}>Ready to Process Agent Payment</label>
              <select value={na(form.ready_to_process)} onChange={(e) => set('ready_to_process', e.target.value)}><option value="">Select</option><option>Yes</option><option>No</option><option>N/A</option></select>
              <span className="help">Auto-set to Yes when Final Validation = Done (change to N/A manually if needed); No when Docs cleared = Yes but validation still Pending.</span></div>
            <div className="field"><label style={lbl}>Client Payment Paid</label>
              <select value={na(clientNA ? 'N/A' : form.client_payment_paid)} disabled={clientNA} onChange={(e) => set('client_payment_paid', e.target.value)}><option value="">Select</option><option>Yes</option><option>No</option><option>N/A</option></select>
              <span className="help">{clientNA ? 'Payable to Client is $0 — set to N/A automatically.' : 'Auto-set to Yes when Admin Activities “Paid to Client?” is Yes. When Yes, the Breakdown Summary (Client) card appears below.'}</span></div>
          </div>
          <div className="g2">
            <div className="field"><label style={lbl}>Agent Commission Paid Status</label>
              <input value={na(form.agent_commission_paid_status) || 'No'} readOnly style={{ background: '#f9fafb', fontWeight: 600 }} />
              <span className="help">Auto — stays No until <strong>every</strong> agent's payment is resolved in Admin Activities (Paid Type + Paid Date, or fully covered → N/A). Each agent's own status and breakdown appear individually below.</span></div>
          </div>
          {perAgentStatusCard}

          {form.client_payment_paid === 'Yes' && (
            <div className="card" style={{ marginTop: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 8, flexWrap: 'wrap' }}>
                <div className="modal-sub" style={{ margin: 0 }}>Breakdown Summary (Client)</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn ghost sm" onClick={() => printDoc(clientDocTitle, clientDocHtml, false)}>👁 View</button>
                  <button className="btn primary sm" onClick={() => printDoc(clientDocTitle, clientDocHtml)}>📄 Download PDF</button>
                </div>
              </div>
              <div style={{ textAlign: 'center', marginBottom: 6 }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: '#c8102e' }}>GET<span style={{ color: '#0f172a' }}>&#9730;</span>HOME REALTY</div>
                <div style={{ fontSize: 11, fontStyle: 'italic', color: '#64748b' }}>"A Tradition of Trust" — Brokerage</div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '12px 0' }}>
                <span style={{ background: '#c8102e', color: '#fff', fontWeight: 800, padding: '5px 14px', borderRadius: 4, fontSize: 16 }}>Client Payment :</span>
                <span style={{ fontWeight: 700 }}>Date: {paidDate || '—'}</span>
              </div>
              <p style={{ fontWeight: 700, margin: '6px 0' }}>Trade No: {txn.trade_no || ''}</p>
              <p style={{ fontWeight: 700, textDecoration: 'underline', margin: '10px 0 4px' }}>Property Details:</p>
              <ul style={{ lineHeight: 1.7, margin: 0, paddingLeft: 20, fontSize: 13 }}>
                <li><strong>Property Name / MLS ID:</strong> {txn.property || ''}{txn.mls_num ? ` / ${txn.mls_num}` : ''}</li>
                <li><strong>Type of Listing:</strong> {txn.type || ''}</li>
                <li><strong>Listing Price:</strong> {formatCurrency(txn.price)}</li>
                <li><strong>Deposit Received:</strong> {formatCurrency(txn.deposit)}</li>
                <li><strong>Deposit Date:</strong> {depositDate || '—'}</li>
                <li><strong>Closing Date:</strong> {txn.closing_date || '—'}</li>
                <li><strong>Listing Agent:</strong> {txn.agent || '—'}</li>
              </ul>
              <p style={{ fontWeight: 700, textDecoration: 'underline', margin: '12px 0 4px' }}>Breakdown Summary:</p>
              <ul style={{ lineHeight: 1.9, margin: 0, paddingLeft: 20, fontSize: 13 }}>
                <li><strong>Client Name:</strong> <input value={form.client_name} onChange={(e) => set('client_name', e.target.value)} style={editLine} /></li>
                <li><strong>Name on Received Client Void Cheque:</strong> <input value={form.void_cheque_name} onChange={(e) => set('void_cheque_name', e.target.value)} style={editLine} /></li>
                <li><strong>Client Account Details (Payment Made To):</strong></li>
                <li style={{ listStyle: 'none', marginLeft: -20 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'nowrap' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 }}>Inst no.: <input value={form.client_inst_no} onChange={(e) => set('client_inst_no', e.target.value)} style={{ ...editLine, minWidth: 0, flex: 1 }} /></span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 }}>Transit no.: <input value={form.client_transit_no} onChange={(e) => set('client_transit_no', e.target.value)} style={{ ...editLine, minWidth: 0, flex: 1 }} /></span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 }}>Account no.: <input value={form.client_account_no} onChange={(e) => set('client_account_no', e.target.value)} style={{ ...editLine, minWidth: 0, flex: 1 }} /></span>
                  </div>
                </li>
                <li><strong>Deposit Received:</strong> {formatCurrency(txn.deposit)}</li>
                <li><strong>Listing Commission (% / $):</strong> {pctAmt(L)}</li>
                <li><strong>Listing Commission HST:</strong> {formatCurrency(L.hst)}</li>
                <li><strong>Co-op Commission (% / $):</strong> {pctAmt(Cc)}</li>
                <li><strong>Co-op Commission HST:</strong> {formatCurrency(Cc.hst)}</li>
                <li><strong>Total Commission without HST:</strong> {formatCurrency(T.commission)}</li>
                <li><strong>Total Commission HST:</strong> {formatCurrency(T.hst)}</li>
                <li><strong>Total Commission with HST:</strong> {formatCurrency(T.total)}</li>
              </ul>
              <p style={{ fontWeight: 700, fontStyle: 'italic', margin: '12px 0 6px' }}>Deposit Received - Total Commission with HST = Client Payment</p>
              <p style={{ fontWeight: 700, fontSize: 15, margin: 0 }}>{formatCurrency(txn.deposit)} - {formatCurrency(T.total)} = <span style={{ color: '#c8102e' }}>{formatCurrency(clientPayment)}</span></p>
            </div>
          )}
          {anyAgentPaid && (
            <div className="card" style={{ marginTop: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 8, flexWrap: 'wrap' }}>
                <div className="modal-sub" style={{ margin: 0 }}>Breakdown Summary (Agent)</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn ghost sm" onClick={() => printDoc(agentDocTitle, agentDocHtml, false)}>👁 View</button>
                  <button className="btn primary sm" onClick={() => printDoc(agentDocTitle, agentDocHtml)}>📄 Download PDF</button>
                </div>
              </div>
              <div dangerouslySetInnerHTML={{ __html: agentDocHtml }} />
            </div>
          )}
        </>)}

        {!precon && !isFaqV2 && (<>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 12 }}>
          <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Invoice Status</label><input value={invAdmin.invoice_sent_status || '—'} readOnly style={{ background: '#f9fafb' }} /><span className="help">Auto-reflected from Admin Activities.</span></div>
          <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Commission Received Date</label><input type="date" value={invAdmin.commission_received_date || form.commission_received_date || ''} readOnly style={{ background: '#f9fafb' }} /><span className="help">Auto-reflected from Admin Activities.</span></div>
          <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Valid Docs Cleared from Agent</label>
            <select value={form.docs_cleared} onChange={(e) => set('docs_cleared', e.target.value)}><option value="">Select</option><option>Yes</option><option>No</option></select>
            <span className="help">Auto-set to Yes when every Legal &amp; Documentation item is Received &amp; Valid.</span></div>
          <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Final Validation</label>
            <select value={form.final_validation} onChange={(e) => set('final_validation', e.target.value)}><option value="">Select</option><option>Done</option><option>Pending</option><option>Invalid</option></select>
            <span className="help">Auto-set to Pending when docs cleared = Yes.</span></div>
        </div>
        {form.final_validation === 'Invalid' && (
          <div className="field"><label style={lbl}>Final Validation Remarks</label><textarea rows={3} value={form.final_validation_remarks} onChange={(e) => set('final_validation_remarks', e.target.value)} placeholder="Reason for invalid validation…" /></div>
        )}
        <div className="g2">
          <div className="field"><label style={lbl}>Ready to Process Agent Payment</label>
            <select value={form.ready_to_process} onChange={(e) => set('ready_to_process', e.target.value)}><option value="">Select</option><option>Yes</option><option>No</option><option>N/A</option></select>
            <span className="help">Auto-set to Yes when Final Validation = Done (change to N/A manually if needed); No when Docs cleared = Yes but validation still Pending.</span></div>
          <div className="field"><label style={lbl}>Agent Commission Paid Status</label>
            <input value={na(form.agent_commission_paid_status) || 'No'} readOnly style={{ background: '#f9fafb', fontWeight: 600 }} />
            <span className="help">Auto — stays No until <strong>every</strong> agent's payment is resolved in Admin Activities (Paid Type + Paid Date, or fully covered → N/A). Each agent's own status and breakdown appear individually below.</span></div>
          {listing && (
            <div className="field"><label style={lbl}>Client Payment Paid</label>
              <select value={na(form.client_payment_paid)} onChange={(e) => set('client_payment_paid', e.target.value)}><option value="">Select</option><option>Yes</option><option>No</option><option>N/A</option></select></div>
          )}
        </div>
        {perAgentStatusCard}

        {anyAgentPaid && (
          <div className="card" style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 8, flexWrap: 'wrap' }}>
              <div className="modal-sub" style={{ margin: 0 }}>Breakdown Summary (Agent)</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn ghost sm" onClick={() => printDoc(agentDocTitle, agentDocHtml, false)}>👁 View</button>
                <button className="btn primary sm" onClick={() => printDoc(agentDocTitle, agentDocHtml)}>📄 Download PDF</button>
              </div>
            </div>
            <div dangerouslySetInnerHTML={{ __html: agentDocHtml }} />
          </div>
        )}

        </>)}

        </>)}

        </fieldset>

        <SavedBadge show={savedOk} />

        <div className="actions">
          <button className="btn ghost" onClick={onClose}>Close</button>
          {(!readOnly || allowBatchEmail) && <button className="btn primary" onClick={save} disabled={saving || dftNA || savedOk}>{savedOk ? '✓ Saved' : (saving ? 'Saving…' : 'Save')}</button>}
        </div>
      </div>
    </div>
  );
}
