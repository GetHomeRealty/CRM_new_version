import { useEffect, useState } from 'react';
import { getCompanySettings, updateCompanySettings } from '../lib/api';
import { useToast } from './toast';
import { useAuth } from '../context/AuthContext';

const FIELDS_A = [
  ['name', 'Company Name'], ['address', 'Address'], ['phone', 'Phone'], ['email', 'Email'], ['hst_number', 'HST / Tax Number'],
];
const FIELDS_BANK = [
  ['bank_beneficiary', 'Beneficiary Name'], ['bank_name', 'Bank Name'], ['transit_no', 'Transit No.'], ['account_no', 'Account No.'], ['institution_no', 'Institution No.'],
];
const FIELDS_INV = [
  ['currency', 'Currency'], ['default_tax_rate', 'Default Tax Rate (%)'], ['invoice_prefix', 'Invoice Prefix'], ['next_invoice_no', 'Next Invoice No.'], ['default_terms', 'Default Terms'],
];

export default function CompanySettingsPage() {
  const toast = useToast();
  const { can } = useAuth();
  const canEdit = can('settings', 'edit');
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { getCompanySettings().then(setForm).catch(() => toast('Could not load settings', 'bad')); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!form) return <div className="centered">Loading settings…</div>;

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const save = async () => {
    setSaving(true);
    try { setForm(await updateCompanySettings(form)); toast('Settings saved', 'ok'); }
    catch (e) { toast(e.response?.data?.message || 'Could not save (admin only)', 'bad'); }
    finally { setSaving(false); }
  };

  const grid = (fields) => (
    <div className="g3">
      {fields.map(([k, l]) => (
        <div className="field" key={k}><label>{l}</label><input value={form[k] ?? ''} disabled={!canEdit} onChange={(e) => set(k, e.target.value)} /></div>
      ))}
    </div>
  );

  return (
    <>
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="modal-h" style={{ fontSize: 14, margin: 0 }}>Company Settings</div>
          {canEdit && <button className="btn primary sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>}
        </div>
        {!canEdit && <span className="help">Read-only — only administrators can change company settings.</span>}
      </div>

      <div className="card"><div className="modal-h" style={{ fontSize: 14 }}>Company Profile</div>{grid(FIELDS_A)}</div>
      <div className="card"><div className="modal-h" style={{ fontSize: 14 }}>Bank / Deposit Instructions</div>{grid(FIELDS_BANK)}</div>
      <div className="card">
        <div className="modal-h" style={{ fontSize: 14 }}>Invoicing Defaults</div>
        {grid(FIELDS_INV)}
        <div className="g2">
          <div className="field"><label>Thank-you Note</label><textarea rows={2} value={form.thank_you_note ?? ''} disabled={!canEdit} onChange={(e) => set('thank_you_note', e.target.value)} /></div>
          <div className="field"><label>Deposit Heading</label><textarea rows={2} value={form.deposit_heading ?? ''} disabled={!canEdit} onChange={(e) => set('deposit_heading', e.target.value)} /></div>
        </div>
      </div>
    </>
  );
}
