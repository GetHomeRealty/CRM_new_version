import { useState, type CSSProperties } from 'react';
import Icon from '../ui/Icon';
import { updateTransaction } from '../lib/api';
import { batchNo, t4aYear, isListingType, isPreconType } from './format';
import { useToast } from './toast';
import { apiErrorMessage } from '../lib/apiError';
import SavedBadge from './SavedBadge';
import ConfirmDialog, { useConfirm } from './ConfirmDialog';
import { useAuth } from '../context/AuthContext';
import MoneyInput from './MoneyInput';
import type {
  AdminDeposit, AdminNote, AgentPayment, CoopInvoice, LawyerPayment, PaidClient,
  PaidLawyer, RecvLawyer, TaCta, TeamMemberData, Transaction,
} from '../types';

const PAY_LINKED = ['Agent payment / T4A history in Admin Activities', 'Agent breakdown in Agent Payment Readiness'];

const lbl: CSSProperties = { fontSize: 11.5, color: 'var(--text-2)', fontWeight: 600, marginBottom: 5, display: 'block' };

// Per-agent admin block in the form (payments/cta always present as arrays).
interface FormAgent { invoice_received?: string; payments: AgentPayment[]; cta: AgentPayment[]; }
interface FormTermAdmin {
  invoice_sent?: string;
  invoice_number?: string;
  commission_received_date?: string;
  commission_received_via?: string;
  remarks?: string;
  agents: Record<string, FormAgent>;
}
interface AdminForm {
  invoice_sent_status: string;
  invoice_number: string;
  commission_received_date: string;
  commission_received_via: string;
  deposits: AdminDeposit[];
  void_cheque_received: string;
  lawyer_statement_sent: string;
  recv_lawyer: RecvLawyer;
  paid_lawyer: PaidLawyer;
  paid_client: PaidClient;
  coop_invoice: CoopInvoice;
  ta_cta: TaCta;
  agents: Record<string, FormAgent>;
  notes: AdminNote[];
  term_admin: Record<number, FormTermAdmin>;
}
type ObjKey = 'recv_lawyer' | 'paid_lawyer' | 'paid_client' | 'coop_invoice' | 'ta_cta';

