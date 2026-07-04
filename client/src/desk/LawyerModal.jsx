import { useEffect, useState } from 'react';
import { updateTransaction, getLawyerSuggestions } from '../lib/api';
import { useToast } from './toast';
import SavedBadge from './SavedBadge';
import AutoComplete from './AutoComplete';

export default function LawyerModal({ open, onClose, transactionId, txn, onSaved, readOnly = false, isAgent = false }) {
  const toast = useToast();
  const [form, setForm] = useState({
    lawyer_name: txn.lawyer_name || '',
    lawyer_email: txn.lawyer_email || '',
    lawyer_phone: txn.lawyer_phone || '',
    lawyer_address: txn.lawyer_address || '',
  });
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false); // §3.2 — "Saved" then auto-close
  const [suggestions, setSuggestions] = useState([]);
  useEffect(() => { if (open) getLawyerSuggestions().then(setSuggestions).catch(() => {}); }, [open]);
  if (!open) return null;

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const pickLawyer = (s) => setForm((f) => ({
    ...f,
    lawyer_name: s.name || '',
    lawyer_email: s.email || f.lawyer_email,
    lawyer_phone: s.phone || f.lawyer_phone,
    lawyer_address: s.address || f.lawyer_address,
  }));

  const save = async () => {
    // All Lawyer Details fields are mandatory.
    if (!form.lawyer_name.trim() || !form.lawyer_address.trim() || !form.lawyer_email.trim() || !form.lawyer_phone.trim()) {
      window.alert('Please fill all the mandatory fields (Lawyer Name, Address, Email, Phone) and save.');
      return;
    }
    setSaving(true);
    try {
      const updated = await updateTransaction(transactionId, form);
      onSaved?.(updated);
      setSavedOk(true);
      setTimeout(() => { setSavedOk(false); onClose(); }, 2000);
    } catch (e) {
      toast(e.response?.data?.message || 'Could not save', 'bad');
      setSaving(false);
    }
  };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <button className="close" onClick={onClose}>✕</button>
        <div className="modal-h">Lawyer Details</div>
        {readOnly && !isAgent && (
          <div className="card" style={{ borderLeft: '4px solid #2563eb', background: '#eff6ff', marginBottom: 12 }}>
            <span style={{ fontSize: 12.5, color: '#1e3a8a' }}>🔒 View-only — click <strong>Edit</strong> on the transaction to make changes.</span>
          </div>
        )}
        <fieldset disabled={readOnly} style={{ border: 0, margin: 0, padding: 0, minInlineSize: 0 }}>
        <div className="field"><label>Lawyer Name <span className="req">*</span></label>
          <AutoComplete
            value={form.lawyer_name} onChange={(v) => set('lawyer_name', v)} onPick={pickLawyer}
            options={suggestions} getLabel={(s) => s.name}
            getSub={(s) => [s.email, s.phone].filter(Boolean).join(' · ')}
            placeholder="e.g. Jane Smith"
          />
        </div>
        <div className="field"><label>Address <span className="req">*</span></label><input value={form.lawyer_address} onChange={(e) => set('lawyer_address', e.target.value)} placeholder="123 Legal Ave, Toronto, ON" /></div>
        <div className="g2">
          <div className="field"><label>Email <span className="req">*</span></label><input type="email" value={form.lawyer_email} onChange={(e) => set('lawyer_email', e.target.value)} placeholder="lawyer@example.ca" /></div>
          <div className="field"><label>Phone <span className="req">*</span></label><input value={form.lawyer_phone} onChange={(e) => set('lawyer_phone', e.target.value)} placeholder="+1 000-000-0000" /></div>
        </div>
        <span className="help">Used to auto-fill the Notice of Sale and Trade Sheet documents.</span>
        </fieldset>
        <SavedBadge show={savedOk} />
        <div className="actions">
          <button className="btn ghost" onClick={onClose}>Close</button>
          {!readOnly && <button className="btn primary" onClick={save} disabled={saving || savedOk}>{savedOk ? '✓ Saved' : (saving ? 'Saving…' : 'Save')}</button>}
        </div>
      </div>
    </div>
  );
}
