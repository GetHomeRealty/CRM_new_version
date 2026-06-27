import { useState, useEffect } from 'react';
import { updateTransaction } from '../lib/api';
import { batchNo, parseNumber, formatCurrency, isPreconType } from './format';
import { useToast } from './toast';

const lbl = { fontSize: 11.5, color: 'var(--text-2)', fontWeight: 600, marginBottom: 5, display: 'block' };

// Amount input with a +/− sign toggle. "−" deducts from the agent commission
// (stored positive — the commission math subtracts it); "+" adds it back (stored
// negative). Default "−" (deduct).
function SignedAmount({ value, onChange }) {
  const [sign, setSign] = useState(parseNumber(value) < 0 ? '+' : '-');
  const [mag, setMag] = useState(() => { const n = parseNumber(value); return n === 0 ? '' : String(Math.abs(n)); });
  useEffect(() => {
    const n = parseNumber(value);
    if (Math.abs(n) !== Math.abs(parseNumber(mag))) setMag(n === 0 ? '' : String(Math.abs(n)));
    if (n !== 0) setSign(n < 0 ? '+' : '-');
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const stored = (s, m) => { const mm = Math.abs(parseNumber(m)); return s === '-' ? mm : -mm; };
  const pick = (s) => { setSign(s); onChange(stored(s, mag)); };
  const onMag = (m) => { setMag(m); onChange(stored(sign, m)); };
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <div className="seg-toggle" style={{ flex: '0 0 auto' }}>
        <button type="button" className={`seg-btn ${sign === '+' ? 'active' : ''}`} onClick={() => pick('+')} title="Add to agent commission">+</button>
        <button type="button" className={`seg-btn ${sign === '-' ? 'active' : ''}`} onClick={() => pick('-')} title="Deduct from agent commission">−</button>
      </div>
      <input value={mag} onChange={(e) => onMag(e.target.value)} placeholder="0.00" style={{ flex: 1 }} />
    </div>
  );
}

export default function AdjustmentModal({ open, onClose, transactionId, txn, onSaved, termCount: termCountProp }) {
  const toast = useToast();
  const precon = isPreconType(txn.type);
  const termCount = (typeof termCountProp === 'number' ? termCountProp : (parseInt(txn.precon_term_count, 10) || 0));
  const termOptions = Array.from({ length: termCount }, (_, k) => k + 1);
  const agentNames = (txn.team && txn.team.length ? txn.team.map((t) => t.name) : (txn.agent ? [txn.agent] : [])).filter(Boolean);
  const termSelect = (val, onCh) => (
    <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Term</label>
      <select value={val || ''} onChange={onCh}><option value="">Select term</option>{termOptions.map((t) => <option key={t} value={t}>Term {t}</option>)}</select></div>
  );

  const [form, setForm] = useState(() => {
    const a = txn.adjustments || {};
    return {
      agent_adjust: a.agent_adjust || 'No', adjustment_rows: a.adjustment_rows || [],
      advance_payment: a.advance_payment || 'No', advance_rows: a.advance_rows || [],
      client_referral: a.client_referral || 'No', client_rows: a.client_rows || [],
      ext_referral: a.ext_referral || 'No', ext: a.ext || { agent_name: '', brokerage: '', amount: '', invoice_received: 'No', hst_no: '', paid_type: 'N/A', paid_date: '', batch_no: '', paid_status: '' },
    };
  });
  const [saving, setSaving] = useState(false);
  if (!open) return null;

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setRow = (key, i, patch) => setForm((f) => ({ ...f, [key]: f[key].map((r, idx) => idx === i ? { ...r, ...patch } : r) }));
  const addRow = (key, row) => setForm((f) => ({ ...f, [key]: [...f[key], row] }));
  const rmRow = (key, i) => setForm((f) => ({ ...f, [key]: f[key].filter((_, idx) => idx !== i) }));
  const setExt = (patch) => setForm((f) => ({ ...f, ext: { ...f.ext, ...patch } }));

  const extAmt = parseNumber(form.ext.amount);
  const extHst = Math.round(extAmt * 0.13 * 100) / 100;
  const extTotal = Math.round((extAmt + extHst) * 100) / 100;

  const save = async () => {
    setSaving(true);
    try {
      const updated = await updateTransaction(transactionId, { adjustments: form });
      toast('Adjustment saved', 'ok'); onSaved?.(updated); onClose();
    } catch (e) { toast(e.response?.data?.message || 'Could not save', 'bad'); } finally { setSaving(false); }
  };

  const agentSelect = (val, onCh) => (
    <select value={val} onChange={onCh}><option value="">Select agent</option>{agentNames.map((n) => <option key={n} value={n}>{n}</option>)}</select>
  );

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal lg">
        <button className="close" onClick={onClose}>✕</button>
        <div className="modal-h">Adjustment &amp; Advance Payment</div>

        {/* Adjustment Details */}
        <div className="modal-sub">Adjustment Details</div>
        <div className="field" style={{ maxWidth: 220 }}><label style={lbl}>Agent Adjust</label>
          <select value={form.agent_adjust} onChange={(e) => set('agent_adjust', e.target.value)}><option>No</option><option>Yes</option></select></div>
        {form.agent_adjust === 'Yes' && (<>
          {form.adjustment_rows.map((r, i) => (
            <div className="dyn-list-box" key={i}>
              <div style={{ display: 'grid', gridTemplateColumns: precon ? 'repeat(4,1fr)' : 'repeat(3,1fr)', gap: 14 }}>
                <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Agent Name</label>{agentSelect(r.agent, (e) => setRow('adjustment_rows', i, { agent: e.target.value }))}</div>
                <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Amount</label><SignedAmount value={r.amount} onChange={(nv) => setRow('adjustment_rows', i, { amount: nv })} /></div>
                <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Status</label><select value={r.status} onChange={(e) => setRow('adjustment_rows', i, { status: e.target.value })}><option value="">Select status</option><option>Yet to Adjust</option><option>Closed</option></select></div>
                {precon && termSelect(r.term, (e) => setRow('adjustment_rows', i, { term: e.target.value }))}
              </div>
              <div className="field" style={{ marginTop: 10, marginBottom: 0 }}><label style={lbl}>Remarks</label><textarea rows={1} value={r.remarks} onChange={(e) => setRow('adjustment_rows', i, { remarks: e.target.value })} /></div>
              <div style={{ textAlign: 'right', marginTop: 6 }}><button className="row-rm" onClick={() => rmRow('adjustment_rows', i)}>🗑️</button></div>
            </div>
          ))}
          <button className="btn primary sm" onClick={() => addRow('adjustment_rows', { agent: '', amount: '', status: '', remarks: '' })}>+ Add New</button>
        </>)}

        {/* Advance Payment */}
        <div className="modal-sub">Advance Payment Details</div>
        <div className="field" style={{ maxWidth: 220 }}><label style={lbl}>Advance Payment</label>
          <select value={form.advance_payment} onChange={(e) => set('advance_payment', e.target.value)}><option>No</option><option>Yes</option></select></div>
        {form.advance_payment === 'Yes' && (<>
          {form.advance_rows.map((r, i) => (
            <div className="dyn-list-box" key={i}>
              <div style={{ display: 'grid', gridTemplateColumns: precon ? 'repeat(5,1fr)' : 'repeat(4,1fr)', gap: 14 }}>
                <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Agent Name</label>{agentSelect(r.agent, (e) => setRow('advance_rows', i, { agent: e.target.value }))}</div>
                <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Amount</label><input value={r.amount} onChange={(e) => setRow('advance_rows', i, { amount: e.target.value })} placeholder="0.00" /></div>
                <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Paid Date</label><input type="date" value={r.paid_date} onChange={(e) => setRow('advance_rows', i, { paid_date: e.target.value, batch_no: batchNo(e.target.value) })} /></div>
                <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Batch No.</label><input value={r.batch_no} readOnly style={{ background: '#f9fafb' }} /></div>
                {precon && termSelect(r.term, (e) => setRow('advance_rows', i, { term: e.target.value }))}
              </div>
              <div className="field" style={{ marginTop: 10, marginBottom: 0 }}><label style={lbl}>Remarks</label><textarea rows={1} value={r.remarks} onChange={(e) => setRow('advance_rows', i, { remarks: e.target.value })} /></div>
              <div style={{ textAlign: 'right', marginTop: 6 }}><button className="row-rm" onClick={() => rmRow('advance_rows', i)}>🗑️</button></div>
            </div>
          ))}
          <button className="btn primary sm" onClick={() => addRow('advance_rows', { agent: '', amount: '', paid_date: '', batch_no: '', remarks: '' })}>+ Add New</button>
        </>)}

        {/* Client Referral */}
        <div className="modal-sub">Client Referral</div>
        <div className="field" style={{ maxWidth: 220 }}><label style={lbl}>Client Referral</label>
          <select value={form.client_referral} onChange={(e) => { const v = e.target.value; set('client_referral', v); if (v === 'Yes' && form.client_rows.length === 0) addRow('client_rows', { client_name: '', amount: '', void_cheque: 'No', paid_type: 'N/A', paid_date: '', batch_no: '', paid_status: '' }); }}><option>No</option><option>Yes</option></select></div>
        {form.client_referral === 'Yes' && (<>
          {form.client_rows.map((r, i) => (
            <div className="dyn-list-box" key={i}>
              <div className="g3">
                <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Client Name</label><input value={r.client_name} onChange={(e) => setRow('client_rows', i, { client_name: e.target.value })} /></div>
                <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Referral Amount (CAD)</label><input value={r.amount} onChange={(e) => setRow('client_rows', i, { amount: e.target.value })} placeholder="0.00" /></div>
                <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Void Cheque Received</label><select value={r.void_cheque} onChange={(e) => setRow('client_rows', i, { void_cheque: e.target.value })}><option>No</option><option>Yes</option></select></div>
              </div>
              {r.void_cheque === 'Yes' && (
                <div className="g4" style={{ marginTop: 10 }}>
                  <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Paid Type</label><select value={r.paid_type} onChange={(e) => setRow('client_rows', i, { paid_type: e.target.value })}><option>N/A</option><option>TDB-EFT</option><option>Cheque</option><option>Wire</option></select></div>
                  <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Paid Date</label><input type="date" value={r.paid_date} onChange={(e) => setRow('client_rows', i, { paid_date: e.target.value, batch_no: batchNo(e.target.value), paid_status: e.target.value ? 'Paid' : '' })} /></div>
                  <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Batch No.</label><input value={r.batch_no} readOnly style={{ background: '#f9fafb' }} /></div>
                  <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Paid Status</label><input value={r.paid_status} readOnly style={{ background: '#f9fafb' }} /></div>
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
          <select value={form.ext_referral} onChange={(e) => set('ext_referral', e.target.value)}><option>No</option><option>Yes</option></select></div>
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
              <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Amount</label><input value={form.ext.amount} onChange={(e) => setExt({ amount: e.target.value, pct: '' })} placeholder="0.00" /></div>
              <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>HST</label><input value={formatCurrency(extHst)} readOnly style={{ background: '#f9fafb' }} /></div>
              <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Total</label><input value={formatCurrency(extTotal)} readOnly style={{ background: '#f9fafb' }} /></div>
            </div>
            <div className="g2" style={{ marginTop: 10 }}>
              <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Referral Agent Invoice Received?</label><select value={form.ext.invoice_received} onChange={(e) => setExt({ invoice_received: e.target.value })}><option>No</option><option>Yes</option></select></div>
              {form.ext.invoice_received === 'Yes' && <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Brokerage HST No.</label><input value={form.ext.hst_no} onChange={(e) => setExt({ hst_no: e.target.value })} placeholder="e.g. 123456789 RT0001" /></div>}
            </div>
            {form.ext.invoice_received === 'Yes' && (
              <div className="g4" style={{ marginTop: 10 }}>
                <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Paid Type</label><select value={form.ext.paid_type} onChange={(e) => setExt({ paid_type: e.target.value })}><option>N/A</option><option>TDB-EFT</option><option>Cheque</option><option>Wire</option></select></div>
                <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Paid Date</label><input type="date" value={form.ext.paid_date} onChange={(e) => setExt({ paid_date: e.target.value, batch_no: batchNo(e.target.value), paid_status: e.target.value ? 'Paid' : '' })} /></div>
                <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Batch No.</label><input value={form.ext.batch_no} readOnly style={{ background: '#f9fafb' }} /></div>
                <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Paid Status</label><input value={form.ext.paid_status} readOnly style={{ background: '#f9fafb' }} /></div>
              </div>
            )}
          </div>
        )}

        <div className="actions">
          <button className="btn ghost" onClick={onClose}>Close</button>
          <button className="btn primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