// Remarks stamp: the saved date plus Canada EST + India IST times (only for notes that
// carry a full timestamp), then the author's role + name.
const noteStamp = (note: AdminNote): string => {
  const dateStr = note.date || (note.created_at ? note.created_at.slice(0, 10) : '');
  if (!note.created_at) return dateStr;
  const d = new Date(note.created_at);
  if (isNaN(d.getTime())) return dateStr;
  const t = (tz: string) => d.toLocaleTimeString('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
  return `${dateStr} · ${t('America/Toronto')} EST · ${t('Asia/Kolkata')} IST`;
};
const noteAuthor = (note: AdminNote): string => `${note.role || 'Admin'}${note.author ? ` · ${note.author}` : ''}`;

interface AdminActivitiesModalProps {
  open: boolean;
  onClose: () => void;
  transactionId: number | string;
  txn: Transaction;
  onSaved?: (updated: Transaction) => void;
  termCount?: number;
  depositOnly?: boolean;
  dftNA?: boolean;
  readOnly?: boolean;
}

export default function AdminActivitiesModal({ open, onClose, transactionId, txn, onSaved, termCount: termCountProp, depositOnly = false, dftNA = false, readOnly = false }: AdminActivitiesModalProps) {
  const na = (v: string | undefined): string | undefined => (dftNA ? 'N/A' : v); // §5.1 DFT — status dropdowns default to N/A
  const { user, isSuperAdmin } = useAuth();
  const toast = useToast();
  const listing = isListingType(txn.type);
  const precon = isPreconType(txn.type);
  const hideLawyer = /lease/i.test(txn.type); // lease listings hide lawyer sub-sections
  // Trust "Payable to Client" = 0 → Paid to Client must be N/A (listing trust only).
  const fin = txn.financial || {};
  const clientNA = !!fin.trust && Number(fin.trust.payable_to_client || 0) <= 0;
  // Agent's net cash payable (after advance / adjustments). ≤ 0 → fully covered.
  const agentNet = (n: string): number | null => {
    const m = (fin.members || []).find((x) => x.name === n) || (fin.agents || []).find((x) => x.name === n);
    return m ? Number(m.cash_to_pay ?? m.agent?.total ?? 0) : null;
  };
  const netZeroAgent = (n: string) => { const v = agentNet(n); return v != null && v <= 0.005; };
  // Paid Status is auto-derived (no dropdown): N/A when the agent's commission is fully
  // covered by advance/adjustments; Paid when a Paid Type + Paid Date are entered; else blank.
  const paidStatusOf = (n: string, p: AgentPayment) => {
    if (netZeroAgent(n)) return 'N/A';
    if (p.paid_type && p.paid_type !== 'N/A' && p.paid_date) return 'Paid';
    return '';
  };
  const team: TeamMemberData[] = txn.team && txn.team.length ? txn.team : (txn.agent ? [{ name: txn.agent, scope: 'Entire', terms: [] }] : []);
  const agentNames = team.map((t) => t.name).filter((n): n is string => !!n);
  const termCount = (typeof termCountProp === 'number' ? termCountProp : (parseInt(String(txn.precon_term_count), 10) || 0));
  const termsArr = Array.from({ length: termCount }, (_, k) => k + 1);
  const visibleAt = (k: number): string[] => team.filter((m) => (m.scope || 'Entire') === 'Entire' || (m.terms || []).map(Number).includes(k)).map((m) => m.name).filter((n): n is string => !!n);
  // §12.4 — auto, read-only invoice fields from the linked invoice (computed by the backend).
  const invAdmin = txn.invoice_admin || {};
  const invByTerm = invAdmin.by_term || {};
  const [termFilter, setTermFilter] = useState<string>('All');

  const [form, setForm] = useState<AdminForm>(() => {
    const a = txn.admin_activities || {};
    const agents: Record<string, FormAgent> = {};
    agentNames.forEach((n) => {
      const ex = (a.agents && a.agents[n]) || {};
      // Every agent (single or split) always shows a CTA to BA transfer field, defaulting to "No".
      agents[n] = { invoice_received: ex.invoice_received || 'N/A', payments: ex.payments || [], cta: ex.cta?.length ? ex.cta : [{ cta: 'No', date: '', batch_no: '' }] };
    });
    return {
      invoice_sent_status: a.invoice_sent_status || '',
      invoice_number: a.invoice_number || '',
      commission_received_date: a.commission_received_date || '',
      commission_received_via: a.commission_received_via || '',
      // listing-layout fields
      deposits: a.deposits || [],
      void_cheque_received: a.void_cheque_received || '',
      lawyer_statement_sent: a.lawyer_statement_sent || '',
      recv_lawyer: (() => {
        const rl: RecvLawyer = a.recv_lawyer || { enabled: '', via: '', date: '' };
        // Default Received from Lawyer? from the financial receivable: N/A when ≤0, else No.
        if (!rl.enabled && fin.trust) {
          rl.enabled = Number(fin.trust.receivable_from_lawyer || 0) > 0 ? 'No' : 'N/A';
        }
        return rl;
      })(),
      paid_lawyer: (() => {
        const pl: PaidLawyer = { enabled: '', via: '', date: '', batch: '', paid_status: 'Pending', amount: '', payments: [], ...(a.paid_lawyer || {}) };
        // Default Paid to Lawyer? — N/A when the lawyer owes us (Receivable > 0); No when we owe them (< 0). Editable.
        if (!pl.enabled && fin.trust) {
          pl.enabled = Number(fin.trust.receivable_from_lawyer || 0) > 0 ? 'N/A' : (Number(fin.trust.receivable_from_lawyer || 0) < 0 ? 'No' : 'N/A');
        }
        if (!pl.paid_status) pl.paid_status = 'Pending';
        if (!Array.isArray(pl.payments)) pl.payments = [];
        return pl;
      })(),
      paid_client: (() => {
        const pc: PaidClient = a.paid_client || { enabled: '', via: '', date: '', batch: '' };
        // Default Paid to Client? from the financial payable: N/A when ≤0, else No.
        if (!pc.enabled && fin.trust) {
          pc.enabled = Number(fin.trust.payable_to_client || 0) > 0 ? 'No' : 'N/A';
        }
        return pc;
      })(),
      coop_invoice: a.coop_invoice || { enabled: '', gst_hst: '', via: '', date: '', batch: '' },
      ta_cta: a.ta_cta || { enabled: '', date: '', batch: '' },
      agents,
      notes: a.notes || [],
      // preconstruction per-term admin
      term_admin: (() => {
        const ta = a.term_admin || {};
        const out: Record<number, FormTermAdmin> = {};
        termsArr.forEach((k) => {
          const ex = ta[k] || {};
          const tAgents: Record<string, FormAgent> = {};
          visibleAt(k).forEach((n) => {
            const ea = (ex.agents && ex.agents[n]) || {};
            tAgents[n] = { invoice_received: ea.invoice_received || 'N/A', payments: ea.payments || [], cta: ea.cta?.length ? ea.cta : [{ cta: 'No', date: '', batch_no: '' }] };
          });
          out[k] = {
            invoice_sent: ex.invoice_sent || '', invoice_number: ex.invoice_number || '',
            commission_received_date: ex.commission_received_date || '', commission_received_via: ex.commission_received_via || '',
            remarks: ex.remarks || '', agents: tAgents,
          };
        });
        return out;
      })(),
    };
  });
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false); // §3.2 — "Saved" then auto-close
  const { confirm, askDelete, closeConfirm } = useConfirm();
  if (!open) return null;

  function set<K extends keyof AdminForm>(k: K, v: AdminForm[K]) { setForm((f) => ({ ...f, [k]: v })); }
  const setAgent = (n: string, k: 'invoice_received', v: string) => setForm((f) => ({ ...f, agents: { ...f.agents, [n]: { ...f.agents[n], [k]: v } } }));
  const addRow = (n: string, key: 'payments' | 'cta', row: AgentPayment) => setForm((f) => ({ ...f, agents: { ...f.agents, [n]: { ...f.agents[n], [key]: [...f.agents[n][key], row] } } }));
  const setRow = (n: string, key: 'payments' | 'cta', i: number, patch: Partial<AgentPayment>) => setForm((f) => ({ ...f, agents: { ...f.agents, [n]: { ...f.agents[n], [key]: f.agents[n][key].map((r, idx) => idx === i ? { ...r, ...patch } : r) } } }));
  const rmRow = (n: string, key: 'payments' | 'cta', i: number) => askDelete({
    title: `Delete ${key === 'cta' ? 'CTA transfer' : 'payment'}?`,
    message: 'Remove this entry? It applies when you Save.',
    linked: PAY_LINKED,
    onConfirm: () => setForm((f) => ({ ...f, agents: { ...f.agents, [n]: { ...f.agents[n], [key]: f.agents[n][key].filter((_, idx) => idx !== i) } } })),
  });
  const rmNote = (i: number) => askDelete({
    title: 'Delete note?',
    message: 'Remove this note? It applies when you Save.',
    onConfirm: () => setForm((f) => ({ ...f, notes: f.notes.filter((_, idx) => idx !== i) })),
  });
  function setObj<K extends ObjKey>(key: K, patch: Partial<AdminForm[K]>) { setForm((f) => ({ ...f, [key]: { ...f[key], ...patch } })); }
  // Paid to Lawyer — additional partial payments.
  const addPaidLawyerPayment = () => setForm((f) => ({ ...f, paid_lawyer: { ...f.paid_lawyer, payments: [...(f.paid_lawyer.payments || []), { paid_status: 'Pending', amount: '', via: '', date: '' }] } }));
  const setPaidLawyerPayment = (i: number, patch: Partial<LawyerPayment>) => setForm((f) => ({ ...f, paid_lawyer: { ...f.paid_lawyer, payments: (f.paid_lawyer.payments || []).map((p, idx) => idx === i ? { ...p, ...patch } : p) } }));
  const rmPaidLawyerPayment = (i: number) => setForm((f) => ({ ...f, paid_lawyer: { ...f.paid_lawyer, payments: (f.paid_lawyer.payments || []).filter((_, idx) => idx !== i) } }));
  const addDeposit = () => setForm((f) => ({ ...f, deposits: [...f.deposits, { date: '', received_via: '', receipt_sent: '' }] }));
  const setDeposit = (i: number, patch: Partial<AdminDeposit>) => setForm((f) => ({ ...f, deposits: f.deposits.map((d, idx) => idx === i ? { ...d, ...patch } : d) }));
  const rmDeposit = (i: number) => askDelete({
    title: 'Delete deposit?',
    message: 'Remove this deposit entry? It applies when you Save.',
    linked: ['Deposit records in Admin Activities', 'Trust Reconciliation / Client Payment breakdown'],
    onConfirm: () => setForm((f) => ({ ...f, deposits: f.deposits.filter((_, idx) => idx !== i) })),
  });
  const VIA = ['EFT', 'CHEQUE', 'WIRE', 'BANK TRANSFER'];
  // preconstruction per-term helpers
  const setTA = (k: number, patch: Partial<FormTermAdmin>) => setForm((f) => ({ ...f, term_admin: { ...f.term_admin, [k]: { ...f.term_admin[k], ...patch } } }));
  const setTAgentField = (k: number, n: string, patch: Partial<FormAgent>) => setForm((f) => { const t = f.term_admin[k]; return { ...f, term_admin: { ...f.term_admin, [k]: { ...t, agents: { ...t.agents, [n]: { ...t.agents[n], ...patch } } } } }; });
  const addTRow = (k: number, n: string, key: 'payments' | 'cta', row: AgentPayment) => setForm((f) => { const t = f.term_admin[k]; const ag = t.agents[n]; return { ...f, term_admin: { ...f.term_admin, [k]: { ...t, agents: { ...t.agents, [n]: { ...ag, [key]: [...ag[key], row] } } } } }; });
  const setTRow = (k: number, n: string, key: 'payments' | 'cta', i: number, patch: Partial<AgentPayment>) => setForm((f) => { const t = f.term_admin[k]; const ag = t.agents[n]; return { ...f, term_admin: { ...f.term_admin, [k]: { ...t, agents: { ...t.agents, [n]: { ...ag, [key]: ag[key].map((r, idx) => idx === i ? { ...r, ...patch } : r) } } } } }; });
  const rmTRow = (k: number, n: string, key: 'payments' | 'cta', i: number) => askDelete({
    title: `Delete ${key === 'cta' ? 'CTA transfer' : 'payment'}?`,
    message: `Remove this entry from Term ${k}? It applies when you Save.`,
    linked: PAY_LINKED,
    onConfirm: () => setForm((f) => { const t = f.term_admin[k]; const ag = t.agents[n]; return { ...f, term_admin: { ...f.term_admin, [k]: { ...t, agents: { ...t.agents, [n]: { ...ag, [key]: ag[key].filter((_, idx) => idx !== i) } } } } }; }),
  });

  const onPayDate = (n: string, i: number, date: string) => setRow(n, 'payments', i, { paid_date: date, batch_no: batchNo(date), t4a_year: t4aYear(date) });
  const onCtaDate = (n: string, i: number, date: string) => setRow(n, 'cta', i, { date, batch_no: batchNo(date) });

  const save = async () => {
    setSaving(true);
    // Persist the auto-derived Paid Status; for fully-covered agents also reset paid type/date to N/A.
    const payload = { ...form, agents: { ...(form.agents || {}) } };
    Object.keys(payload.agents).forEach((n) => {
      const ag = payload.agents[n];
      if (!ag?.payments) return;
      const zero = netZeroAgent(n);
      payload.agents[n] = { ...ag, payments: ag.payments.map((p) => zero
        ? { ...p, paid_type: 'N/A', paid_date: '', batch_no: '', paid_status: 'N/A' }
        : { ...p, paid_status: paidStatusOf(n, p) }) };
    });
    try {
      const updated = await updateTransaction(transactionId, { admin_activities: payload });
      onSaved?.(updated);
      setSavedOk(true);
      setTimeout(() => { setSavedOk(false); onClose(); }, 2000);
    } catch (e) { toast(apiErrorMessage(e, 'Could not save'), 'bad'); setSaving(false); }
  };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal lg">
        <button className="close" onClick={onClose}><Icon name="close" size={15} /></button>
        <div className="modal-h">Admin Activities</div>

        {dftNA && (
          <div className="card" style={{ borderLeft: '4px solid var(--bad)', background: 'var(--warn-bg)', marginBottom: 12 }}>
            <strong style={{ color: 'var(--warn-ink-alt)' }}><Icon name="lock" size={13} /> DFT — Deal Fell Through.</strong>{' '}
            <span style={{ fontSize: 12.5, color: 'var(--warn-ink-deep)' }}>All statuses default to N/A and are locked.</span>
          </div>
        )}
        {readOnly && !dftNA && (
          <div className="card" style={{ borderLeft: '4px solid #2563eb', background: 'var(--info-bg)', marginBottom: 12 }}>
            <span style={{ fontSize: 12.5, color: 'var(--info-ink)' }}><Icon name="lock" size={13} /> View-only — click <strong>Edit</strong> on the transaction to make changes.</span>
          </div>
        )}

        <fieldset disabled={dftNA || readOnly} style={{ border: 0, margin: 0, padding: 0, minInlineSize: 0 }}>

        {precon && (<>
          <div className="field" style={{ maxWidth: 280 }}><label style={lbl}>Details of Terms — Show</label>
            <select value={termFilter} onChange={(e) => setTermFilter(e.target.value)}>
              <option value="All">All Terms</option>
              {termsArr.map((k) => <option key={k} value={k}>Term {k}</option>)}
            </select></div>
          {termCount === 0 && <div className="help">Set "Commission Receivable in Terms" in Preconstruction Details first.</div>}
          {termsArr.filter((k) => termFilter === 'All' || String(termFilter) === String(k)).map((k) => {
            const t = form.term_admin[k]; const visible = visibleAt(k);
            const ia = invByTerm[k] || {}; // §12.4 auto fields for this term's invoice
            return (
              <div className="card" key={k} style={{ marginBottom: 14 }}>
                <div className="modal-sub" style={{ marginTop: 0 }}>Term {k} — Invoice &amp; Commission Details</div>
                <div className="help" style={{ marginTop: -4, marginBottom: 8 }}>Auto-filled from the linked term invoice — read-only.</div>
                <div className="g4">
                  {/* TD-048 — "Invoice Status" is the invoice's own word, the same one the invoice
                      list shows; whether it has gone out is a separate field with its own label. */}
                  <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Invoice Status</label><input value={ia.invoice_status || '—'} readOnly style={{ background: 'var(--surface-2)' }} /></div>
                  <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Invoice Sent</label><input value={ia.invoice_sent_status || '—'} readOnly style={{ background: 'var(--surface-2)' }} /></div>
                  <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Invoice Number</label><input value={ia.invoice_number || '—'} readOnly style={{ background: 'var(--surface-2)' }} /></div>
                  <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Commission Received Date</label><input value={ia.commission_received_date || '—'} readOnly style={{ background: 'var(--surface-2)' }} /></div>
                  <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Commission Received Via</label><input value={ia.commission_received_via || '—'} readOnly style={{ background: 'var(--surface-2)' }} /></div>
                </div>

                <div className="modal-sub modal-sub-ok">Term {k} — Agent Commission Paid</div>
                {visible.length === 0 && <div className="help">No agents scoped to Term {k}.</div>}
                {visible.map((n) => {
                  const ag = t.agents[n] || { invoice_received: 'N/A', payments: [], cta: [] };
                  return (
                    <div className="pay-item" key={n} style={{ background: 'var(--ok-bg)', border: '1px solid #bbf7d0' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 10 }}>
                        <strong style={{ color: 'var(--ok-ink)' }}>{n.toUpperCase()}</strong>
                        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                          <label style={{ fontSize: 12, color: 'var(--ok-ink)', margin: 0, fontWeight: 600 }}>Agent Invoice Received</label>
                          <select style={{ width: 'auto' }} value={na(ag.invoice_received)} onChange={(e) => setTAgentField(k, n, { invoice_received: e.target.value })}><option>N/A</option><option>Yes</option><option>No</option></select>
                          <button className="btn btn-blue sm" onClick={() => addTRow(k, n, 'payments', { paid_type: 'N/A', paid_date: '', batch_no: '', t4a_year: '' })}>+ Add Payment</button>
                        </div>
                      </div>
                      {ag.payments.map((p, i) => (
                        <div className="g4" key={i} style={{ alignItems: 'end', marginBottom: 6 }}>
                          <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Paid Type</label><select value={na(p.paid_type)} onChange={(e) => setTRow(k, n, 'payments', i, { paid_type: e.target.value })}><option>N/A</option><option>TDB-EFT</option><option>CTA-BA Transfer</option><option>Cheque</option></select></div>
                          <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Paid Date</label><input type="date" value={p.paid_date} onChange={(e) => setTRow(k, n, 'payments', i, { paid_date: e.target.value, batch_no: batchNo(e.target.value), t4a_year: t4aYear(e.target.value) })} /></div>
                          <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Batch No.</label><input value={p.batch_no} readOnly style={{ background: 'var(--surface-2)' }} /></div>
                          <div style={{ display: 'flex', gap: 6, alignItems: 'end' }}><div className="field" style={{ marginBottom: 0, flex: 1 }}><label style={lbl}>T4A Year</label><input value={p.t4a_year} readOnly style={{ background: 'var(--surface-2)' }} /></div><button className="row-rm" onClick={() => rmTRow(k, n, 'payments', i)}><Icon name="trash" size={13} /></button></div>
                        </div>
                      ))}
                    </div>
                  );
                })}

                <div className="modal-sub" style={{ color: 'var(--brand)' }}>Term {k} — CTA to BA</div>
                {visible.map((n) => {
                  const ag = t.agents[n] || { invoice_received: 'N/A', payments: [], cta: [] };
                  return (
                    <div className="xfer-item" key={n}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                        <strong style={{ color: 'var(--brand)' }}>{n.toUpperCase()}</strong>
                        <button className="btn btn-blue sm" onClick={() => addTRow(k, n, 'cta', { cta: 'No', date: '', batch_no: '' })}>+ Add Transfer</button>
                      </div>
                      {ag.cta.map((c, i) => (
                        <div className="g3" key={i} style={{ alignItems: 'end', marginBottom: 6 }}>
                          <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>CTA to BA</label><select value={na(c.cta)} onChange={(e) => setTRow(k, n, 'cta', i, { cta: e.target.value })}><option>No</option><option>Yes</option><option>N/A</option></select></div>
                          <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Date</label><input type="date" value={c.date} onChange={(e) => setTRow(k, n, 'cta', i, { date: e.target.value, batch_no: batchNo(e.target.value) })} /></div>
                          <div style={{ display: 'flex', gap: 6, alignItems: 'end' }}><div className="field" style={{ marginBottom: 0, flex: 1 }}><label style={lbl}>Batch No.</label><input value={c.batch_no} readOnly style={{ background: 'var(--surface-2)' }} /></div><button className="row-rm" onClick={() => rmTRow(k, n, 'cta', i)}><Icon name="trash" size={13} /></button></div>
                        </div>
                      ))}
                    </div>
                  );
                })}

                <div className="modal-sub">Term {k} — Remarks</div>
                <textarea rows={2} value={t.remarks} onChange={(e) => setTA(k, { remarks: e.target.value })} placeholder={`Remarks for Term ${k}…`} />
              </div>
            );
          })}
        </>)}

        {!precon && (<>
        {!listing ? (<>
          <div className="modal-sub">Invoice &amp; Commission Details</div>
          <div className="help" style={{ marginTop: -4, marginBottom: 8 }}>Auto-filled from the linked invoice — read-only.</div>
          <div className="g2">
            {/* TD-048 — the invoice's own status, then the separate question of whether it was sent. */}
            <div className="field"><label style={lbl}>Invoice Status</label><input value={invAdmin.invoice_status || '—'} readOnly style={{ background: 'var(--surface-2)' }} /></div>
            <div className="field"><label style={lbl}>Invoice Number</label><input value={invAdmin.invoice_number || '—'} readOnly style={{ background: 'var(--surface-2)' }} /></div>
          </div>
          <div className="g2">
            <div className="field"><label style={lbl}>Invoice Sent</label><input value={invAdmin.invoice_sent_status || '—'} readOnly style={{ background: 'var(--surface-2)' }} /></div>
          </div>
          <div className="g2">
            <div className="field"><label style={lbl}>Commission Received Date</label><input value={invAdmin.commission_received_date || '—'} readOnly style={{ background: 'var(--surface-2)' }} /></div>
            <div className="field"><label style={lbl}>Commission Received Via</label><input value={invAdmin.commission_received_via || '—'} readOnly style={{ background: 'var(--surface-2)' }} /></div>
          </div>
        </>) : (<>
          {/* ---- Listing layout ---- */}
          <div className="modal-sub">Deposits</div>
          {form.deposits.map((d, i) => (
            <div className="dyn-list-box" key={i}>
              <div className="g4" style={{ alignItems: 'end' }}>
                <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Date</label><input type="date" value={d.date} onChange={(e) => setDeposit(i, { date: e.target.value })} /></div>
                <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Received Via</label><select value={d.received_via} onChange={(e) => setDeposit(i, { received_via: e.target.value })}><option value="">Select</option>{[...VIA, 'CASH'].map((v) => <option key={v}>{v}</option>)}</select></div>
                <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Receipt sent</label><select value={d.receipt_sent} onChange={(e) => setDeposit(i, { receipt_sent: e.target.value })}><option value="">Select</option><option>Yes</option><option>No</option></select></div>
                <div style={{ textAlign: 'right' }}><button className="row-rm" onClick={() => rmDeposit(i)}><Icon name="trash" size={13} /></button></div>
              </div>
            </div>
          ))}
          <button className="btn primary sm" onClick={addDeposit}>+ Add Deposit</button>

          {!depositOnly && (<>
          <div className="g2" style={{ marginTop: 14 }}>
            <div className="field"><label style={lbl}>Client Void cheque Received</label><select value={na(form.void_cheque_received)} onChange={(e) => set('void_cheque_received', e.target.value)}><option value="">Select</option><option>Yes</option><option>No</option><option>N/A</option></select></div>
            {!hideLawyer && <div className="field"><label style={lbl}>Lawyer statement sent</label><select value={form.lawyer_statement_sent} onChange={(e) => set('lawyer_statement_sent', e.target.value)}><option value="">Select</option><option>Yes</option><option>No</option></select></div>}
          </div>

          {!hideLawyer && (<>
            <div className="modal-sub">Received from Lawyer</div>
            <div className="field" style={{ maxWidth: 240 }}><label style={lbl}>Received from Lawyer?</label><select value={na(form.recv_lawyer.enabled)} onChange={(e) => setObj('recv_lawyer', { enabled: e.target.value })}><option value="">Select</option><option>Yes</option><option>No</option><option>N/A</option></select></div>
            {form.recv_lawyer.enabled === 'Yes' && (
              <div className="g2">
                <div className="field"><label style={lbl}>Received Via</label><select value={form.recv_lawyer.via} onChange={(e) => setObj('recv_lawyer', { via: e.target.value })}><option value="">Select</option>{VIA.map((v) => <option key={v}>{v}</option>)}</select></div>
                <div className="field"><label style={lbl}>Received Date</label><input type="date" value={form.recv_lawyer.date} onChange={(e) => setObj('recv_lawyer', { date: e.target.value })} /></div>
              </div>
            )}

            <div className="modal-sub">Paid to Lawyer</div>
            <div className="field" style={{ maxWidth: 240 }}><label style={lbl}>Paid to Lawyer?</label><select value={na(form.paid_lawyer.enabled)} onChange={(e) => setObj('paid_lawyer', { enabled: e.target.value })}><option value="">Select</option><option>Yes</option><option>No</option><option>N/A</option></select></div>
            {form.paid_lawyer.enabled === 'Yes' && (<>
              <div className="g4">
                <div className="field"><label style={lbl}>Paid Status</label><select value={form.paid_lawyer.paid_status || 'Pending'} onChange={(e) => setObj('paid_lawyer', { paid_status: e.target.value })}><option>Paid</option><option>Paid Partially</option><option>Pending</option></select></div>
                {form.paid_lawyer.paid_status === 'Paid Partially' && (
                  <div className="field"><label style={lbl}>Amount Paid</label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ color: 'var(--muted)' }}>$</span><MoneyInput value={form.paid_lawyer.amount} onChange={(v) => setObj('paid_lawyer', { amount: v })} placeholder="0.00" style={{ flex: 1 }} /></div>
                  </div>
                )}
                <div className="field"><label style={lbl}>Paid Via</label><select value={form.paid_lawyer.via} onChange={(e) => setObj('paid_lawyer', { via: e.target.value })}><option value="">Select</option>{VIA.map((v) => <option key={v}>{v}</option>)}</select></div>
                <div className="field"><label style={lbl}>Paid Date</label><input type="date" value={form.paid_lawyer.date} onChange={(e) => setObj('paid_lawyer', { date: e.target.value, batch: batchNo(e.target.value) })} /></div>
                <div className="field"><label style={lbl}>Batch No.</label><input value={form.paid_lawyer.batch} readOnly style={{ background: 'var(--surface-2)' }} /></div>
              </div>
              {form.paid_lawyer.paid_status === 'Paid Partially' && (<>
                {(form.paid_lawyer.payments || []).map((p, i) => (
                  <div className="g4" key={i} style={{ alignItems: 'end', marginTop: 6 }}>
                    <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Paid Status</label><select value={p.paid_status || 'Pending'} onChange={(e) => setPaidLawyerPayment(i, { paid_status: e.target.value })}><option>Paid</option><option>Paid Partially</option><option>Pending</option></select></div>
                    <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Amount Paid</label>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ color: 'var(--muted)' }}>$</span><MoneyInput value={p.amount} onChange={(v) => setPaidLawyerPayment(i, { amount: v })} placeholder="0.00" style={{ flex: 1 }} /></div>
                    </div>
                    <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Paid Via</label><select value={p.via} onChange={(e) => setPaidLawyerPayment(i, { via: e.target.value })}><option value="">Select</option>{VIA.map((v) => <option key={v}>{v}</option>)}</select></div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'end' }}><div className="field" style={{ marginBottom: 0, flex: 1 }}><label style={lbl}>Paid Date</label><input type="date" value={p.date} onChange={(e) => setPaidLawyerPayment(i, { date: e.target.value })} /></div><button className="row-rm" onClick={() => rmPaidLawyerPayment(i)}><Icon name="trash" size={13} /></button></div>
                  </div>
                ))}
                <button className="btn btn-blue sm" style={{ marginTop: 8 }} onClick={addPaidLawyerPayment}>+ Add Payment</button>
              </>)}
            </>)}
          </>)}

          <div className="modal-sub">Paid to Client</div>
          <div className="field" style={{ maxWidth: 240 }}><label style={lbl}>Paid to Client?</label>
            <select value={na(clientNA ? 'N/A' : form.paid_client.enabled)} disabled={clientNA} onChange={(e) => setObj('paid_client', { enabled: e.target.value })}><option value="">Select</option><option>Yes</option><option>No</option><option>N/A</option></select>
            {clientNA && <span className="help">Payable to Client is $0 — set to N/A automatically.</span>}</div>
          {!clientNA && form.paid_client.enabled === 'Yes' && (
            <div className="g3">
              <div className="field"><label style={lbl}>Paid Via</label><select value={form.paid_client.via} onChange={(e) => setObj('paid_client', { via: e.target.value })}><option value="">Select</option>{VIA.map((v) => <option key={v}>{v}</option>)}</select></div>
              <div className="field"><label style={lbl}>Paid Date</label><input type="date" value={form.paid_client.date} onChange={(e) => setObj('paid_client', { date: e.target.value, batch: batchNo(e.target.value) })} /></div>
              <div className="field"><label style={lbl}>Batch No.</label><input value={form.paid_client.batch} readOnly style={{ background: 'var(--surface-2)' }} /></div>
            </div>
          )}

          <div className="modal-sub">Co-op invoice received</div>
          <div className="field" style={{ maxWidth: 240 }}><label style={lbl}>Co-op invoice received?</label><select value={na(form.coop_invoice.enabled)} onChange={(e) => setObj('coop_invoice', { enabled: e.target.value })}><option value="">Select</option><option>Yes</option><option>No</option><option>N/A</option></select></div>
          {form.coop_invoice.enabled === 'Yes' && (
            <div className="g4">
              <div className="field"><label style={lbl}>Co-op Brokerage GST/HST No</label><input value={form.coop_invoice.gst_hst} onChange={(e) => setObj('coop_invoice', { gst_hst: e.target.value.toUpperCase() })} placeholder="e.g. 123456789 RT0001" /></div>
              <div className="field"><label style={lbl}>Paid Via</label><select value={form.coop_invoice.via} onChange={(e) => setObj('coop_invoice', { via: e.target.value })}><option value="">Select</option>{VIA.map((v) => <option key={v}>{v}</option>)}</select></div>
              <div className="field"><label style={lbl}>Paid Date</label><input type="date" value={form.coop_invoice.date} onChange={(e) => setObj('coop_invoice', { date: e.target.value, batch: batchNo(e.target.value) })} /></div>
              <div className="field"><label style={lbl}>Batch No.</label><input value={form.coop_invoice.batch} readOnly style={{ background: 'var(--surface-2)' }} /></div>
            </div>
          )}

          <div className="modal-sub" style={{ color: 'var(--brand)' }}>Transferred TA → CTA</div>
          <div className="field" style={{ maxWidth: 240 }}><label style={lbl}>Transferred TA → CTA?</label><select value={na(form.ta_cta.enabled)} onChange={(e) => setObj('ta_cta', { enabled: e.target.value })}><option value="">Select</option><option>Yes</option><option>No</option><option>N/A</option></select></div>
          {form.ta_cta.enabled === 'Yes' && (
            <div className="g2">
              <div className="field"><label style={lbl}>Transfer Date</label><input type="date" value={form.ta_cta.date} onChange={(e) => setObj('ta_cta', { date: e.target.value, batch: batchNo(e.target.value) })} /></div>
              <div className="field"><label style={lbl}>Batch No.</label><input value={form.ta_cta.batch} readOnly style={{ background: 'var(--surface-2)' }} /></div>
            </div>
          )}
          </>)}
        </>)}

        {!depositOnly && (<>
        <div className="modal-sub modal-sub-ok">Agent Commission Paid</div>
        {agentNames.length === 0 && <div className="help">No agents assigned — set the agent / Team Split first.</div>}
        {agentNames.map((n) => {
          const a = form.agents[n];
          return (
            <div className="pay-item" key={n} style={{ background: 'var(--ok-bg)', border: '1px solid #bbf7d0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 10 }}>
                <strong style={{ color: 'var(--ok-ink)' }}>{n.toUpperCase()}</strong>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <label style={{ fontSize: 12, color: 'var(--ok-ink)', margin: 0, fontWeight: 600 }}>Agent Invoice Received</label>
                  <select style={{ width: 'auto' }} value={na(a.invoice_received)} onChange={(e) => setAgent(n, 'invoice_received', e.target.value)}><option>N/A</option><option>Yes</option><option>No</option></select>
                  <button className="btn btn-blue sm" onClick={() => addRow(n, 'payments', { paid_type: 'N/A', paid_status: '', paid_date: '', batch_no: '', t4a_year: '' })}>+ Add Payment</button>
                </div>
              </div>
              {a.payments.map((p, i) => (
                <div className="g4" key={i} style={{ alignItems: 'end', marginBottom: 6, gridTemplateColumns: 'repeat(5, 1fr)' }}>
                  <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Paid Type</label>
                    <select value={na(p.paid_type)} onChange={(e) => setRow(n, 'payments', i, { paid_type: e.target.value })}><option>N/A</option><option>TDB-EFT</option><option>CTA-BA Transfer</option><option>Cheque</option></select></div>
                  <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Paid Status</label>
                    <input value={paidStatusOf(n, p) || '—'} readOnly style={{ background: 'var(--surface-2)', fontWeight: 600 }} title="Auto — Paid when Paid Type + Paid Date are set; N/A when the agent's commission is fully covered by advance/adjustments." /></div>
                  <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Paid Date</label><input type="date" value={p.paid_date} onChange={(e) => onPayDate(n, i, e.target.value)} /></div>
                  <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Batch No.</label><input value={p.batch_no} readOnly style={{ background: 'var(--surface-2)' }} /></div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'end' }}>
                    <div className="field" style={{ marginBottom: 0, flex: 1 }}><label style={lbl}>T4A Year</label><input value={p.t4a_year} readOnly style={{ background: 'var(--surface-2)' }} /></div>
                    <button className="row-rm" onClick={() => rmRow(n, 'payments', i)}><Icon name="trash" size={13} /></button>
                  </div>
                </div>
              ))}
            </div>
          );
        })}

        <div className="modal-sub" style={{ color: 'var(--brand)' }}>CTA to BA</div>
        {agentNames.map((n) => {
          const a = form.agents[n];
          return (
            <div className="xfer-item" key={n}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <strong style={{ color: 'var(--brand)' }}>{n.toUpperCase()}</strong>
                <button className="btn btn-blue sm" onClick={() => addRow(n, 'cta', { cta: 'No', date: '', batch_no: '' })}>+ Add Transfer</button>
              </div>
              {a.cta.map((c, i) => (
                <div className="g3" key={i} style={{ alignItems: 'end', marginBottom: 6 }}>
                  <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>CTA to BA</label>
                    <select value={na(c.cta)} onChange={(e) => setRow(n, 'cta', i, { cta: e.target.value })}><option>No</option><option>Yes</option><option>N/A</option></select></div>
                  <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Date</label><input type="date" value={c.date} onChange={(e) => onCtaDate(n, i, e.target.value)} /></div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'end' }}>
                    <div className="field" style={{ marginBottom: 0, flex: 1 }}><label style={lbl}>Batch No.</label><input value={c.batch_no} readOnly style={{ background: 'var(--surface-2)' }} /></div>
                    <button className="row-rm" onClick={() => rmRow(n, 'cta', i)}><Icon name="trash" size={13} /></button>
                  </div>
                </div>
              ))}
            </div>
          );
        })}

        <div className="modal-sub">Remarks</div>
        {form.notes.map((note, i) => (
          <div className="note-item" key={i}>
            <textarea rows={2} value={note.text} onChange={(e) => set('notes', form.notes.map((x, idx) => idx === i ? { ...x, text: e.target.value } : x))} placeholder="Enter note…" style={{ marginBottom: 6 }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--muted)' }}><span>{noteStamp(note)} — {noteAuthor(note)}</span><button className="row-rm" onClick={() => rmNote(i)}><Icon name="trash" size={13} /></button></div>
          </div>
        ))}
        <div style={{ textAlign: 'right', marginBottom: 10 }}>
          <button className="btn primary sm" onClick={() => { const now = new Date().toISOString(); set('notes', [...form.notes, { text: '', date: now.slice(0, 10), created_at: now, author: user?.name || '', role: isSuperAdmin ? 'Super Admin' : 'Admin' }]); }}>+ Add Note</button>
        </div>
        </>)}
        </>)}

        </fieldset>

        <SavedBadge show={savedOk} />

        <div className="actions">
          <button className="btn ghost" onClick={onClose}>Close</button>
          {!readOnly && <button className="btn primary" onClick={save} disabled={saving || dftNA || savedOk}>{savedOk ? <><Icon name="check" size={13} /> Saved</> : (saving ? 'Saving…' : 'Save')}</button>}
        </div>
      </div>
      <ConfirmDialog confirm={confirm} onClose={closeConfirm} />
    </div>
  );
}
