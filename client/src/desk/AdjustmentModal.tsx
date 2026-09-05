import { useState, useEffect, type ChangeEventHandler, type CSSProperties } from 'react';
import { updateTransaction, getAgentLoans } from '../lib/api';
import { batchNo, parseNumber, formatCurrency, isPreconType } from './format';
import { useToast } from './toast';
import { apiErrorMessage } from '../lib/apiError';
import SavedBadge from './SavedBadge';
import ConfirmDialog, { useConfirm } from './ConfirmDialog';
import MoneyInput, { groupMoney } from './MoneyInput';
import type { AdjustmentEntry, AgentLoanMap, ExtReferral, Transaction } from '../types';

/** The three dynamic adjustment lists share the entry shape. */
type RowKey = 'adjustment_rows' | 'advance_rows' | 'client_rows';
/** The Yes/No toggle in front of each of the four sections. */
type ToggleKey = 'agent_adjust' | 'advance_payment' | 'client_referral' | 'ext_referral';

interface AdjustmentForm {
  agent_adjust: string;
  adjustment_rows: AdjustmentEntry[];
  advance_payment: string;
  advance_rows: AdjustmentEntry[];
  client_referral: string;
  client_rows: AdjustmentEntry[];
  ext_referral: string;
  ext: ExtReferral;
}

// Linked-impact note shown per adjustment list when deleting a row.
const ADJ_LINKED: Record<RowKey, string[]> = {
  adjustment_rows: ['Agent Commission (deducted from the agent total in Financial Information)', 'Agent breakdown in Agent Payment Readiness'],
  advance_rows: ['Agent cash-to-pay (advance is deducted in Financial Information)', 'Agent breakdown in Agent Payment Readiness'],
  client_rows: ['“Commissions after client referral” in Financial Information', 'Client referral totals'],
};
const ADJ_TITLE: Record<RowKey, string> = { adjustment_rows: 'agent adjustment', advance_rows: 'advance payment', client_rows: 'client referral' };

/** The external referral's fields, blank — the shape the form edits when the section is switched on. */
const BLANK_EXT: ExtReferral = { agent_name: '', brokerage: '', amount: '', invoice_received: 'No', hst_no: '', paid_type: 'N/A', paid_date: '', batch_no: '', paid_status: '' };

/**
 * TD-111 — has this entry been filled in at all?
 *
 * A section switched off is emptied, and emptying it is announced to the user. The blank row this
 * modal adds the moment a toggle goes to Yes must not trigger that announcement: nobody typed it,
 * and warning about losing it teaches people to click through the warning that matters. 'No' and
 * 'N/A' are the defaults on this panel's own selects, so they do not count as content either.
 */
const hasContent = (row: Record<string, unknown> | null | undefined): boolean =>
  !!row && Object.values(row).some((v) => v !== null && v !== undefined && v !== '' && v !== false && v !== 'No' && v !== 'N/A');

const lbl: CSSProperties = { fontSize: 11.5, color: 'var(--text-2)', fontWeight: 600, marginBottom: 5, display: 'block' };

