import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { updateTransaction, getAgentCommissions, getAgentLoans, getTransaction, requestTransactionEdit, approveEditRequest, rejectEditRequest } from '../lib/api';
import { formatCurrency, parseNumber, isListingFinancialType, isPreconType } from './format';
import Icon from '../ui/Icon';
import { agentAdjustments, referralSections, agentCommissionsAfterClient, agentCommissionLine, listingBreakdown, type AgentAdjustment } from './commissionCalc';
import MoneyInput from './MoneyInput';
import { useToast } from './toast';
import { apiErrorMessage } from '../lib/apiError';
import { useAuth } from '../context/AuthContext';
import SavedBadge from './SavedBadge';
import type { AgentCommissionMap, AgentLoanMap, CommissionAmounts, TeamMemberData, Transaction } from '../types';

const HST = 0.13;
const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const clampPct = (n: number): number => Math.max(0, Math.min(100, n));
const lineOf = (wo: number): CommissionAmounts => ({ commission: r2(wo), hst: r2(wo * HST), total: r2(wo * (1 + HST)) });
// Like lineOf, but the adjustment is subtracted from the Total only — Commission
// and HST stay at their gross values.
const lineLessTotal = (wo: number, deduct = 0): CommissionAmounts => ({ commission: r2(wo), hst: r2(wo * HST), total: r2(wo * (1 + HST) - deduct) });

// Field colours: Commission/HST blue, Total green — any negative value shows red.
const commColor = (v: number) => (v < 0 ? 'var(--bad)' : 'var(--info)');
const totalColor = (v: number) => (v < 0 ? 'var(--bad)' : 'var(--ok-600)');
const cs = (v: number): CSSProperties => ({ fontWeight: 700, color: commColor(v) }); // Commission / HST style (bold, like Total)
const pctStyle: CSSProperties = { fontWeight: 700, color: 'var(--bad)' }; // % fields: bold red
const ts = (v: number): CSSProperties => ({ fontWeight: 700, color: totalColor(v) }); // Total style

// Itemize an agent's deduction breakdown (from agentAdjustments) into a label,
// e.g. "adjustment $300.00 + advance $200.00". Only non-zero parts are shown.
const ADJ_PARTS: [keyof AgentAdjustment, string][] = [['agentAdjust', 'adjustment'], ['advance', 'advance']];
const adjLabel = (d: AgentAdjustment) => ADJ_PARTS.filter(([k]) => (d[k] as number) > 0).map(([k, name]) => `${name} ${formatCurrency(d[k] as number)}`).join(' + ');

// Commission-adjustment note (under Commission / Total). Positive = reduces (Less),
// negative = increases (Plus). `amt` is the signed value from a 'sub'-convention field.
const adjNote = (amt: number, when: string) => (amt === 0 ? null : `${amt > 0 ? 'Less' : 'Plus'} adjustment ${formatCurrency(Math.abs(amt))} (${when})`);

/** A team member as edited within this modal (split/pct held as number|string). */
interface FinMember {
  name?: string;
  split: number | string;
  agent_pct: number | string;
  brok_pct: number | string;
  scope?: string;
  terms?: number[];
}
type FinMemberKey = 'name' | 'split' | 'agent_pct' | 'brok_pct' | 'scope';
/** One rendered agent row (standard + listing share the card design). */
interface AgentRow {
  m: FinMember;
  agent: CommissionAmounts;
  brok: CommissionAmounts;
  t4a: CommissionAmounts;
  adj: AgentAdjustment;
}
/** Referral view passed to the ReferralSections card. */
interface ReferralView {
  showBroker: boolean;
  showClient: boolean;
  brokerAmount: number;
  clientAmount: number;
  afterBroker: CommissionAmounts;
  afterClient: CommissionAmounts;
}
interface PreconTermRow { term_no: number; pct: number | string; closing_date: string; }

interface FinancialModalProps {
  open: boolean;
  onClose: () => void;
  transactionId: number | string;
  txn: Transaction;
  termCount?: number | string | null;
  onSaved?: (updated: Transaction) => void;
  hideClientCommission?: boolean;
  dftNA?: boolean;
  readOnly?: boolean;
  isAgent?: boolean;
}

