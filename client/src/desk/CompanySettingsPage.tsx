import { useEffect, useRef, useState } from 'react';
import { getCompanySettings, updateCompanySettings, uploadCompanyLogo, deleteCompanyLogo, companyLogoUrl } from '../lib/api';
import { fileToBase64 } from '../lib/importApi';
import { bumpLogoVersion, TextWordmark, LOGO_MAX_HEIGHT } from './BrandMark';
import { useToast } from './toast';
import { apiErrorMessage } from '../lib/apiError';
import { useAuth } from '../context/AuthContext';
import type { CompanySettings } from '../types';

const LOGO_ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.svg';
const LOGO_MAX_MB = 2;

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
  const [logoBusy, setLogoBusy] = useState('');
  // Bumped after every logo change so the <img> below re-fetches instead of showing a cached file.
  const [logoV, setLogoV] = useState(0);
  const logoInput = useRef<HTMLInputElement>(null);

  useEffect(() => { getCompanySettings().then(setForm).catch(() => toast('Could not load settings', 'bad')); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!form) return <div className="centered">Loading settings…</div>;

  const pickLogo = async (file: File | null) => {
    if (!file) return;
    if (file.size > LOGO_MAX_MB * 1024 * 1024) {
      toast(`That image is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is ${LOGO_MAX_MB} MB.`, 'bad');
      return;
    }
    setLogoBusy('upload');
    try {
      setForm(await uploadCompanyLogo(file.name, await fileToBase64(file)));
      setLogoV(bumpLogoVersion());
      toast('Logo updated — it now appears on every document', 'ok');
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not upload the logo'), 'bad');
    } finally {
      setLogoBusy('');
      if (logoInput.current) logoInput.current.value = '';
    }
  };

  const removeLogo = async () => {
    setLogoBusy('remove');
    try {
      setForm(await deleteCompanyLogo());
      setLogoV(bumpLogoVersion());
      toast('Logo removed — documents fall back to the text letterhead', 'ok');
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not remove the logo'), 'bad');
    } finally { setLogoBusy(''); }
  };

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

      <div className="card">
        <div className="modal-h" style={{ fontSize: 14 }}>Brand Logo</div>
        <p className="help" style={{ marginTop: 0 }}>
          Used everywhere the brokerage is branded — the sidebar and sign-in screen, and the
          letterhead of every Invoice, Deposit Receipt, Lawyer Statement, Notice of Sale and
          Trade Sheet. Remove it and those fall back to the built-in text letterhead.
        </p>
        <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Preview at the size documents actually use, so what you see here is what prints. */}
          <div style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 16, background: '#fff', minWidth: 240, minHeight: 120, maxWidth: '100%', overflow: 'hidden', display: 'grid', placeItems: 'center' }}>
            {form.logo_path
              ? <img key={logoV} src={companyLogoUrl(logoV || form.updated_at)} alt="Brand logo"
                  style={{ maxHeight: LOGO_MAX_HEIGHT, maxWidth: '100%', objectFit: 'contain', display: 'block' }} />
              : <TextWordmark />}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <input ref={logoInput} type="file" accept={LOGO_ACCEPT} style={{ display: 'none' }}
              onChange={(e) => void pickLogo(e.target.files?.[0] ?? null)} />
            <button className="btn primary sm" disabled={!canEdit || !!logoBusy} onClick={() => logoInput.current?.click()}>
              {logoBusy === 'upload' ? 'Uploading…' : form.logo_path ? '⭱ Replace Logo' : '⭱ Upload Logo'}
            </button>
            {form.logo_path && (
              <button className="btn ghost sm" disabled={!canEdit || !!logoBusy} onClick={() => void removeLogo()}>
                {logoBusy === 'remove' ? 'Removing…' : '🗑 Remove Logo'}
              </button>
            )}
            <span className="help" style={{ maxWidth: 260 }}>
              PNG, JPG, GIF, WEBP or SVG · up to {LOGO_MAX_MB} MB.
              A wide image on a transparent background prints best.
            </span>
            {!canEdit && <span className="help">Administrators only.</span>}
          </div>
        </div>
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