// Amount input with a +/− sign toggle. "−" deducts from the agent commission
// (stored positive — the commission math subtracts it); "+" adds it back (stored
// negative). Default "−" (deduct).
function SignedAmount({ value, onChange }: { value: number | string | null | undefined; onChange: (v: number) => void }) {
  const [sign, setSign] = useState(parseNumber(value) < 0 ? '+' : '-');
  const [mag, setMag] = useState(() => { const n = parseNumber(value); return n === 0 ? '' : String(Math.abs(n)); });
  useEffect(() => {
    const n = parseNumber(value);
    if (Math.abs(n) !== Math.abs(parseNumber(mag))) setMag(n === 0 ? '' : String(Math.abs(n)));
    if (n !== 0) setSign(n < 0 ? '+' : '-');
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const stored = (s: string, m: number | string) => { const mm = Math.abs(parseNumber(m)); return s === '-' ? mm : -mm; };
  const pick = (s: string) => { setSign(s); onChange(stored(s, mag)); };
  const onMag = (m: string) => { setMag(m); onChange(stored(sign, m)); };
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <div className="seg-toggle" style={{ flex: '0 0 auto' }}>
        <button type="button" className={`seg-btn ${sign === '+' ? 'active' : ''}`} onClick={() => pick('+')} title="Add to agent commission">+</button>
        <button type="button" className={`seg-btn ${sign === '-' ? 'active' : ''}`} onClick={() => pick('-')} title="Deduct from agent commission">−</button>
      </div>
      <input value={groupMoney(mag)} inputMode="decimal" onChange={(e) => onMag(e.target.value.replace(/,/g, ''))} placeholder="0.00" style={{ flex: 1 }} />
    </div>
  );
}

interface AdjustmentModalProps {
  open: boolean;
  onClose: () => void;
  transactionId: number | string;
  txn: Transaction;
  onSaved?: (updated: Transaction) => void;
  termCount?: number;
  readOnly?: boolean;
}

export default function AdjustmentModal({ open, onClose, transactionId, txn, onSaved, termCount: termCountProp, readOnly = false }: AdjustmentModalProps) {
  const toast = useToast();
  const precon = isPreconType(txn.type);
  const termCount = (typeof termCountProp === 'number' ? termCountProp : (parseInt(String(txn.precon_term_count), 10) || 0));
  const termOptions = Array.from({ length: termCount }, (_, k) => k + 1);
  const agentNames = (txn.team && txn.team.length ? txn.team.map((t) => t.name) : (txn.agent ? [txn.agent] : [])).filter((n): n is string => !!n);
  const termSelect = (val: number | string | null | undefined, onCh: ChangeEventHandler<HTMLSelectElement>) => (
    <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Term</label>
      <select value={val || ''} onChange={onCh}><option value="">Select term</option>{termOptions.map((t) => <option key={t} value={t}>Term {t}</option>)}</select></div>
  );

  const [form, setForm] = useState<AdjustmentForm>(() => {
    const a = txn.adjustments || {};
    return {
      agent_adjust: a.agent_adjust || 'No', adjustment_rows: a.adjustment_rows || [],
      advance_payment: a.advance_payment || 'No', advance_rows: a.advance_rows || [],
      client_referral: a.client_referral || 'No', client_rows: a.client_rows || [],
      // Merged over the blank shape, not substituted for it: a switched-off section is stored empty
      // (TD-111), and `{}` on its own would leave every input in here without a value.
      ext_referral: a.ext_referral || 'No', ext: { ...BLANK_EXT, ...(a.ext || {}) },
    };
  });
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false); // §3.2 — "Saved" then auto-close
  const { confirm, askDelete, closeConfirm } = useConfirm();

  // Each agent's outstanding loan (actual − prior loan-repayment adjustments across
  // all deals) so a loan-repayment row can show what's still owed.
  const [agentLoans, setAgentLoans] = useState<AgentLoanMap>({});
  useEffect(() => { if (open) getAgentLoans().then(setAgentLoans).catch(() => {}); }, [open]);
  // Balance still owed once this transaction's own loan repayments are applied
  // (backend already reflects saved rows; subtract this form's rows to avoid double count for a re-edit).
  const loanBalanceFor = (name: string | undefined): number | null => {
    if (!name) return null;
    const info = agentLoans[name];
    if (!info) return null;
    // Gated the way the server's loan ledger is (TD-111): a repayment behind a switched-off section
    // is not counted there, so adding it back here would understate what the agent still owes.
    const savedHere = (txn.adjustments?.agent_adjust === 'Yes' ? (txn.adjustments?.adjustment_rows || []) : [])
      .filter((r) => r.agent === name && r.is_loan)
      .reduce((s, r) => s + Math.max(0, parseNumber(r.amount)), 0);
    const pendingHere = form.adjustment_rows
      .filter((r) => r.agent === name && r.is_loan)
      .reduce((s, r) => s + Math.max(0, parseNumber(r.amount)), 0);
    return Math.max(0, (info.loan_balance || 0) + savedHere - pendingHere);
  };

  if (!open) return null;

  const set = (k: ToggleKey, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const setRow = (key: RowKey, i: number, patch: Partial<AdjustmentEntry>) => setForm((f) => ({ ...f, [key]: f[key].map((r, idx) => idx === i ? { ...r, ...patch } : r) }));
  const addRow = (key: RowKey, row: AdjustmentEntry) => setForm((f) => ({ ...f, [key]: [...f[key], row] }));
  const rmRow = (key: RowKey, i: number) => askDelete({
    title: `Delete ${ADJ_TITLE[key] || 'row'}?`,
    message: 'Remove this entry? It will apply when you Save.',
    linked: ADJ_LINKED[key] || [],
    onConfirm: () => setForm((f) => ({ ...f, [key]: f[key].filter((_, idx) => idx !== i) })),
  });
  const setExt = (patch: Partial<ExtReferral>) => setForm((f) => ({ ...f, ext: { ...f.ext, ...patch } }));

  /*
   * TD-111 — SWITCHING A SECTION OFF EMPTIES IT, AND SAYS SO FIRST.
   *
   * Setting a toggle back to No used to hide the rows and leave them in the record. The deal stopped
   * applying them, so nothing moved — but the entries sat there invisibly, and would be applied
   * again the moment anybody set the toggle back to Yes, including somebody who had no idea they
   * were there. The server clears them on save; this is the half that asks first, because a user
   * who switches a section off has every reason to believe the entries are gone and should be told
   * plainly that they are.
   *
   * The rows go to the Recycle Bin like any other deleted row — the server files them from the same
   * capture — so the warning can promise they are recoverable, and restoring one switches the
   * section back on by itself.
   */
  const switchSectionOff = (toggle: ToggleKey, key: RowKey, label: string) => {
    const clear = () => setForm((f) => ({ ...f, [toggle]: 'No', [key]: [] }));
    const filled = form[key].filter((r) => hasContent(r as unknown as Record<string, unknown>)).length;
    if (filled === 0) { clear(); return; }
    askDelete({
      title: `Switch ${label} off?`,
      message: `${filled} ${filled === 1 ? 'entry' : 'entries'} recorded here will be removed from this transaction when you Save. You can restore ${filled === 1 ? 'it' : 'them'} from the Recycle Bin.`,
      linked: ADJ_LINKED[key] || [],
      confirmLabel: 'Remove and switch off',
      onConfirm: clear,
    });
  };
  const switchExtOff = () => {
    const clear = () => setForm((f) => ({ ...f, ext_referral: 'No', ext: { ...BLANK_EXT } }));
    if (!hasContent(form.ext as unknown as Record<string, unknown>)) { clear(); return; }
    askDelete({
      title: 'Switch External Brokerage Agent Referral off?',
      message: 'The referral recorded here will be removed from this transaction when you Save. You can restore it from the Recycle Bin.',
      linked: ['Commission after external referral (Financial Information)', 'External referral totals in the financial reports'],
      confirmLabel: 'Remove and switch off',
      onConfirm: clear,
    });
  };

  const extAmt = parseNumber(form.ext.amount);
  const extHst = Math.round(extAmt * 0.13 * 100) / 100;
  const extTotal = Math.round((extAmt + extHst) * 100) / 100;

  // Gross Agent Commission total per agent (the T4A total) — the cap for an agent's
  // adjustment + advance so the Agent Commission total can't go negative.
  const fin = txn.financial || {};
  const grossByAgent: Record<string, number> = {};
  const addGross = (name: string | undefined, v: number | undefined) => { if (name) grossByAgent[name] = (grossByAgent[name] || 0) + (v || 0); };
  // Cap = each agent's gross Agent Commission (T4A total). `financial.agents` carries
  // t4a for BOTH the standard (Buying) and listing variants, so prefer it — the listing
  // `members` rows omit t4a, which previously left the cap wrong. Precon uses per-term agents.
  if (fin.terms?.length) fin.terms.forEach((t) => (t.agents || []).forEach((a) => addGross(a.name, a.t4a?.total)));
  else if (fin.agents?.length) fin.agents.forEach((a) => addGross(a.name, a.t4a?.total));
  else (fin.members || []).forEach((m) => addGross(m.name, m.t4a?.total ?? m.earned));

  // Adjustment Status is auto: 'Yet to Adjust' once agent + amount are set; 'Closed'
  // once THAT agent's commission is marked Paid in Admin Activities (Agent Commission
  // Paid → Paid Status = Paid). A global "commission paid" flag also closes all rows.
  const paidAgents = (() => {
    const set = new Set<string>();
    const admin = txn.admin_activities || {};
    const scan = (agents?: Record<string, { payments?: { paid_status?: string }[] }>) => Object.entries(agents || {}).forEach(([name, info]) => {
      if ((info?.payments || []).some((p) => p.paid_status === 'Paid')) set.add(name);
    });
    scan(admin.agents);
    Object.values(admin.term_admin || {}).forEach((t) => scan(t?.agents)); // preconstruction per-term
    return set;
  })();
  const dealPaid = txn.activity_tracker?.agent_commission_paid_status === 'Yes' || txn.comm_paid_status === 'Yes';
  const autoStatus = (r: AdjustmentEntry) => {
    if (r.agent && (paidAgents.has(r.agent) || dealPaid)) return 'Closed';
    return (r.agent && parseNumber(r.amount) !== 0) ? 'Yet to Adjust' : '';
  };

  // Total deduction (agent adjust + advance) entered for an agent.
  const deductFor = (name: string) => {
    let d = 0;
    if (form.agent_adjust === 'Yes') form.adjustment_rows.forEach((r) => { if (r.agent === name) d += parseNumber(r.amount); });
    if (form.advance_payment === 'Yes') form.advance_rows.forEach((r) => { if (r.agent === name) d += parseNumber(r.amount); });
    return d;
  };
  // Inline "max allowed" note when an agent's adjustment + advance exceeds their total.
  const overNote = (name: string | undefined) => {
    if (!name) return null;
    const cap = grossByAgent[name];
    if (cap == null || deductFor(name) <= cap + 0.005) return null;
    return <div className="help" style={{ color: 'var(--bad)', margin: '4px 0 0' }}>⚠ Max adjustment allowed: {formatCurrency(cap)} (agent's Agent Commission total)</div>;
  };

  const save = async () => {
    // Adjustment + advance must not exceed the agent's Agent Commission total.
    for (const name of agentNames) {
      const cap = grossByAgent[name];
      if (cap == null) continue;
      if (deductFor(name) > cap + 0.005) {
        toast(`Max adjustment allowed for ${name} is ${formatCurrency(cap)} (the agent's Agent Commission total).`, 'bad');
        return;
      }
    }
    setSaving(true);
    // Persist the auto-derived Status on each adjustment row.
    const payload = { ...form, adjustment_rows: form.adjustment_rows.map((r) => ({ ...r, status: autoStatus(r) })) };
    try {
      const updated = await updateTransaction(transactionId, { adjustments: payload });
      onSaved?.(updated);
      setSavedOk(true);
      setTimeout(() => { setSavedOk(false); onClose(); }, 2000);
    } catch (e) { toast(apiErrorMessage(e, 'Could not save'), 'bad'); setSaving(false); }
  };

  // Each agent can only be picked once per list (except preconstruction, which is
  // term-based and may repeat an agent across terms). `usedAgents` are the agents
  // already chosen in the OTHER rows of the same list.
  const agentSelect = (val: string | undefined, onCh: ChangeEventHandler<HTMLSelectElement>, usedAgents: string[] = []) => {
    const opts = precon ? agentNames : agentNames.filter((n) => n === val || !usedAgents.includes(n));
    return (
      <select value={val ?? ''} onChange={onCh}><option value="">Select agent</option>{opts.map((n) => <option key={n} value={n}>{n}</option>)}</select>
    );
  };
  const usedIn = (key: RowKey, i: number): string[] => form[key].filter((_, idx) => idx !== i).map((r) => r.agent).filter((a): a is string => !!a);
  // For non-preconstruction, you can't add more rows than there are agents.
  const canAddFor = (key: RowKey) => precon || form[key].length < agentNames.length;

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal lg">
        <button className="close" onClick={onClose}>✕</button>
        <div className="modal-h">Adjustment &amp; Advance Payment</div>

        {readOnly && (
          <div className="card" style={{ borderLeft: '4px solid #2563eb', background: 'var(--info-bg)', marginBottom: 12 }}>
            <span style={{ fontSize: 12.5, color: 'var(--info-ink)' }}>🔒 Locked — adjustments, advance payments and referrals can’t be changed once the agent payment is complete (or while viewing). Click <strong>Edit</strong> if the transaction is still open.</span>
          </div>
        )}

        <fieldset disabled={readOnly} style={{ border: 0, margin: 0, padding: 0, minInlineSize: 0 }}>

        {/* Adjustment Details */}
        <div className="modal-sub">Adjustment Details</div>
        <div className="field" style={{ maxWidth: 220 }}><label style={lbl}>Agent Adjust</label>
          <select value={form.agent_adjust} onChange={(e) => { const v = e.target.value; if (v !== 'Yes') { switchSectionOff('agent_adjust', 'adjustment_rows', 'Agent Adjust'); return; } set('agent_adjust', v); if (form.adjustment_rows.length === 0) addRow('adjustment_rows', { agent: '', amount: '', status: '', remarks: '', is_loan: false }); }}><option>No</option><option>Yes</option></select></div>
        {form.agent_adjust === 'Yes' && (<>
          {form.adjustment_rows.map((r, i) => (
            <div className="dyn-list-box" key={i}>
              <div style={{ display: 'grid', gridTemplateColumns: precon ? 'repeat(4,1fr)' : 'repeat(3,1fr)', gap: 14 }}>
                <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Agent Name</label>{agentSelect(r.agent, (e) => setRow('adjustment_rows', i, { agent: e.target.value }), usedIn('adjustment_rows', i))}</div>
                <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Amount</label><SignedAmount value={r.amount} onChange={(nv) => setRow('adjustment_rows', i, { amount: nv })} />{overNote(r.agent)}</div>
                <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Status</label><input value={autoStatus(r) || '—'} readOnly style={{ background: 'var(--surface-2)', fontWeight: 600 }} title="Auto — 'Yet to Adjust' once agent + amount are set; 'Closed' once this agent's commission is marked Paid in Admin Activities." /></div>
                {precon && termSelect(r.term, (e) => setRow('adjustment_rows', i, { term: e.target.value }))}
              </div>
              {(r.is_loan || loanBalanceFor(r.agent) != null) && (
                <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--text-2)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={!!r.is_loan} onChange={(e) => setRow('adjustment_rows', i, { is_loan: e.target.checked })} />
                    Loan repayment
                  </label>
                  {r.agent && loanBalanceFor(r.agent) != null && (
                    <span className="pill info" style={{ fontSize: 11 }}>Outstanding loan: {formatCurrency(loanBalanceFor(r.agent))}</span>
                  )}
                  {r.is_loan && r.agent && loanBalanceFor(r.agent) != null && parseNumber(r.amount) > (loanBalanceFor(r.agent) ?? 0) + 0.005 && (
                    <span className="help" style={{ color: 'var(--bad)', margin: 0 }}>⚠ Exceeds the agent's outstanding loan balance.</span>
                  )}
                </div>
              )}
              <div className="field" style={{ marginTop: 10, marginBottom: 0 }}><label style={lbl}>Remarks</label><textarea rows={1} value={r.remarks} onChange={(e) => setRow('adjustment_rows', i, { remarks: e.target.value })} /></div>
              <div style={{ textAlign: 'right', marginTop: 6 }}><button className="row-rm" onClick={() => rmRow('adjustment_rows', i)}>🗑️</button></div>
            </div>
          ))}
          {canAddFor('adjustment_rows') && <button className="btn primary sm" onClick={() => addRow('adjustment_rows', { agent: '', amount: '', status: '', remarks: '', is_loan: false })}>+ Add New</button>}
        </>)}

        {/* Advance Payment */}
        <div className="modal-sub">Advance Payment Details</div>
        <div className="field" style={{ maxWidth: 220 }}><label style={lbl}>Advance Payment</label>
          <select value={form.advance_payment} onChange={(e) => { const v = e.target.value; if (v !== 'Yes') { switchSectionOff('advance_payment', 'advance_rows', 'Advance Payment'); return; } set('advance_payment', v); if (form.advance_rows.length === 0) addRow('advance_rows', { agent: '', amount: '', paid_type: 'N/A', paid_date: '', batch_no: '', remarks: '' }); }}><option>No</option><option>Yes</option></select></div>
        {form.advance_payment === 'Yes' && (<>
          {form.advance_rows.map((r, i) => (
            <div className="dyn-list-box" key={i}>
              <div style={{ display: 'grid', gridTemplateColumns: precon ? 'repeat(6,1fr)' : 'repeat(5,1fr)', gap: 14 }}>
                <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Agent Name</label>{agentSelect(r.agent, (e) => setRow('advance_rows', i, { agent: e.target.value }), usedIn('advance_rows', i))}</div>
                <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Amount</label><MoneyInput value={r.amount} onChange={(v) => setRow('advance_rows', i, { amount: v })} placeholder="0.00" />{overNote(r.agent)}</div>
                <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Paid Type</label><select value={r.paid_type || 'N/A'} onChange={(e) => setRow('advance_rows', i, { paid_type: e.target.value })}><option>N/A</option><option>TDB-EFT</option><option>Cheque</option><option>Wire</option></select></div>
                <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Paid Date</label><input type="date" value={r.paid_date} onChange={(e) => setRow('advance_rows', i, { paid_date: e.target.value, batch_no: batchNo(e.target.value) })} /></div>
                <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Batch No.</label><input value={r.batch_no} readOnly style={{ background: 'var(--surface-2)' }} /></div>
                {precon && termSelect(r.term, (e) => setRow('advance_rows', i, { term: e.target.value }))}
              </div>
              <div className="field" style={{ marginTop: 10, marginBottom: 0 }}><label style={lbl}>Remarks</label><textarea rows={1} value={r.remarks} onChange={(e) => setRow('advance_rows', i, { remarks: e.target.value })} /></div>
              <div style={{ textAlign: 'right', marginTop: 6 }}><button className="row-rm" onClick={() => rmRow('advance_rows', i)}>🗑️</button></div>
            </div>
          ))}
          {canAddFor('advance_rows') && <button className="btn primary sm" onClick={() => addRow('advance_rows', { agent: '', amount: '', paid_type: 'N/A', paid_date: '', batch_no: '', remarks: '' })}>+ Add New</button>}
        </>)}

        {/* Client Referral */}
        <div className="modal-sub">Client Referral</div>
        <div className="field" style={{ maxWidth: 220 }}><label style={lbl}>Client Referral</label>
          <select value={form.client_referral} onChange={(e) => { const v = e.target.value; if (v !== 'Yes') { switchSectionOff('client_referral', 'client_rows', 'Client Referral'); return; } set('client_referral', v); if (form.client_rows.length === 0) addRow('client_rows', { client_name: '', amount: '', void_cheque: 'No', paid_type: 'N/A', paid_date: '', batch_no: '', paid_status: '' }); }}><option>No</option><option>Yes</option></select></div>
        {form.client_referral === 'Yes' && (<>
          {form.client_rows.map((r, i) => (
            <div className="dyn-list-box" key={i}>
              <div className="g3">
                <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Client Name</label><input value={r.client_name} onChange={(e) => setRow('client_rows', i, { client_name: e.target.value })} /></div>
                <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Referral Amount</label><MoneyInput value={r.amount} onChange={(v) => setRow('client_rows', i, { amount: v })} placeholder="0.00" /></div>
                <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Void Cheque Received</label><select value={r.void_cheque} onChange={(e) => setRow('client_rows', i, { void_cheque: e.target.value })}><option>No</option><option>Yes</option></select></div>
              </div>
              {r.void_cheque === 'Yes' && (
                <div className="g4" style={{ marginTop: 10 }}>
                  <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Paid Type</label><select value={r.paid_type} onChange={(e) => setRow('client_rows', i, { paid_type: e.target.value })}><option>N/A</option><option>TDB-EFT</option><option>Cheque</option><option>Wire</option></select></div>
                  <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Paid Date</label><input type="date" value={r.paid_date} onChange={(e) => setRow('client_rows', i, { paid_date: e.target.value, batch_no: batchNo(e.target.value), paid_status: e.target.value ? 'Paid' : '' })} /></div>
                  <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Batch No.</label><input value={r.batch_no} readOnly style={{ background: 'var(--surface-2)' }} /></div>
                  <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Paid Status</label><input value={r.paid_status} readOnly style={{ background: 'var(--surface-2)' }} /></div>
                </div>
              )}
              <div style={{ textAlign: 'right', marginTop: 6 }}><button className="row-rm" onClick={() => rmRow('client_rows', i)}>🗑️</button></div>
            </div>
          ))}
          <button className="btn primary sm" onClick={() => addRow('client_rows', { client_name: '', amount: '', void_cheque: 'No', paid_type: 'N/A', paid_date: '', batch_no: '', paid_status: '' })}>+ Add Client</button>
        </>)}

        {/* External Brokerage Referral */}
        <div className="modal-sub">External Brokerage Agent Referral</div>
        <div className="field" style={{ maxWidth: 260 }}><label style={lbl}>External Brokerage Agent Referral</label>
          <select value={form.ext_referral} onChange={(e) => { const v = e.target.value; if (v !== 'Yes') { switchExtOff(); return; } set('ext_referral', v); }}><option>No</option><option>Yes</option></select></div>
        {form.ext_referral === 'Yes' && (
          <div className="dyn-list-box">
            <div className="g2">
              <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Referral Agent Name</label><input value={form.ext.agent_name} onChange={(e) => setExt({ agent_name: e.target.value })} /></div>
              <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Brokerage Details</label><input value={form.ext.brokerage} onChange={(e) => setExt({ brokerage: e.target.value })} /></div>
            </div>
            <div className="g4" style={{ marginTop: 10 }}>
              <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Percentage (%)</label>
                <input value={form.ext.pct ?? ''} onChange={(e) => {
                  const p = e.target.value;
                  const amt = parseNumber(p) > 0 ? Math.round((parseNumber(txn.price) * parseNumber(p) / 100 + Number.EPSILON) * 100) / 100 : '';
                  setExt({ pct: p, amount: amt });
                }} placeholder="e.g. 1.5" /></div>
              <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Amount</label><MoneyInput value={form.ext.amount} onChange={(v) => setExt({ amount: v, pct: '' })} placeholder="0.00" /></div>
              <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>HST</label><input value={formatCurrency(extHst)} readOnly style={{ background: 'var(--surface-2)' }} /></div>
              <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Total</label><input value={formatCurrency(extTotal)} readOnly style={{ background: 'var(--surface-2)' }} /></div>
            </div>
            <div className="g2" style={{ marginTop: 10 }}>
              <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Referral Agent Invoice Received?</label><select value={form.ext.invoice_received} onChange={(e) => setExt({ invoice_received: e.target.value })}><option>No</option><option>Yes</option></select></div>
              {form.ext.invoice_received === 'Yes' && <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Brokerage HST No.</label><input value={form.ext.hst_no} onChange={(e) => setExt({ hst_no: e.target.value })} placeholder="e.g. 123456789 RT0001" /></div>}
            </div>
            {form.ext.invoice_received === 'Yes' && (
              <div className="g4" style={{ marginTop: 10 }}>
                <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Paid Type</label><select value={form.ext.paid_type} onChange={(e) => setExt({ paid_type: e.target.value })}><option>N/A</option><option>TDB-EFT</option><option>Cheque</option><option>Wire</option></select></div>
                <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Paid Date</label><input type="date" value={form.ext.paid_date} onChange={(e) => setExt({ paid_date: e.target.value, batch_no: batchNo(e.target.value), paid_status: e.target.value ? 'Paid' : '' })} /></div>
                <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Batch No.</label><input value={form.ext.batch_no} readOnly style={{ background: 'var(--surface-2)' }} /></div>
                <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Paid Status</label><input value={form.ext.paid_status} readOnly style={{ background: 'var(--surface-2)' }} /></div>
              </div>
            )}
          </div>
        )}

        </fieldset>

        <SavedBadge show={savedOk} />

        <div className="actions">
          <button className="btn ghost" onClick={onClose}>Close</button>
          {!readOnly && <button className="btn primary" onClick={save} disabled={saving || savedOk}>{savedOk ? '✓ Saved' : (saving ? 'Saving…' : 'Save')}</button>}
        </div>
      </div>
      <ConfirmDialog confirm={confirm} onClose={closeConfirm} />
    </div>
  );
}