export default function FinancialModal({ open, onClose, transactionId, txn, termCount: termCountProp, onSaved, hideClientCommission = false, dftNA = false, readOnly: readOnlyProp = false, isAgent = false }: FinancialModalProps) {
  const toast = useToast();
  const { isSuperAdmin } = useAuth();
  // Financial edit lock: Price, Deposit and Commission fields are locked for everyone
  // except a Super Admin. Each field shows an edit pencil; clicking it sends an edit
  // request that a Super Admin must approve. One approval unlocks these fields; they
  // re-lock after the next save.
  const finReqs = (txn.edit_requests || []).filter((r) => r.scope === 'financial');
  const pendingFinReq = finReqs.find((r) => r.status === 'pending');
  const approvedFinReq = finReqs.find((r) => r.status === 'approved');
  const finLock = !isSuperAdmin && !approvedFinReq; // the specific fields are locked
  const readOnly = readOnlyProp; // view-mode read-only (unchanged); finLock is per-field
  const [reqBusy, setReqBusy] = useState(false);
  const [reasonOpen, setReasonOpen] = useState(false); // reason prompt for the edit request
  const [reason, setReason] = useState('');
  const refreshTxn = () => getTransaction(transactionId).then((t) => onSaved?.(t)).catch(() => {});
  const askFinancialEdit = async () => {
    if (!reason.trim()) { toast('Please enter a reason for the edit', 'bad'); return; }
    setReqBusy(true);
    try { await requestTransactionEdit(transactionId, reason.trim(), 'financial'); toast('Edit request sent to Super Admin for approval', 'ok'); setReasonOpen(false); setReason(''); await refreshTxn(); }
    catch (e) { toast(apiErrorMessage(e, 'Could not send request'), 'bad'); }
    finally { setReqBusy(false); }
  };
  const approveFinReq = async () => { if (!pendingFinReq) return; setReqBusy(true); try { await approveEditRequest(pendingFinReq.id); toast('Approved — financial fields unlocked', 'ok'); await refreshTxn(); } catch { toast('Could not approve', 'bad'); } finally { setReqBusy(false); } };
  const rejectFinReq = async () => { if (!pendingFinReq) return; setReqBusy(true); try { await rejectEditRequest(pendingFinReq.id); toast('Request rejected', 'ok'); await refreshTxn(); } catch { toast('Could not reject', 'bad'); } finally { setReqBusy(false); } };
  const finLockStyle: CSSProperties = { background: 'var(--surface-3)', cursor: 'not-allowed' };
  // Edit pencil rendered next to a locked field's label (mirrors Agent Comm %).
  const finPencil = (): ReactNode => (finLock ? (
    <button type="button" className="row-rm" disabled={reqBusy || !!pendingFinReq}
      title={pendingFinReq ? 'Edit approval pending with Super Admin' : 'Locked — click to request Super Admin approval to edit'}
      onClick={() => { setReason(''); setReasonOpen(true); }} style={{ marginLeft: 4, color: pendingFinReq ? 'var(--warn)' : 'var(--brand)' }}>
      {pendingFinReq ? <Icon name="clock" size={14} /> : <><Icon name="lock" size={14} /><Icon name="edit" size={14} /></>}
    </button>
  ) : null);

  const listing = isListingFinancialType(txn.type);
  const precon = isPreconType(txn.type);
  const referral = txn.type === 'Referral';
  // Live term count from the detail form (so typing it divides immediately), falling back to the saved value.
  const termCount = (termCountProp != null && termCountProp !== '') ? Number(termCountProp) : (Number(txn.precon_term_count) || 0);

  const [price, setPrice] = useState<number | string>(txn.price ?? 0);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false); // §3.2 — "Saved" then auto-close

  // standard
  const [commPct, setCommPct] = useState<number | string>(txn.comm_pct ?? (txn.comm_type === '%' ? txn.comm_value : '') ?? '');
  const [commAmt, setCommAmt] = useState<number | string>(txn.comm_amt ?? '');
  const [adjEnabled, setAdjEnabled] = useState(!!txn.comm_adjust_enabled);
  const [adjBefore, setAdjBefore] = useState<number>(txn.comm_adjust_before ?? 0);
  const [adjAfter, setAdjAfter] = useState<number>(txn.comm_adjust_after ?? 0);
  const [members, setMembers] = useState<FinMember[]>(() => {
    const t: TeamMemberData[] = (txn.team && txn.team.length) ? txn.team : (txn.agent ? [{ name: txn.agent, split: 100, agent_pct: 90, brok_pct: 10 }] : []);
    return t.map((m) => ({ name: m.name, split: m.split ?? 100, agent_pct: m.agent_pct ?? 90, brok_pct: m.brok_pct ?? 10, scope: m.scope || 'Entire', terms: m.terms || [] }));
  });
  // Agent Comm (%) and Brok Comm (%) are complementary: editing one fills the
  // other with the remaining percentage (e.g. Agent 80 → Brokerage 20).
  const setMember = (i: number, k: FinMemberKey, v: string) => setMembers((ms) => ms.map((m, idx) => {
    if (idx !== i) return m;
    if (k === 'agent_pct') return { ...m, agent_pct: v, brok_pct: r2(clampPct(100 - parseNumber(v))) };
    if (k === 'brok_pct') return { ...m, brok_pct: v, agent_pct: r2(clampPct(100 - parseNumber(v))) };
    return { ...m, [k]: v };
  }));
  // Agent Comm (%) is locked by default per member (pencil unlocks); Brok Comm (%) stays locked.
  const [agentUnlock, setAgentUnlock] = useState<Record<number, boolean>>({});
  const lockField: CSSProperties = { background: 'var(--surface-3)', cursor: 'not-allowed' };

  // Each agent's registered default commission split (from their user profile).
  // Used to pre-fill Agent Comm (%) and to flag transaction-specific overrides.
  const leaseType = /lease/i.test(txn.type);
  const [agentDefaults, setAgentDefaults] = useState<AgentCommissionMap>({});
  useEffect(() => { if (open) getAgentCommissions().then(setAgentDefaults).catch(() => {}); }, [open]);

  // Loan reminder — when a deal is ready for payment (Closed / Secured Firm) and an
  // agent on it still owes on a loan, alert admins to record a loan-repayment
  // adjustment (capped at the agent's Agent Commission total).
  const [agentLoans, setAgentLoans] = useState<AgentLoanMap>({});
  const [loanAlertSeen, setLoanAlertSeen] = useState(false);
  useEffect(() => { if (open) getAgentLoans().then(setAgentLoans).catch(() => {}); }, [open]);
  useEffect(() => { if (!open) setLoanAlertSeen(false); }, [open]);
  const READY_FOR_PAYMENT = [
    'Closed', 'Secured Firm', 'Secured Conditional', 'Secured Conditionally',
    'Sold', 'Sold Conditional', 'Leased', 'Lease Conditional',
  ];
  const readyForPayment = (txn.statuses || []).some((s) => READY_FOR_PAYMENT.includes(s));
  // Loan repayment already recorded for an agent on THIS deal (from saved adjustments).
  const loanRepaidThisDeal = (name: string | undefined) => (txn.adjustments?.agent_adjust !== 'Yes' ? 0
    : ((txn.adjustments?.adjustment_rows) || [])
        .filter((r) => r.agent === name && r.is_loan)
        .reduce((s, r) => s + Math.max(0, parseNumber(r.amount)), 0));
  const loanAgents = !isAgent && readyForPayment
    ? members
        .map((m) => ({ name: m.name, adjusted: loanRepaidThisDeal(m.name), balance: (m.name ? agentLoans[m.name]?.loan_balance : 0) || 0 }))
        .filter((x) => x.name && (x.adjusted > 0 || x.balance > 0))
    : [];
  // Once a loan repayment is recorded on this deal the reminder popup is silenced;
  // only agents with an outstanding loan and nothing adjusted here still prompt.
  const pendingLoanAgents = loanAgents.filter((x) => x.adjusted <= 0 && x.balance > 0);
  const adjustedLoanAgents = loanAgents.filter((x) => x.adjusted > 0);
  const defaultPctFor = (name: string | undefined): number | null => {
    if (!name) return null;
    const d = agentDefaults[name];
    if (!d) return null;
    const v = leaseType ? (d.lease_pct ?? d.agent_pct) : d.agent_pct;
    return (v === null || v === undefined) ? null : parseNumber(v);
  };
  // For transactions not yet customised via Team Split, seed Agent Comm (%) from
  // the agent's registered default once it loads.
  const hadSavedTeam = !!(txn.team && txn.team.length);
  useEffect(() => {
    if (hadSavedTeam) return;
    setMembers((ms) => ms.map((m) => {
      const def = defaultPctFor(m.name);
      if (def === null) return m;
      return { ...m, agent_pct: def, brok_pct: r2(clampPct(100 - def)) };
    }));
  }, [agentDefaults]); // eslint-disable-line react-hooks/exhaustive-deps
  // Pre-HST per-agent deductions (Agent Adjust / Advance / referrals), aligned to members.
  const memberDeduct = agentAdjustments(txn.adjustments, members);

  // listing
  const [listPct, setListPct] = useState<number | string>(txn.listing_comm_pct ?? '');
  const [coopPct, setCoopPct] = useState<number | string>(txn.coop_comm_pct ?? '');
  const [listFlat, setListFlat] = useState<number | string>(txn.listing_comm_flat ?? '');
  const [coopFlat, setCoopFlat] = useState<number | string>(txn.coop_comm_flat ?? '');
  const [trustPayable, setTrustPayable] = useState<number | string>(txn.trust_payable ?? ''); // manual "Payable to Client" for Trust Verification
  const [commAdjMaster, setCommAdjMaster] = useState(!!(txn.listing_adj_enabled || txn.coop_adj_enabled));
  const [lAdjEn, setLAdjEn] = useState(!!txn.listing_adj_enabled);
  const [lBefore, setLBefore] = useState<number>(txn.listing_adj_before ?? 0);
  const [lAfter, setLAfter] = useState<number>(txn.listing_adj_after ?? 0);
  const [cAdjEn, setCAdjEn] = useState(!!txn.coop_adj_enabled);
  const [cBefore, setCBefore] = useState<number>(txn.coop_adj_before ?? 0);
  const [cAfter, setCAfter] = useState<number>(txn.coop_adj_after ?? 0);

  // precon
  const [netHst, setNetHst] = useState(!!txn.precon_net_of_hst);
  const [masterPct, setMasterPct] = useState<number | string>(txn.precon_comm_pct ?? '');
  const [pTerms, setPTerms] = useState<PreconTermRow[]>(() => {
    const existing: Record<number, { pct?: number | null; closing_date?: string | null }> = {};
    (txn.precon_terms || []).forEach((t) => { existing[t.term_no] = t; });
    return Array.from({ length: termCount }, (_, k) => {
      const e = existing[k + 1] || {};
      return { term_no: k + 1, pct: e.pct ?? '', closing_date: e.closing_date || '' };
    });
  });
  const setTerm = (i: number, k: 'pct' | 'closing_date', v: string) => setPTerms((tt) => tt.map((t, idx) => idx === i ? { ...t, [k]: v } : t));

  // Auto-divide: resize the term list whenever the term count changes (preserving entered values).
  useEffect(() => {
    setPTerms((prev) => Array.from({ length: termCount }, (_, k) => prev[k] || { term_no: k + 1, pct: '', closing_date: '' }));
  }, [termCount]);

  const [masterAmtManual, setMasterAmtManual] = useState<number | string>(txn.precon_comm_amt_manual ?? '');
  const [detailsOfTerms, setDetailsOfTerms] = useState(txn.precon_details_of_terms || 'Entire');
  const [termLocks, setTermLocks] = useState<Record<number, boolean>>({});
  const isLocked = (k: number) => (termLocks[k] === undefined ? true : termLocks[k]);
  const toggleLock = (k: number) => setTermLocks((l) => ({ ...l, [k]: !isLocked(k) }));

  if (!open) return null;

  const onPct = (v: string) => { setCommPct(v); if (v) setCommAmt(''); };
  const onAmt = (v: string) => { setCommAmt(v); if (v) setCommPct(''); };
  const excl = (v: number, setThis: (n: number) => void, _other: number, setOther: (n: number) => void) => { setThis(v); if (parseNumber(v) !== 0) setOther(0); };
  // Listing/Co-op: % and fixed Amount are mutually exclusive — entering one clears the other.
  const onListPct = (v: string) => { setListPct(v); if (parseNumber(v) !== 0) setListFlat(''); };
  const onListFlat = (v: string) => { setListFlat(v); if (parseNumber(v) !== 0) setListPct(''); };
  const onCoopPct = (v: string) => { setCoopPct(v); if (parseNumber(v) !== 0) setCoopFlat(''); };
  const onCoopFlat = (v: string) => { setCoopFlat(v); if (parseNumber(v) !== 0) setCoopPct(''); };

  // ---- live standard computation ----
  const gross = parseNumber(commAmt) > 0 ? parseNumber(commAmt) : (parseNumber(commPct) > 0 ? parseNumber(price) * parseNumber(commPct) / 100 : 0);
  const adjB = adjEnabled ? parseNumber(adjBefore) : 0;
  const adjA = adjEnabled ? parseNumber(adjAfter) : 0;
  const commWoHst = r2(gross - adjB);
  const stdHst = r2(commWoHst * HST);
  const stdTotal = r2(commWoHst + stdHst - adjA);
  // Deal-level referrals: sections are computed from the full (pre-adjustment)
  // commission; broker referral still reduces the team-split base (which keeps the
  // commission adjustment), client referral comes off the deal Total only.
  const stdRef = referralSections(gross, txn.adjustments, HST);
  const stdSplitBase = r2(commWoHst - stdRef.brokerAmount);
  // "Agent Commissions after client referral" is computed off the commission AFTER the
  // external broker referral (stdSplitBase = commission − broker referral), per spec.
  const stdAfterClient = agentCommissionsAfterClient(stdSplitBase, members, { minBrokComm: 200, adjBefore: adjB, adjAfter: adjA, clientReferral: stdRef.clientAmount }, HST);
  const stdRefView: ReferralView = { ...stdRef, afterClient: stdAfterClient };
  const stdAgentCtx = { acTotal: stdAfterClient.total, acComm: stdAfterClient.commission, minBrokComm: 200, adjBefore: adjB, adjAfter: adjA };
  const memberRows: AgentRow[] = members.map((m, i) => {
    const base = r2(stdSplitBase * (parseNumber(m.split) / 100));
    const brokWo = r2(base * (parseNumber(m.brok_pct) / 100));
    // Agent + T4A take Split % of the after-client-referral section Total; T4A is gross (no per-agent deduction).
    return { m, agent: agentCommissionLine(m, stdAgentCtx, memberDeduct[i].total, HST), brok: lineOf(brokWo), t4a: agentCommissionLine(m, stdAgentCtx, 0, HST), adj: memberDeduct[i] };
  });

  // ---- live listing computation (full client spec — mirrors CommissionService::breakdownListing) ----
  const lAdjEff = commAdjMaster && lAdjEn;
  const cAdjEff = commAdjMaster && cAdjEn;
  const listIsLease = /lease/i.test(txn.type);
  const listClientReferral = (txn.adjustments?.client_referral === 'Yes') ? (txn.adjustments.client_rows || []).reduce((s, r) => s + parseNumber(r.amount), 0) : 0;
  const listExtAmt = (txn.adjustments?.ext_referral === 'Yes') ? parseNumber(txn.adjustments.ext?.amount) : 0;
  const lb = listingBreakdown({
    price: parseNumber(price), deposit: txn.deposit,
    listPct, coopPct, listFlat: parseNumber(listFlat), coopFlat: parseNumber(coopFlat),
    lAdjBefore: lAdjEff ? parseNumber(lBefore) : 0, lAdjAfter: lAdjEff ? parseNumber(lAfter) : 0,
    cAdjBefore: cAdjEff ? parseNumber(cBefore) : 0, cAdjAfter: cAdjEff ? parseNumber(cAfter) : 0,
    extAmt: listExtAmt, clientReferral: listClientReferral,
    members: members.map((m) => ({ name: m.name, split: m.split, agent_pct: m.agent_pct, brok_pct: m.brok_pct })),
    deductions: memberDeduct.map((d) => d.total), isLease: listIsLease, // Agent Adjust + Advance per member
  }, HST);
  // Referral sections are based on the (fixed) Listing Commission — the broker referral
  // only changes "Commissions after broker referral", never the Listing Commission itself.
  const listRef = referralSections(lb.listing.commission, txn.adjustments, HST);
  // Agent commissions are computed off the commission AFTER the external broker referral.
  const listAfterClient = agentCommissionsAfterClient(listRef.afterBroker.commission, members, {
    minBrokComm: 499,
    adjBefore: lAdjEff ? parseNumber(lBefore) : 0,
    adjAfter: lAdjEff ? parseNumber(lAfter) : 0,
    clientReferral: listRef.clientAmount,
  }, HST);
  const listRefView: ReferralView = { ...listRef, afterClient: listAfterClient };
  // Reuse the Residential-Buying card design (AgentCommissionBlocks): Agent Commission =
  // payable (cash after advance), Agent (T4A) = gross earned, Brokerage = per-member keep.
  const listingRows: AgentRow[] = lb.members.map((mr, i) => ({
    m: members[i],
    agent: { commission: r2(mr.cashToPay / (1 + HST)), hst: r2(mr.cashToPay - mr.cashToPay / (1 + HST)), total: mr.cashToPay },
    t4a: { commission: mr.commission, hst: mr.hst, total: mr.earned },
    brok: { commission: r2(mr.brokerageFromMember / (1 + HST)), hst: r2(mr.brokerageFromMember - mr.brokerageFromMember / (1 + HST)), total: mr.brokerageFromMember },
    adj: memberDeduct[i], // { agentAdjust, advance, total } → "Less adjustment + advance" note
  }));
  // TD-025 - EACH MEMBER KEEPS THEIR OWN RATE. This used to broadcast agent_pct and brok_pct to
  // every member on a listing, so setting one agent to 70 silently moved everybody to 70 and two
  // agents could never be on different plans. It was deliberate - the old comment called the split
  // "a single deal-level split for listings" - but the brokerage confirmed on 2026-08-31 that rates
  // may be equal or different and that editing one must never change another. setMember already
  // updates only the card being edited, which is how every other field on this panel behaves and
  // how buying deals have always worked.
  const setListMember = (i: number, k: FinMemberKey, v: string) => setMember(i, k, v);
  // Trust Verification: Deposit − Total Commissions − Receivable from Lawyer − Payable to Client.
  // Receivable is the signed value (≤ 0 when the trust is short), so a balanced deal nets to 0 = PASS.
  const tvReceivable = lb.trust.receivableFromLawyer;
  const tvCheck = r2(parseNumber(txn.deposit) - lb.totals.total - tvReceivable - parseNumber(trustPayable));
  const tvPass = Math.abs(tvCheck) < 0.005;

  // ---- live preconstruction master computation ----
  const pMasterAmt = parseNumber(masterAmtManual) > 0 ? parseNumber(masterAmtManual) : (parseNumber(masterPct) > 0 ? parseNumber(price) * parseNumber(masterPct) / 100 : 0);
  let mComm: number, mHst: number, mTotal: number;
  if (netHst) { mComm = r2(pMasterAmt / 1.13); mHst = r2(pMasterAmt - mComm); mTotal = pMasterAmt; }
  else { mComm = pMasterAmt; mHst = r2(pMasterAmt * HST); mTotal = r2(pMasterAmt + mHst); }
  if (adjEnabled) {
    if (adjB !== 0) { mComm = r2(mComm - adjB); mHst = r2(mComm * HST); mTotal = r2(mComm + mHst); }
    if (adjA !== 0) { mTotal = r2(mTotal - adjA); }
  }
  const preconSumPct = pTerms.reduce((s, t) => s + parseNumber(t.pct), 0);
  const preconTermsValid = parseNumber(masterPct) <= 0 ? true : preconSumPct <= parseNumber(masterPct) + 1e-9;
  const visibleAtTerm = (k: number) => members.map((m, i) => ({ m, i })).filter(({ m }) => (m.scope || 'Entire') === 'Entire' || (m.terms || []).map(Number).includes(k));

  const save = async () => {
    // Validation: % and fixed Amount are mutually exclusive per side.
    if (listing) {
      if (parseNumber(listPct) > 0 && parseNumber(listFlat) > 0) { toast('Enter a Listing Commission % OR Amount, not both', 'bad'); return; }
      if (parseNumber(coopPct) > 0 && parseNumber(coopFlat) > 0) { toast('Enter a Co-op Commission % OR Amount, not both', 'bad'); return; }
    }
    const payload = precon
      ? {
          price: parseNumber(price), precon_net_of_hst: netHst,
          precon_term_count: termCount || null,
          precon_comm_pct: masterPct === '' ? null : parseNumber(masterPct),
          precon_comm_amt_manual: masterAmtManual === '' ? null : parseNumber(masterAmtManual),
          precon_details_of_terms: detailsOfTerms,
          comm_adjust_enabled: adjEnabled, comm_adjust_before: adjEnabled ? parseNumber(adjBefore) : 0, comm_adjust_after: adjEnabled ? parseNumber(adjAfter) : 0,
          precon_terms: pTerms.map((t) => ({ term_no: t.term_no, pct: t.pct === '' ? null : parseNumber(t.pct), closing_date: t.closing_date || null })),
          team: members.map((m, i) => ({ name: m.name, split: parseNumber(m.split), agent_pct: parseNumber(m.agent_pct), brok_pct: parseNumber(m.brok_pct), is_primary: i === 0, scope: m.scope, terms: m.terms })),
        }
      : listing
      ? {
          price: parseNumber(price),
          listing_comm_pct: listPct === '' ? null : parseNumber(listPct), coop_comm_pct: coopPct === '' ? null : parseNumber(coopPct),
          listing_comm_flat: listFlat === '' ? null : parseNumber(listFlat), coop_comm_flat: coopFlat === '' ? null : parseNumber(coopFlat),
          trust_payable: trustPayable === '' ? null : parseNumber(trustPayable),
          listing_adj_enabled: lAdjEff, listing_adj_before: lAdjEff ? parseNumber(lBefore) : 0, listing_adj_after: lAdjEff ? parseNumber(lAfter) : 0,
          coop_adj_enabled: cAdjEff, coop_adj_before: cAdjEff ? parseNumber(cBefore) : 0, coop_adj_after: cAdjEff ? parseNumber(cAfter) : 0,
          team: members.map((m, i) => ({ name: m.name, split: parseNumber(m.split), agent_pct: parseNumber(m.agent_pct), brok_pct: parseNumber(m.brok_pct), is_primary: i === 0, scope: m.scope, terms: m.terms })),
        }
      : {
          price: parseNumber(price),
          comm_pct: commPct === '' ? null : parseNumber(commPct), comm_amt: commAmt === '' ? null : parseNumber(commAmt),
          comm_adjust_enabled: adjEnabled, comm_adjust_before: adjEnabled ? parseNumber(adjBefore) : 0, comm_adjust_after: adjEnabled ? parseNumber(adjAfter) : 0,
          team: members.map((m, i) => ({ name: m.name, split: parseNumber(m.split), agent_pct: parseNumber(m.agent_pct), brok_pct: parseNumber(m.brok_pct), is_primary: i === 0, scope: m.scope, terms: m.terms })),
        };
    setSaving(true);
    try {
      const updated = await updateTransaction(transactionId, payload);
      onSaved?.(updated);
      setSavedOk(true);
      setTimeout(() => { setSavedOk(false); onClose(); }, 2000);
    } catch (err) {
      toast(apiErrorMessage(err, 'Could not save'), 'bad');
      setSaving(false);
    }
  };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      {pendingLoanAgents.length > 0 && !loanAlertSeen && (
        <div className="overlay open" style={{ zIndex: 60 }} onMouseDown={(e) => { if (e.target === e.currentTarget) setLoanAlertSeen(true); }}>
          <div className="modal sm" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-h" style={{ color: 'var(--warn-ink)' }}><Icon name="dollar" size={14} /> Agent loan outstanding</div>
            <p style={{ fontSize: 13, color: 'var(--text-2)', margin: '4px 0 10px' }}>
              This deal is ready for payment and the following agent{pendingLoanAgents.length > 1 ? 's have' : ' has'} an outstanding loan balance:
            </p>
            <ul style={{ margin: '0 0 12px', paddingLeft: 18 }}>
              {pendingLoanAgents.map((a) => (
                <li key={a.name} style={{ fontSize: 13, marginBottom: 4 }}>
                  <strong>{a.name}</strong> — Balance Loan Amount <strong style={{ color: 'var(--warn-700)' }}>{formatCurrency(a.balance)}</strong>
                </li>
              ))}
            </ul>
            <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 12px' }}>
              Add a loan repayment in <strong>Adjustment &amp; Advance Payment → Adjustment Details</strong> (tick “Loan repayment”). The amount can’t exceed the agent’s Agent Commission total.
            </p>
            <div className="actions">
              <button className="btn primary" onClick={() => setLoanAlertSeen(true)}>Got it</button>
            </div>
          </div>
        </div>
      )}
      <div className="modal xl">
        <button className="close" onClick={onClose}><Icon name="close" size={15} /></button>
        <div className="modal-h">Financial Information {listing && <span className="pill type-res-sell" style={{ fontSize: 10 }}>Listing</span>}{precon && <span className="pill type-pre" style={{ fontSize: 10 }}>Preconstruction</span>}</div>

        {/* Locked-fields hint + pending state (the 🔒✏ pencils sit on each field). */}
        {finLock && (
          <div className="card" style={{ borderLeft: '4px solid #d97706', background: 'var(--warn-bg-2)', marginBottom: 12, fontSize: 12.5, color: 'var(--warn-ink-deep)' }}>
            <strong style={{ color: 'var(--warn-ink)' }}><Icon name="lock" size={13} /> Price, Deposit &amp; Commission fields are locked.</strong>{' '}
            {pendingFinReq
              ? <span>An edit request is <strong>awaiting Super Admin approval</strong>.</span>
              : <span>Click the <strong><Icon name="lock" size={12} /><Icon name="edit" size={12} /></strong> beside a field to request Super Admin approval to edit.</span>}
          </div>
        )}
        {/* Super Admin: approve/reject a pending financial edit request inline. */}
        {isSuperAdmin && pendingFinReq && (
          <div className="card" style={{ borderLeft: '4px solid #2563eb', background: 'var(--info-bg)', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12.5, color: 'var(--info-ink)' }}><Icon name="edit" size={13} /> <strong>{pendingFinReq.requested_by_name || 'A user'}</strong> requested to edit financial fields{pendingFinReq.reason ? ` — “${pendingFinReq.reason}”` : ''}.</span>
            <div style={{ flex: 1 }} />
            <button className="btn primary sm" onClick={approveFinReq} disabled={reqBusy}><Icon name="check" size={13} /> Approve</button>
            <button className="btn ghost sm" onClick={rejectFinReq} disabled={reqBusy}><Icon name="close" size={13} /> Reject</button>
          </div>
        )}
        {approvedFinReq && !isSuperAdmin && (
          <div className="card" style={{ borderLeft: '4px solid #16a34a', background: 'var(--ok-bg)', marginBottom: 12 }}>
            <span style={{ fontSize: 12.5, color: 'var(--ok-ink)' }}><Icon name="unlock" size={13} /> <strong>Approved</strong>{approvedFinReq.reviewed_by_name ? ` by ${approvedFinReq.reviewed_by_name}` : ''} — edit the fields and Save. The section re-locks after you save.</span>
          </div>
        )}

        {dftNA && (
          <div className="card" style={{ borderLeft: '4px solid var(--bad)', background: 'var(--warn-bg)', marginBottom: 12 }}>
            <strong style={{ color: 'var(--warn-ink-alt)' }}><Icon name="lock" size={13} /> DFT — Deal Fell Through.</strong>{' '}
            <span style={{ fontSize: 12.5, color: 'var(--warn-ink-deep)' }}>Statuses default to N/A and are locked.</span>
          </div>
        )}
        {/* NOTE: the original JS referenced an undefined `finLocked` here (a typo that
            would throw when this branch rendered); corrected to `finLock`, the clearly
            intended flag — the view-only banner hides while the finLock banner shows. */}
        {readOnly && !dftNA && !isAgent && !finLock && (
          <div className="card" style={{ borderLeft: '4px solid #2563eb', background: 'var(--info-bg)', marginBottom: 12 }}>
            <span style={{ fontSize: 12.5, color: 'var(--info-ink)' }}><Icon name="lock" size={13} /> View-only — click <strong>Edit</strong> on the transaction to make changes.</span>
          </div>
        )}
        {(pendingLoanAgents.length > 0 || adjustedLoanAgents.length > 0) && (
          <div className="card" style={{ borderLeft: '4px solid #d97706', background: 'var(--warn-bg-2)', marginBottom: 12 }}>
            <strong style={{ color: 'var(--warn-ink)' }}><Icon name="dollar" size={13} /> Outstanding agent loan{loanAgents.length > 1 ? 's' : ''}.</strong>{' '}
            <span style={{ fontSize: 12.5, color: 'var(--warn-900)' }}>
              {adjustedLoanAgents.map((a) => `${a.name} — ${formatCurrency(a.adjusted)} adjusted from this deal`).join(' · ')}
              {adjustedLoanAgents.length > 0 && pendingLoanAgents.length > 0 ? '. ' : ''}
              {pendingLoanAgents.length > 0 && (<>
                {pendingLoanAgents.map((a) => `${a.name} — ${formatCurrency(a.balance)}`).join(' · ')}. Record a loan repayment in
                {' '}<strong>Adjustment &amp; Advance Payment → Adjustment Details</strong> (tick “Loan repayment”); it can’t exceed the agent’s Agent Commission total.
              </>)}
            </span>
          </div>
        )}

        <fieldset disabled={dftNA || readOnly} style={{ border: 0, margin: 0, padding: 0, minInlineSize: 0 }}>

        {precon ? (
          <div className="g3">
            <div className="field"><label>Price {finPencil()}</label><MoneyInput value={price} onChange={(v) => setPrice(v)} onBlur={(e) => setPrice(parseNumber(e.target.value))} readOnly={finLock} style={finLock ? finLockStyle : undefined} /></div>
            <div className="field"><label>NET of HST</label><select value={netHst ? 'Yes' : 'No'} onChange={(e) => setNetHst(e.target.value === 'Yes')}><option>No</option><option>Yes</option></select></div>
            <div className="field"><label>Deposit {finPencil()}</label><input value={txn.deposit ?? 0} readOnly style={{ background: 'var(--surface-2)' }} /></div>
          </div>
        ) : listing ? (
          <div className={referral ? '' : 'g2'}>
            <div className="field"><label>Price {finPencil()}</label><MoneyInput value={price} onChange={(v) => setPrice(v)} onBlur={(e) => setPrice(parseNumber(e.target.value))} readOnly={finLock} style={finLock ? finLockStyle : undefined} /></div>
            {!referral && <div className="field"><label>Deposit {finPencil()}</label><input value={txn.deposit ?? 0} readOnly style={{ background: 'var(--surface-2)' }} /></div>}
          </div>
        ) : (
          /* Buying / Lease: Price, Deposit, Commission % and Commission Amount are the four
             figures the deal is priced from, so they read as one row rather than two stacked
             pairs. Referral has no deposit, so it drops to three columns. */
          <div className={referral ? 'g3' : 'g4'}>
            <div className="field"><label>Price {finPencil()}</label><MoneyInput value={price} onChange={(v) => setPrice(v)} onBlur={(e) => setPrice(parseNumber(e.target.value))} readOnly={finLock} style={finLock ? finLockStyle : undefined} /></div>
            {!referral && <div className="field"><label>Deposit {finPencil()}</label><input value={txn.deposit ?? 0} readOnly style={{ background: 'var(--surface-2)' }} /></div>}
            <div className="field"><label>Commission % {finPencil()}</label><input value={commPct} onChange={(e) => onPct(e.target.value)} placeholder="e.g. 5" readOnly={finLock} style={finLock ? { ...finLockStyle, ...pctStyle } : pctStyle} /></div>
            <div className="field"><label>Commission Amount {finPencil()}</label><MoneyInput value={commAmt} onChange={(v) => onAmt(v)} placeholder="0.00" readOnly={finLock} style={finLock ? finLockStyle : undefined} /></div>
          </div>
        )}

        {precon ? (
          <>
            <div className="modal-sub">Commission</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 10, marginBottom: 14 }}>
              <div className="field" style={{ marginBottom: 0 }}><label>Commission % {finPencil()}</label><input type="number" value={masterPct} onChange={(e) => setMasterPct(e.target.value)} placeholder="e.g. 4" readOnly={finLock} style={finLock ? { ...finLockStyle, ...pctStyle } : pctStyle} /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>Commission Amount {finPencil()}</label><MoneyInput value={masterAmtManual} onChange={(v) => setMasterAmtManual(v)} placeholder="0.00" readOnly={finLock} style={finLock ? finLockStyle : undefined} /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>Commission</label><input readOnly style={cs(mComm)} value={formatCurrency(mComm)} />{adjEnabled && adjB !== 0 && <div className="help" style={{ margin: '4px 0 0' }}>{adjNote(adjB, 'before HST')}</div>}</div>
              <div className="field" style={{ marginBottom: 0 }}><label>HST</label><input readOnly style={cs(mHst)} value={formatCurrency(mHst)} /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>Total</label><input readOnly style={ts(mTotal)} value={formatCurrency(mTotal)} />{adjEnabled && adjA !== 0 && <div className="help" style={{ margin: '4px 0 0' }}>{adjNote(adjA, 'after HST')}</div>}</div>
            </div>

            <div className="modal-sub">Commission Structure</div>
            <div className="field" style={{ maxWidth: 240 }}><label>Show</label>
              <select value={detailsOfTerms} onChange={(e) => setDetailsOfTerms(e.target.value)}>
                <option value="Entire">Entire</option>
                {Array.from({ length: termCount }, (_, k) => <option key={k} value={`Term ${k + 1}`}>Term {k + 1}</option>)}
              </select>
            </div>
            {termCount === 0 && <div className="help">Set "Commission Receivable in Terms" in Preconstruction Details first, then reopen Financial.</div>}

            {pTerms.map((t, idx) => {
              const k = idx + 1;
              if (detailsOfTerms !== 'Entire' && detailsOfTerms !== `Term ${k}`) return null;
              const tAmt = r2(parseNumber(price) * parseNumber(t.pct) / 100);
              const tHst = r2(tAmt * HST);
              const tTotal = netHst ? tAmt : r2(tAmt + tHst);
              const visible = visibleAtTerm(k);
              const termDeduct = agentAdjustments(txn.adjustments, members, k); // term-scoped, aligned to members
              const locked = isLocked(k);
              const agentTermTotal = visible.reduce((s, { m, i }) => {
                const base = r2(tAmt * (parseNumber(m.split) / 100));
                return s + lineLessTotal(r2(base * parseNumber(m.agent_pct) / 100), termDeduct[i].total).total;
              }, 0);
              const t4aTermTotal = visible.reduce((s, { m }) => {
                const base = r2(tAmt * (parseNumber(m.split) / 100));
                return s + lineOf(r2(base * parseNumber(m.agent_pct) / 100)).total;
              }, 0);
              const brokTermTotal = visible.reduce((s, { m }) => {
                const base = r2(tAmt * (parseNumber(m.split) / 100));
                return s + lineOf(r2(base * parseNumber(m.brok_pct) / 100)).total;
              }, 0);
              return (
                <div key={k} style={{ background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 8, padding: 12, marginBottom: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <strong>Term {k}</strong>
                    <button type="button" className="btn ghost sm" style={{ padding: '4px 8px', lineHeight: 1 }} title={locked ? 'Unlock to edit Commission %' : 'Lock Commission %'} onClick={() => toggleLock(k)}>{locked ? <Icon name="edit" size={13} /> : <Icon name="lock" size={13} />}</button>
                  </div>
                  <div className="g4">
                    <div className="field" style={{ marginBottom: 0 }}><label>Commission %</label><input type="number" value={t.pct} readOnly={locked} style={locked ? { background: 'var(--surface-3)', cursor: 'not-allowed', ...pctStyle } : pctStyle} onChange={(e) => setTerm(idx, 'pct', e.target.value)} /></div>
                    <div className="field" style={{ marginBottom: 0 }}><label>Commission</label><input readOnly style={cs(tAmt)} value={formatCurrency(tAmt)} /></div>
                    <div className="field" style={{ marginBottom: 0 }}><label>HST</label><input readOnly style={cs(tHst)} value={formatCurrency(tHst)} /></div>
                    <div className="field" style={{ marginBottom: 0 }}><label>Total</label><input readOnly style={ts(tTotal)} value={formatCurrency(tTotal)} /></div>
                  </div>

                  <div className="modal-sub" style={{ marginTop: 14 }}>Agent Commission — Term {k} <span style={{ color: totalColor(agentTermTotal) }}>({formatCurrency(agentTermTotal)})</span></div>
                  {visible.length === 0 ? <div className="help">No agents assigned to Term {k} (per Team Split scope).</div> : visible.map(({ m, i }) => {
                    const base = r2(tAmt * (parseNumber(m.split) / 100));
                    const a = lineLessTotal(r2(base * parseNumber(m.agent_pct) / 100), termDeduct[i].total);
                    return (
                      <div className="agent-comm-card" key={i}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><strong>{(m.name || '').toUpperCase()}</strong><span className="pill info" style={{ fontSize: 10 }}>{m.split}% Split</span></div>
                          <strong style={{ color: totalColor(a.total) }}>{formatCurrency(a.total)}</strong>
                        </div>
                        <div className="g4">
                          <div className="field" style={{ marginBottom: 0 }}>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>Agent Comm (%)
                              <button type="button" className="row-rm" style={{ color: 'var(--brand)', lineHeight: 1 }} title={agentUnlock[i] ? 'Lock Agent Comm %' : 'Unlock to edit Agent Comm %'} onClick={() => setAgentUnlock((u) => ({ ...u, [i]: !u[i] }))}>{agentUnlock[i] ? <Icon name="unlock" size={13} /> : <Icon name="edit" size={13} />}</button>
                            </label>
                            <input type="number" value={m.agent_pct} readOnly={!agentUnlock[i]} style={!agentUnlock[i] ? { ...lockField, ...pctStyle } : pctStyle} onChange={(e) => setMember(i, 'agent_pct', e.target.value)} />
                          </div>
                          <div className="field" style={{ marginBottom: 0 }}><label>Commission</label><input readOnly style={cs(a.commission)} value={formatCurrency(a.commission)} /></div>
                          <div className="field" style={{ marginBottom: 0 }}><label>HST</label><input readOnly style={cs(a.hst)} value={formatCurrency(a.hst)} /></div>
                          <div className="field" style={{ marginBottom: 0 }}><label>Total</label><input readOnly style={{ fontWeight: 700, color: totalColor(a.total) }} value={formatCurrency(a.total)} /></div>
                        </div>
                        {(defaultPctFor(m.name) !== null
                          ? parseNumber(m.agent_pct) !== defaultPctFor(m.name)
                          : hadSavedTeam) && (
                          <div className="help" style={{ margin: '6px 0 0', color: 'var(--brand)' }}>
                            This commission split applies only to this transaction; the agent’s main/default commission split is {defaultPctFor(m.name) !== null ? `${defaultPctFor(m.name)}%` : 'not set on their profile'}.
                          </div>
                        )}
                        {termDeduct[i].total > 0 && <div className="help" style={{ margin: '6px 0 0' }}>Less {adjLabel(termDeduct[i])} = −{formatCurrency(termDeduct[i].total)} off total{termDeduct[i].loan > 0 ? ' for loan payment' : ''}</div>}
                      </div>
                    );
                  })}

                  {!isAgent && <div className="modal-sub">Agent (T4A) — Term {k} <span style={{ color: totalColor(t4aTermTotal) }}>({formatCurrency(t4aTermTotal)})</span></div>}
                  {!isAgent && (visible.length === 0 ? <div className="help">No agents assigned to Term {k}.</div> : visible.map(({ m, i }) => {
                    const base = r2(tAmt * (parseNumber(m.split) / 100));
                    const a = lineOf(r2(base * parseNumber(m.agent_pct) / 100));
                    return (
                      <div className="t4a-card" key={i}>
                        <strong style={{ fontSize: 13 }}>{(m.name || '').toUpperCase()}</strong>
                        <div className="g3" style={{ marginTop: 10 }}>
                          <div className="field" style={{ marginBottom: 0 }}><label>Commission</label><input readOnly style={cs(a.commission)} value={formatCurrency(a.commission)} /></div>
                          <div className="field" style={{ marginBottom: 0 }}><label>HST</label><input readOnly style={cs(a.hst)} value={formatCurrency(a.hst)} /></div>
                          <div className="field" style={{ marginBottom: 0 }}><label>Total</label><input readOnly style={ts(a.total)} value={formatCurrency(a.total)} /></div>
                        </div>
                      </div>
                    );
                  }))}

                  <div className="modal-sub" style={{ borderLeftColor: '#7c3aed', color: '#5b21b6' }}>Brokerage Commission — Term {k} <span style={{ color: totalColor(brokTermTotal) }}>({formatCurrency(brokTermTotal)})</span></div>
                  {visible.length === 0 ? <div className="help">No agents assigned to Term {k}.</div> : visible.map(({ m, i }) => {
                    const base = r2(tAmt * (parseNumber(m.split) / 100));
                    const b = lineOf(r2(base * parseNumber(m.brok_pct) / 100));
                    return (
                      <div className="brok-card" key={i}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}><strong style={{ fontSize: 13 }}>{(m.name || '').toUpperCase()}</strong><span className="pill" style={{ background: '#f3e8ff', color: '#6b21a8', border: '1px solid #d8b4fe', fontSize: 10 }}>Split: {m.split}%</span></div>
                        <div className="g4">
                          <div className="field" style={{ marginBottom: 0 }}><label>Brok Comm (%) <Icon name="lock" size={11} /></label><input type="number" value={m.brok_pct} readOnly style={{ ...lockField, ...pctStyle }} /></div>
                          <div className="field" style={{ marginBottom: 0 }}><label>Commission</label><input readOnly value={formatCurrency(b.commission)} /></div>
                          <div className="field" style={{ marginBottom: 0 }}><label>HST</label><input readOnly value={formatCurrency(b.hst)} /></div>
                          <div className="field" style={{ marginBottom: 0 }}><label>Total</label><input readOnly style={{ fontWeight: 700, color: '#5b21b6' }} value={formatCurrency(b.total)} /></div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
            {!preconTermsValid && <div style={{ color: 'var(--bad)', fontSize: 12, fontWeight: 600, marginBottom: 8 }}><Icon name="alert" size={13} /> Sum of term % exceeds the master Commission %.</div>}

            <div className="modal-sub">Commission Adjustment</div>
            <div className="field" style={{ maxWidth: 220 }}><label>Commission Adjustment</label><select value={adjEnabled ? 'Yes' : 'No'} onChange={(e) => setAdjEnabled(e.target.value === 'Yes')}><option>No</option><option>Yes</option></select></div>
            {adjEnabled && (
              <div className="g2">
                <SignedAdjField label="Adjustment (Before HST)" value={adjBefore} onChange={(nv) => excl(nv, setAdjBefore, adjAfter, setAdjAfter)} convention="sub" />
                <SignedAdjField label="Adjustment (After HST)" value={adjAfter} onChange={(nv) => excl(nv, setAdjAfter, adjBefore, setAdjBefore)} convention="sub" />
              </div>
            )}
          </>
        ) : listing ? (
          <>
            <div className="modal-sub">Listing Commission {lb.dealType === 'Lease' && <span className="pill type-pre" style={{ fontSize: 10 }}>Lease</span>}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10 }}>
              <div className="field" style={{ marginBottom: 0 }}><label>Listing Commission %</label><input value={listPct} onChange={(e) => onListPct(e.target.value)} placeholder="e.g. 2.5" style={pctStyle} /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>Listing Commission Amount</label><input value={listFlat} onChange={(e) => onListFlat(e.target.value)} placeholder="0.00" /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>Commission</label><input readOnly style={cs(lb.listing.commission)} value={formatCurrency(lb.listing.commission)} /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>HST</label><input readOnly style={cs(lb.listing.hst)} value={formatCurrency(lb.listing.hst)} /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>Total</label><input readOnly style={ts(lb.listing.total)} value={formatCurrency(lb.listing.total)} /></div>
            </div>
            <div className="modal-sub">Co-op Commission</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10 }}>
              <div className="field" style={{ marginBottom: 0 }}><label>Co-op Commission %</label><input value={coopPct} onChange={(e) => onCoopPct(e.target.value)} placeholder="e.g. 2.5" style={pctStyle} /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>Co-op Commission Amount</label><input value={coopFlat} onChange={(e) => onCoopFlat(e.target.value)} placeholder="0.00" /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>Commission</label><input readOnly style={cs(lb.coop.commission)} value={formatCurrency(lb.coop.commission)} /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>HST</label><input readOnly style={cs(lb.coop.hst)} value={formatCurrency(lb.coop.hst)} /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>Total</label><input readOnly style={ts(lb.coop.total)} value={formatCurrency(lb.coop.total)} /></div>
            </div>
            <div className="modal-sub">Total Commissions (Listing + Co-Op)</div>
            <div className="fin-sum"><Box label="Commission" value={formatCurrency(lb.totals.commission)} /><Box label="HST" value={formatCurrency(lb.totals.hst)} /><Box label="Total" value={formatCurrency(lb.totals.total)} brand /></div>

            <div className="modal-sub">Commission Adjustment</div>
            <div className="field" style={{ maxWidth: 220 }}>
              <label>Commission Adjustment</label>
              <select value={commAdjMaster ? 'Yes' : 'No'} onChange={(e) => setCommAdjMaster(e.target.value === 'Yes')}><option>No</option><option>Yes</option></select>
            </div>
            {commAdjMaster && (
              <div className="g2">
                <div style={{ background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 8, padding: 12 }}>
                  <strong style={{ fontSize: 13 }}>Listing Commission Adjustment</strong>
                  <div className="field" style={{ marginTop: 10, marginBottom: lAdjEn ? 13 : 0 }}><label>Listing Comm Adjustment</label><select value={lAdjEn ? 'Yes' : 'No'} onChange={(e) => setLAdjEn(e.target.value === 'Yes')}><option>No</option><option>Yes</option></select></div>
                  {lAdjEn && (
                    <div className="g2">
                      <SignedAdjField label="Adjustment (Before HST)" value={lBefore} onChange={(nv) => excl(nv, setLBefore, lAfter, setLAfter)} convention="add" />
                      <SignedAdjField label="Adjustment (After HST)" value={lAfter} onChange={(nv) => excl(nv, setLAfter, lBefore, setLBefore)} convention="add" />
                    </div>
                  )}
                </div>
                <div style={{ background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 8, padding: 12 }}>
                  <strong style={{ fontSize: 13 }}>Co-op Commission Adjustment</strong>
                  <div className="field" style={{ marginTop: 10, marginBottom: cAdjEn ? 13 : 0 }}><label>Co-op Comm Adjustment</label><select value={cAdjEn ? 'Yes' : 'No'} onChange={(e) => setCAdjEn(e.target.value === 'Yes')}><option>No</option><option>Yes</option></select></div>
                  {cAdjEn && (
                    <div className="g2">
                      <SignedAdjField label="Adjustment (Before HST)" value={cBefore} onChange={(nv) => excl(nv, setCBefore, cAfter, setCAfter)} convention="add" />
                      <SignedAdjField label="Adjustment (After HST)" value={cAfter} onChange={(nv) => excl(nv, setCAfter, cBefore, setCBefore)} convention="add" />
                    </div>
                  )}
                </div>
              </div>
            )}

            <ReferralSections data={listRefView} />

            {/* Trust settlement — client payout & lawyer receivable (Deposit Held removed) */}
            {!hideClientCommission && (
              <>
                <div className="modal-sub">Trust Settlement</div>
                <div className="fin-sum">
                  <Box label="Payable to Client" value={formatCurrency(lb.trust.payableToClient)} />
                  <Box label="Receivable from Lawyer" value={formatCurrency(Math.abs(lb.trust.receivableFromLawyer))} brand />
                </div>
              </>
            )}

            {/* Listing Split / Members / Brokerage — Residential-Buying card design */}
            {!hideClientCommission && (
              <AgentCommissionBlocks rows={listingRows} setMember={setListMember} minBrok={lb.minBrok} agentDefaults={agentDefaults} isLease={leaseType} hideT4A={isAgent} hadSavedTeam={hadSavedTeam} finLock={finLock} finPencil={finPencil} />
            )}

            {/* Trust Verification */}
            {!hideClientCommission && (<>
            <div className="modal-sub">Trust Verification</div>
            <div className="g4">
              <div className="field" style={{ marginBottom: 0 }}><label>Deposit</label><input readOnly value={formatCurrency(parseNumber(txn.deposit))} /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>Total Commissions (Listing + Co-Op)</label><input readOnly style={ts(lb.totals.total)} value={formatCurrency(lb.totals.total)} /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>Receivable from Lawyer</label><input readOnly value={formatCurrency(tvReceivable)} /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>Paid to Client</label><MoneyInput value={trustPayable} onChange={(v) => setTrustPayable(v)} placeholder="0.00" /></div>
            </div>
            <div className="fin-sum" style={{ marginTop: 10 }}>
              <Box label="Verification (Deposit − Commissions − Receivable − Paid)" value={formatCurrency(tvCheck)} />
              <div className="field" style={{ marginBottom: 0 }}>
                <label>Status</label>
                <input readOnly value={tvPass ? 'PASS' : 'FAIL'} style={{ fontWeight: 700, color: tvPass ? 'var(--ok)' : 'var(--bad)' }} />
              </div>
            </div>
            </>)}
          </>
        ) : (
          /* ---- STANDARD (live, like the original) ---- */
          /* Commission % / Amount now sit in the Price + Deposit row above. */
          <>
            <div className="fin-sum">
              <div className="field" style={{ marginBottom: 0 }}><label>Commission</label><input value={formatCurrency(commWoHst)} readOnly />{adjB !== 0 && <div className="help" style={{ margin: '4px 0 0' }}>{adjNote(adjB, 'before HST')}</div>}</div>
              <div className="field" style={{ marginBottom: 0 }}><label>HST</label><input value={formatCurrency(stdHst)} readOnly /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>Total</label><input style={ts(stdTotal)} value={formatCurrency(stdTotal)} readOnly />{adjA !== 0 && <div className="help" style={{ margin: '4px 0 0' }}>{adjNote(adjA, 'after HST')}</div>}</div>
            </div>

            {/* Commission Adjustment sits on one row with its Before/After HST fields when enabled,
                so the two adjustments read beside the toggle rather than dropping below it. */}
            <div style={{ display: 'grid', gridTemplateColumns: adjEnabled ? '220px 1fr 1fr' : '220px', gap: 16, alignItems: 'end' }}>
              <div className="field" style={{ marginBottom: 0 }}>
                <label>Commission Adjustment {finPencil()}</label>
                <select value={adjEnabled ? 'Yes' : 'No'} disabled={finLock} style={finLock ? finLockStyle : undefined} onChange={(e) => setAdjEnabled(e.target.value === 'Yes')}><option>No</option><option>Yes</option></select>
              </div>
              {adjEnabled && (
                <>
                  <SignedAdjField label="Adjustment (Before HST)" value={adjBefore} onChange={(nv) => excl(nv, setAdjBefore, adjAfter, setAdjAfter)} convention="sub" />
                  <SignedAdjField label="Adjustment (After HST)" value={adjAfter} onChange={(nv) => excl(nv, setAdjAfter, adjBefore, setAdjBefore)} convention="sub" />
                </>
              )}
            </div>

            <ReferralSections data={stdRefView} />
            <AgentCommissionBlocks rows={memberRows} setMember={setMember} minBrok={{ commission: 200, hst: 26, total: 226 }} agentDefaults={agentDefaults} isLease={leaseType} hideT4A={isAgent} hadSavedTeam={hadSavedTeam} finLock={finLock} finPencil={finPencil} />
          </>
        )}

        </fieldset>

        <SavedBadge show={savedOk} />

        <div className="actions">
          <button className="btn ghost" onClick={onClose}>Close</button>
          {!readOnly && <button className="btn primary" onClick={save} disabled={saving || dftNA || savedOk}>{savedOk ? <><Icon name="check" size={13} /> Saved</> : (saving ? 'Saving…' : 'Save')}</button>}
        </div>
      </div>

      {/* Reason prompt when requesting Super Admin approval to edit a locked field. */}
      {reasonOpen && (
        <div className="overlay open" style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 4000 }}
          onMouseDown={(e) => { if (e.target === e.currentTarget) setReasonOpen(false); }}>
          <div className="modal" style={{ maxWidth: 460, margin: 0 }}>
            <button className="close" onClick={() => setReasonOpen(false)}><Icon name="close" size={15} /></button>
            <div className="modal-h">Request edit approval</div>
            <p style={{ fontSize: 13, marginTop: 4 }}>Give a reason for editing the locked financial fields. It's sent to the Super Admin for approval.</p>
            <div className="field" style={{ marginTop: 8 }}>
              <label>Reason <span className="req">*</span></label>
              <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Correcting the commission % agreed with the brokerage" autoFocus />
            </div>
            <div className="actions">
              <button className="btn ghost" onClick={() => setReasonOpen(false)} disabled={reqBusy}>Cancel</button>
              <button className="btn primary" onClick={askFinancialEdit} disabled={reqBusy || !reason.trim()}>{reqBusy ? 'Sending…' : 'Send request'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface AgentCommissionBlocksProps {
  rows: AgentRow[];
  setMember: (i: number, k: FinMemberKey, v: string) => void;
  minBrok: CommissionAmounts;
  agentDefaults?: AgentCommissionMap;
  isLease?: boolean;
  hideT4A?: boolean;
  hadSavedTeam?: boolean;
  finLock?: boolean;
  finPencil?: (() => ReactNode) | null;
}

// Shared per-agent commission cards (Agent Commission / Agent T4A / Brokerage
// Commission + min-brokerage floor). Used by both the standard and listing
// variants so they render identically. `minBrok` carries the type-specific floor.
function AgentCommissionBlocks({ rows, setMember, minBrok, agentDefaults = {}, isLease = false, hideT4A = false, hadSavedTeam = false, finLock = false, finPencil = null }: AgentCommissionBlocksProps) {
  // Agent Comm (%) is locked by default (click the pencil to edit); Brok Comm (%)
  // is always locked — it auto-fills as the complement of Agent Comm.
  const [unlocked, setUnlocked] = useState<Record<number, boolean>>({});
  const lockField: CSSProperties = { background: 'var(--surface-3)', cursor: 'not-allowed' };
  const defOf = (name: string | undefined): number | null => {
    if (!name) return null;
    const d = agentDefaults[name];
    if (!d) return null;
    const v = isLease ? (d.lease_pct ?? d.agent_pct) : d.agent_pct;
    return (v === null || v === undefined) ? null : Number(v);
  };
  const agentTotal = rows.reduce((s, r) => s + (r.agent?.total || 0), 0);
  const t4aTotal = rows.reduce((s, r) => s + (r.t4a?.total || 0), 0);
  const brokTotal = rows.reduce((s, r) => s + (r.brok?.total || 0), 0);
  return (
    <>
      <div className="modal-sub">Agent Commission <span style={{ color: totalColor(agentTotal) }}>({formatCurrency(agentTotal)})</span></div>
      {rows.length === 0 && <div className="help">No agents assigned — set the agent in Basic Info or use Team Split.</div>}
      {rows.map((r, i) => (
        <div className="agent-comm-card" key={i}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><strong>{(r.m.name || '').toUpperCase()}</strong><span className="pill info" style={{ fontSize: 10 }}>{r.m.split}% Split</span></div>
            <strong style={{ color: totalColor(r.agent.total) }}>{formatCurrency(r.agent.total)}</strong>
          </div>
          <div className="g4">
            <div className="field" style={{ marginBottom: 0 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>Agent Comm (%)
                {/* When financially locked, the approval pencil replaces the local unlock. */}
                {(finLock && finPencil) ? finPencil() : (
                  <button type="button" className="row-rm" style={{ color: 'var(--brand)', lineHeight: 1 }} title={unlocked[i] ? 'Lock Agent Comm %' : 'Unlock to edit Agent Comm %'} onClick={() => setUnlocked((u) => ({ ...u, [i]: !u[i] }))}>{unlocked[i] ? <Icon name="unlock" size={13} /> : <Icon name="edit" size={13} />}</button>
                )}
              </label>
              <input type="number" value={r.m.agent_pct} readOnly={finLock || !unlocked[i]} style={(finLock || !unlocked[i]) ? { ...lockField, ...pctStyle } : pctStyle} onChange={(e) => setMember(i, 'agent_pct', e.target.value)} />
            </div>
            <div className="field" style={{ marginBottom: 0 }}><label>Commission</label><input readOnly style={cs(r.agent.commission)} value={formatCurrency(r.agent.commission)} /></div>
            <div className="field" style={{ marginBottom: 0 }}><label>HST</label><input readOnly style={cs(r.agent.hst)} value={formatCurrency(r.agent.hst)} /></div>
            <div className="field" style={{ marginBottom: 0 }}><label>Total</label><input readOnly style={{ fontWeight: 700, color: totalColor(r.agent.total) }} value={formatCurrency(r.agent.total)} /></div>
          </div>
          {(defOf(r.m.name) !== null
            ? parseNumber(r.m.agent_pct) !== defOf(r.m.name)
            : hadSavedTeam) && (
            <div className="help" style={{ margin: '6px 0 0', color: 'var(--brand)' }}>
              This commission split applies only to this transaction; the agent’s main/default commission split is {defOf(r.m.name) !== null ? `${defOf(r.m.name)}%` : 'not set on their profile'}.
            </div>
          )}
          {r.adj.total > 0 && <div className="help" style={{ margin: '6px 0 0' }}>Less {adjLabel(r.adj)} = −{formatCurrency(r.adj.total)} off total{r.adj.loan > 0 ? ' for loan payment' : ''}</div>}
        </div>
      ))}

      {!hideT4A && rows.length > 0 && (<>
        <div className="modal-sub">Agent (T4A) <span style={{ color: totalColor(t4aTotal) }}>({formatCurrency(t4aTotal)})</span></div>
        {rows.map((r, i) => (
          <div className="t4a-card" key={i}>
            <strong style={{ fontSize: 13 }}>{(r.m.name || '').toUpperCase()}</strong>
            <div className="g3" style={{ marginTop: 10 }}>
              <div className="field" style={{ marginBottom: 0 }}><label>Commission</label><input readOnly style={cs(r.t4a.commission)} value={formatCurrency(r.t4a.commission)} /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>HST</label><input readOnly style={cs(r.t4a.hst)} value={formatCurrency(r.t4a.hst)} /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>Total</label><input readOnly style={ts(r.t4a.total)} value={formatCurrency(r.t4a.total)} /></div>
            </div>
          </div>
        ))}
      </>)}

      <div className="modal-sub" style={{ borderLeftColor: '#7c3aed', color: '#5b21b6' }}>Brokerage Commission <span style={{ color: totalColor(brokTotal) }}>({formatCurrency(brokTotal)})</span></div>
      <div style={{ background: '#faf5ff', border: '1px solid #e9d5ff', borderRadius: 8, padding: 12, marginBottom: 12 }}>
        <strong style={{ fontSize: 12, color: '#5b21b6' }}>Minimum Brokerage Commission</strong>
        <div className="fin-sum" style={{ marginTop: 10, marginBottom: 0 }}>
          <div className="field" style={{ marginBottom: 0 }}><label>Commission</label><input value={formatCurrency(minBrok.commission)} readOnly /></div>
          <div className="field" style={{ marginBottom: 0 }}><label>HST</label><input value={formatCurrency(minBrok.hst)} readOnly /></div>
          <div className="field" style={{ marginBottom: 0 }}><label>Total</label><input value={formatCurrency(minBrok.total)} readOnly style={{ fontWeight: 700, color: '#5b21b6' }} /></div>
        </div>
      </div>
      {rows.map((r, i) => (
        <div className="brok-card" key={i}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}><strong style={{ fontSize: 13 }}>{(r.m.name || '').toUpperCase()}</strong><span className="pill" style={{ background: '#f3e8ff', color: '#6b21a8', border: '1px solid #d8b4fe', fontSize: 10 }}>Split: {r.m.split}%</span></div>
          <div className="g4">
            <div className="field" style={{ marginBottom: 0 }}><label>Brok Comm (%) <Icon name="lock" size={11} /></label><input type="number" value={r.m.brok_pct} readOnly style={{ ...lockField, ...pctStyle }} /></div>
            <div className="field" style={{ marginBottom: 0 }}><label>Commission</label><input readOnly style={cs(r.brok.commission)} value={formatCurrency(r.brok.commission)} /></div>
            <div className="field" style={{ marginBottom: 0 }}><label>HST</label><input readOnly style={cs(r.brok.hst)} value={formatCurrency(r.brok.hst)} /></div>
            <div className="field" style={{ marginBottom: 0 }}><label>Total</label><input readOnly style={ts(r.brok.total)} value={formatCurrency(r.brok.total)} /></div>
          </div>
        </div>
      ))}
    </>
  );
}

// Deal-level referral summary — "Commissions after broker referral" (external
// brokerage referral, off commission) and "Agent Commissions after client
// referral" (off Total). Shown only for the categories set to Yes in Adjustment.
function ReferralSections({ data }: { data: ReferralView | null }) {
  if (!data || (!data.showBroker && !data.showClient)) return null;
  return (
    <>
      <div className="modal-sub">Commissions</div>
      {data.showBroker && (
        <>
          <span className="pill info" style={{ fontSize: 11, marginBottom: 8, display: 'inline-block' }}>Commissions after broker referral</span>
          <div className="fin-sum">
            <Box label="Commission without HST" value={formatCurrency(data.afterBroker.commission)} />
            <Box label="HST (13%)" value={formatCurrency(data.afterBroker.hst)} />
            <Box label="Total Commission (With HST)" value={formatCurrency(data.afterBroker.total)} brand />
          </div>
        </>
      )}
      {data.showClient && (
        <>
          <span className="pill ok" style={{ fontSize: 11, marginBottom: 8, display: 'inline-block' }}>Agent Commissions after client referral</span>
          <div className="fin-sum">
            <Box label="Commission Without HST" value={formatCurrency(data.afterClient.commission)} />
            <Box label="HST (13%)" value={formatCurrency(data.afterClient.hst)} />
            <Box label="Total Commission (With HST)" value={formatCurrency(data.afterClient.total)} brand />
          </div>
        </>
      )}
    </>
  );
}

// Adjustment input with a +/− sign toggle. "+" increases the commission, "−"
// decreases it. The stored value is signed to match the formula convention:
//   'sub'  → commission − value  (so "−" stores +mag, "+" stores −mag)
//   'add'  → commission + value  (so "+" stores +mag, "−" stores −mag)
function SignedAdjField({ label, value, onChange, convention = 'sub' }: { label: string; value: number | string; onChange: (v: number) => void; convention?: 'sub' | 'add' }) {
  const signOf = (n: number): string | null => (n === 0 ? null : (convention === 'sub' ? (n > 0 ? '-' : '+') : (n < 0 ? '-' : '+')));
  const [sign, setSign] = useState(signOf(parseNumber(value)) || '-');
  const [mag, setMag] = useState(() => { const n = parseNumber(value); return n === 0 ? '' : String(Math.abs(n)); });

  // Re-sync from the parent when the magnitude actually changes elsewhere (e.g. the
  // mutually-exclusive sibling field clears this one) — but don't fight live typing.
  useEffect(() => {
    const n = parseNumber(value);
    if (Math.abs(n) !== Math.abs(parseNumber(mag))) setMag(n === 0 ? '' : String(Math.abs(n)));
    const s = signOf(n);
    if (s) setSign(s);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  const stored = (s: string, m: number | string) => { const mm = Math.abs(parseNumber(m)); return convention === 'sub' ? (s === '-' ? mm : -mm) : (s === '-' ? -mm : mm); };
  const pickSign = (s: string) => { setSign(s); onChange(stored(s, mag)); };
  const onMag = (m: string) => { setMag(m); onChange(stored(sign, m)); };

  return (
    <div className="field" style={{ marginBottom: 0 }}>
      <label>{label}</label>
      <div style={{ display: 'flex', gap: 6 }}>
        <div className="seg-toggle" style={{ flex: '0 0 auto' }}>
          <button type="button" className={`seg-btn ${sign === '+' ? 'active' : ''}`} onClick={() => pickSign('+')} title="Increase commission">+</button>
          <button type="button" className={`seg-btn ${sign === '-' ? 'active' : ''}`} onClick={() => pickSign('-')} title="Decrease commission">−</button>
        </div>
        <input value={mag} onChange={(e) => onMag(e.target.value)} placeholder="0.00" style={{ flex: 1 }} />
      </div>
    </div>
  );
}

function Box({ label, value, brand }: { label: string; value: string; brand?: boolean }) {
  // Commission / HST → blue, Total → green; any negative value → red.
  const l = (label || '').toLowerCase();
  const neg = typeof value === 'string' && value.includes('-');
  let color: string | undefined;
  if (l.includes('total') || l.includes('paid out')) color = neg ? 'var(--bad)' : 'var(--ok-600)';
  else if (l.includes('commission') || l.includes('hst')) color = neg ? 'var(--bad)' : 'var(--info)';
  return (
    <div className="field" style={{ marginBottom: 0 }}>
      <label>{label}</label>
      <input value={value} readOnly className={brand && !color ? 'brand' : ''} style={color ? { color, fontWeight: 700 } : undefined} />
    </div>
  );
}
