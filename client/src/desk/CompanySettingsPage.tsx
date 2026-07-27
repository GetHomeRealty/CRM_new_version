import { useEffect, useState } from 'react';
import { getCompanySettings, updateCompanySettings } from '../lib/api';
import { useToast } from './toast';
import { apiErrorMessage } from '../lib/apiError';
import { useAuth } from '../context/AuthContext';
import type { CompanySettings } from '../types';

const FIELDS_A: [string, string][] = [
  ['name', 'Company Name'], ['address', 'Address'], ['phone', 'Phone'], ['email', 'Email'], ['hst_number', 'HST / Tax Number'],
];
const FIELDS_BANK: [string, string][] = [
  ['bank_beneficiary', 'Beneficiary Name'], ['bank_name', 'Bank Name'], ['transit_no', 'Transit No.'], ['account_no', 'Account No.'], ['institution_no', 'Institution No.'],
];
const FIELDS_INV: [string, string][] = [
  ['currency', 'Currency'], ['default_tax_rate', 'Default Tax Rate (%)'], ['invoice_prefix', 'Invoice Prefix'], ['next_invoice_no', 'Next Invoice No.'], ['default_terms', 'Default Terms'],
];

export default function CompanySettingsPage() {
  const toast = useToast();
  const { can } = useAuth();
  const canEdit = can('settings', 'edit');
  const [form, setForm] = useState<CompanySettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { getCompanySettings().then(setForm).catch(() => toast('Could not load settings', 'bad')); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!form) return <div className="centered">Loading settings…</div>;

  const set = (k: string, v: string) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const save = async () => {
    setSaving(true);
    try { setForm(await updateCompanySettings(form)); toast('Settings saved', 'ok'); }
    catch (e) { toast(apiErrorMessage(e, 'Could not save (admin only)'), 'bad'); }
    finally { setSaving(false); }
  };

  const grid = (fields: [string, string][]) => (
    <div className="g3">
      {fields.map(([k, l]) => (
        <div className="field" key={k}><label>{l}</label><input value={String(form[k] ?? '')} disabled={!canEdit} onChange={(e) => set(k, e.target.value)} /></div>
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
        <div className="modal-h" style={{ fontSize: 14 }}>Automatic Reminders</div>
        <div className="g3">
          <div className="field">
            <label>Lawyer detail reminder — every (days)</label>
            <input type="number" min={0} max={365} value={String(form.lawyer_reminder_days ?? 3)} disabled={!canEdit}
              onChange={(e) => set('lawyer_reminder_days', e.target.value)} />
            <span className="help">Agents are re-emailed this often while buyer/seller lawyer details are missing on a Buying/Lease deal. Set to 0 to turn recurring reminders off.</span>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="modal-h" style={{ fontSize: 14 }}>Invoicing Defaults</div>
        {grid(FIELDS_INV)}
        <div className="g2">
          <div className="field"><label>Thank-you Note</label><textarea rows={2} value={String(form.thank_you_note ?? '')} disabled={!canEdit} onChange={(e) => set('thank_you_note', e.target.value)} /></div>
          <div className="field"><label>Deposit Heading</label><textarea rows={2} value={String(form.deposit_heading ?? '')} disabled={!canEdit} onChange={(e) => set('deposit_heading', e.target.value)} /></div>
        </div>
      </div>
    </>
  );
}
