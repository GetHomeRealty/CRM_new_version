import { useEffect, useState } from 'react';
import { updateTransaction, getLawyerSuggestions } from '../lib/api';
import { useToast } from './toast';
import AutoComplete from './AutoComplete';

export default function LawyerModal({ open, onClose, transactionId, txn, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({
    lawyer_name: txn.lawyer_name || '',
    lawyer_email: txn.lawyer_email || '',
    lawyer_phone: txn.lawyer_phone || '',
    lawyer_address: txn.lawyer_address || '',
  });
  const [saving, setSaving] = useState(false);
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
    setSaving(true);
    try {
      const updated = await updateTransaction(transactionId, form);
      toast('Lawyer details saved', 'ok');
      onSaved?.(updated);
      onClose();
    } catch (e) {
      toast(e.response?.data?.message || 'Could not save', 'bad');
    } finally { setSaving(false); }
  };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <button className="close" onClick={onClose}>✕</button>
        <div className="modal-h">Lawyer Details</div>
        <div className="field"><label>Lawyer Name</label>
          <AutoComplete
            value={form.lawyer_name} onChange={(v) => set('lawyer_name', v)} onPick={pickLawyer}
            options={suggestions} getLabel={(s) => s.name}
            getSub={(s) => [s.email, s.phone].filter(Boolean).join(' · ')}
            placeholder="e.g. Jane Smith"
          />
        </div>
        <div className="field"><label>Address</label><input value={form.lawyer_address} onChange={(e) => set('lawyer_address', e.target.value)} placeholder="123 Legal Ave, Toronto, ON" /></div>
        <div className="g2">
          <div className="field"><label>Email</label><input type="email" value={form.lawyer_email} onChange={(e) => set('lawyer_email', e.target.value)} placeholder="lawyer@example.ca" /></div>
          <div className="field"><label>Phone</label><input value={form.lawyer_phone} onChange={(e) => set('lawyer_phone', e.target.value)} placeholder="+1 000-000-0000" /></div>
        </div>
        <span className="help">Used to auto-fill the Notice of Sale and Trade Sheet documents.</span>
        <div className="actions">
          <button className="btn ghost" onClick={onClose}>Close</button>
          <button className="btn primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
