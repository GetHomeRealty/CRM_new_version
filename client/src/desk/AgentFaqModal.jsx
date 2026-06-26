import { useState } from 'react';
import { updateTransaction } from '../lib/api';
import { isListingType, isPreconType } from './format';
import { useToast } from './toast';

const lbl = { fontSize: 11.5, color: 'var(--text-2)', fontWeight: 600, marginBottom: 5, display: 'block' };

export default function AgentFaqModal({ open, onClose, transactionId, txn, onSaved, termCount: termCountProp }) {
  const toast = useToast();
  const listing = isListingType(txn.type);
  const precon = isPreconType(txn.type);
  const referral = txn.type === 'Referral';
  const team = (txn.team && txn.team.length ? txn.team : (txn.agent ? [{ name: txn.agent }] : [])).filter((t) => t && t.name);
  const agentNames = team.map((t) => t.name);
  const termCount = precon ? (typeof termCountProp === 'number' ? termCountProp : (parseInt(txn.precon_term_count, 10) || 0)) : 0;
  const termsArr = Array.from({ length: termCount }, (_, i) => i + 1);
  const visibleAt = (k) => team.filter((m) => (m.scope || 'Entire') === 'Entire' || (m.terms || []).map(Number).includes(k)).map((m) => m.name).filter(Boolean);

  const [form, setForm] = useState(() => {
    const a = txn.activity_tracker || {};
    const perAgent = {};
    agentNames.forEach((n) => { perAgent[n] = (a.per_agent_paid && a.per_agent_paid[n]) || ''; });
    const termTracker = {};
    if (precon) {
      const prev = a.term_tracker || {};
      termsArr.forEach((k) => {
        const pt = prev[k] || {};
        const pa = {};
        visibleAt(k).forEach((n) => { pa[n] = (pt.per_agent_paid && pt.per_agent_paid[n]) || ''; });
        termTracker[k] = {
          invoice_sent: pt.invoice_sent || '',
          invoice_number: pt.invoice_number || '',
          commission_received_date: pt.commission_received_date || '',
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
      batch_review_email: !!a.batch_review_email,
      commission_received_date: a.commission_received_date || txn.admin_activities?.commission_received_date || '',
      docs_cleared: a.docs_cleared || '',
      final_validation: a.final_validation || '',
      final_validation_remarks: a.final_validation_remarks || '',
      ready_to_process: a.ready_to_process || '',
      agent_commission_paid_status: a.agent_commission_paid_status || '',
      client_payment_paid: a.client_payment_paid || '',
      per_agent_paid: perAgent,
      term_tracker: termTracker,
    };
  });
  const [termFilter, setTermFilter] = useState('All');
  const [saving, setSaving] = useState(false);
  if (!open) return null;

  const set = (k, v) => setForm((f) => {
    const next = { ...f, [k]: v };
    if (k === 'docs_cleared' && v === 'Yes' && f.final_validation !== 'Done') next.final_validation = 'Pending';
    return next;
  });
  const setAgentPaid = (n, v) => setForm((f) => ({ ...f, per_agent_paid: { ...f.per_agent_paid, [n]: v } }));
  const setTT = (k, patch) => setForm((f) => {
    const cur = f.term_tracker[k] || {};
    const next = { ...cur, ...patch };
    if (patch.docs_cleared === 'Yes' && cur.final_validation !== 'Done') next.final_validation = 'Pending';
    return { ...f, term_tracker: { ...f.term_tracker, [k]: next } };
  });
  const setTTAgentPaid = (k, n, v) => setForm((f) => {
    const cur = f.term_tracker[k] || {};
    return { ...f, term_tracker: { ...f.term_tracker, [k]: { ...cur, per_agent_paid: { ...(cur.per_agent_paid || {}), [n]: v } } } };
  });

  const save = async () => {
    setSaving(true);
    try {
      const updated = await updateTransaction(transactionId, { activity_tracker: form });
      toast('Agent FAQ saved', 'ok'); onSaved?.(updated); onClose();
    } catch (e) { toast(e.response?.data?.message || 'Could not save', 'bad'); } finally { setSaving(false); }
  };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal xl">
        <button className="close" onClick={onClose}>✕</button>
        <div className="modal-h">Agent FAQ Center</div>

        {!referral && (
        <div style={{ background: '#f9fafb', border: '1px solid var(--line)', borderRadius: 8, padding: 12, marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Send client review email (batch)</div>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <input type="checkbox" checked={form.batch_review_email} onChange={(e) => set('batch_review_email', e.target.checked)} /> Include this transaction in batch review emails
          </label>
        </div>
        )}

        {precon && (<>
          <div className="field" style={{ maxWidth: 280 }}><label style={lbl}>Details of Terms — Show</label>
            <select value={termFilter} onChange={(e) => setTermFilter(e.target.value)}>
              <option value="All">All Terms</option>
              {termsArr.map((k) => <option key={k} value={k}>Term {k}</option>)}
            </select></div>
          {termCount === 0 && <div className="help">Set "Commission Receivable in Terms" in Preconstruction Details first.</div>}
          {termsArr.filter((k) => termFilter === 'All' || String(termFilter) === String(k)).map((k) => {
            const t = form.term_tracker[k] || {}; const visible = visibleAt(k);
            return (
              <div className="card" key={k} style={{ marginBottom: 14 }}>
                <div className="modal-sub" style={{ marginTop: 0 }}>Term {k} — Validation</div>
                <div className="g3">
                  <div className="field"><label style={lbl}>Invoice Sent</label><select value={t.invoice_sent} onChange={(e) => setTT(k, { invoice_sent: e.target.value })}><option value="">Select</option><option>Yes</option><option>No</option><option>N/A</option></select></div>
                  <div className="field"><label style={lbl}>Invoice Number</label><input value={t.invoice_number} onChange={(e) => setTT(k, { invoice_number: e.target.value })} placeholder="INV-####" /></div>
                  <div className="field"><label style={lbl}>Commission Received Date</label><input type="date" value={t.commission_received_date} onChange={(e) => setTT(k, { commission_received_date: e.target.value })} /><span className="help">Managed from Admin Activities.</span></div>
                </div>
                <div className="g3">
                  <div className="field"><label style={lbl}>Valid Docs Cleared from Agent</label><select value={t.docs_cleared} onChange={(e) => setTT(k, { docs_cleared: e.target.value })}><option value="">Select</option><option>Yes</option><option>No</option></select></div>
                  <div className="field"><label style={lbl}>Final Validation</label><select value={t.final_validation} onChange={(e) => setTT(k, { final_validation: e.target.value })}><option value="">Select</option><option>Done</option><option>Pending</option><option>Invalid</option></select><span className="help">Auto-set to Pending when docs cleared = Yes.</span></div>
                  <div className="field"><label style={lbl}>Ready to Process This Week</label><select value={t.ready_to_process} onChange={(e) => setTT(k, { ready_to_process: e.target.value })}><option value="">Select</option><option>Yes</option><option>No</option><option>N/A</option></select></div>
                </div>
                <div className="field" style={{ marginTop: 8 }}><label style={lbl}>Remarks</label><textarea rows={2} value={t.remarks} onChange={(e) => setTT(k, { remarks: e.target.value })} placeholder={`Remarks for Term ${k}…`} /></div>
              </div>
            );
          })}
        </>)}

        {!precon && (<>
        <div className="g3">
          <div className="field"><label style={lbl}>Commission Received Date</label><input type="date" value={form.commission_received_date} onChange={(e) => set('commission_received_date', e.target.value)} /><span className="help">Managed from Admin Activities.</span></div>
          <div className="field"><label style={lbl}>Valid Docs Cleared from Agent</label>
            <select value={form.docs_cleared} onChange={(e) => set('docs_cleared', e.target.value)}><option value="">Select</option><option>Yes</option><option>No</option></select></div>
          <div className="field"><label style={lbl}>Final Validation</label>
            <select value={form.final_validation} onChange={(e) => set('final_validation', e.target.value)}><option value="">Select</option><option>Done</option><option>Pending</option><option>Invalid</option></select>
            <span className="help">Auto-set to Pending when docs cleared = Yes.</span></div>
        </div>
        <div className="g2">
          <div className="field"><label style={lbl}>Ready to Process Agent Payment This Week</label>
            <select value={form.ready_to_process} onChange={(e) => set('ready_to_process', e.target.value)}><option value="">Select</option><option>Yes</option><option>No</option><option>N/A</option></select></div>
          <div className="field"><label style={lbl}>Agent Commission Paid Status</label>
            <select value={form.agent_commission_paid_status} onChange={(e) => set('agent_commission_paid_status', e.target.value)}><option value="">Select</option><option>Yes</option><option>No</option><option>N/A</option></select></div>
          {listing && (
            <div className="field"><label style={lbl}>Client Payment Paid</label>
              <select value={form.client_payment_paid} onChange={(e) => set('client_payment_paid', e.target.value)}><option value="">Select</option><option>Yes</option><option>No</option><option>N/A</option></select></div>
          )}
        </div>
        {form.final_validation === 'Invalid' && (
          <div className="field"><label style={lbl}>Final Validation Remarks</label><textarea rows={3} value={form.final_validation_remarks} onChange={(e) => set('final_validation_remarks', e.target.value)} placeholder="Reason for invalid validation…" /></div>
        )}

        </>)}

        <div className="actions">
          <button className="btn ghost" onClick={onClose}>Close</button>
          <button className="btn primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
