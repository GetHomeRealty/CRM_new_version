import { useArea } from './AreaContext';
import { useEffect, useRef, useState } from 'react';
import { getCompanySettings, updateCompanySettings, uploadCompanyLogo, deleteCompanyLogo, companyLogoUrl } from '../lib/api';
import { fileToBase64 } from '../lib/importApi';
import { bumpLogoVersion, TextWordmark, LOGO_MAX_HEIGHT } from './BrandMark';
import { useToast } from './toast';
import { apiErrorMessage } from '../lib/apiError';
import { useAuth } from '../context/AuthContext';
import { useUnsavedGuard } from './useUnsavedGuard';
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
  // Which sections are shown: the bank, reminder and invoicing sections belong to the Transaction
  // Desk. The profile and logo are shared and appear on both sides.
  const { area } = useArea();
  const [form, setForm] = useState<CompanySettings | null>(null);
  const [saving, setSaving] = useState(false);
  // Edits made since the last load or save. Drives both the leave-warning and the Save button, so
  // an unsaved change is visible on the screen before the browser has to ask about it.
  const [dirty, setDirty] = useState(false);
  useUnsavedGuard(dirty);
  const [logoBusy, setLogoBusy] = useState('');
  // Bumped after every logo change so the <img> below re-fetches instead of showing a cached file.
  const [logoV, setLogoV] = useState(0);
  const logoInput = useRef<HTMLInputElement>(null);
  const sigInput = useRef<HTMLInputElement>(null);

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

  const set = (k: string, v: string) => { setDirty(true); setForm((f) => (f ? { ...f, [k]: v } : f)); };

  /**
   * Invoice Settings - the default signature. Downscaled to a compact PNG data URL exactly as the
   * invoice editor does for a per-deal signature, so the copy each new invoice takes is the same kind
   * of value. Saved with the rest of the form.
   */
  const pickSignature = (file: File | null) => {
    if (sigInput.current) sigInput.current.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast('Please choose an image file (PNG/JPG).', 'bad'); return; }
    if (file.size > 5 * 1024 * 1024) { toast('Signature image is too large (max 5 MB).', 'bad'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 600 / img.width, 240 / img.height);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        set('invoice_signature', canvas.toDataURL('image/png'));
        toast('Signature added — remember to Save.', 'ok');
      };
      img.onerror = () => toast('Could not read the image file.', 'bad');
      img.src = reader.result as string;
    };
    reader.onerror = () => toast('Could not read the image file.', 'bad');
    reader.readAsDataURL(file);
  };
  const save = async () => {
    setSaving(true);
    try {
      setDirty(false);
      // `expected_updated_at` is the row as this page loaded it. The server refuses the save with a
      // 409 if somebody else has written since, rather than letting this form silently discard
      // their work — two administrators tidying the company profile on the same afternoon both used
      // to get 200 and the second one won without either being told.
      setForm(await updateCompanySettings({ ...form, expected_updated_at: form.updated_at }));
      toast('Settings saved', 'ok');
    } catch (e) {
      // The edits are still on screen and still unsaved, so the guard has to go back on.
      setDirty(true);
      toast(apiErrorMessage(e, 'Could not save (admin only)'), 'bad');
    } finally { setSaving(false); }
  };

  /**
   * A value the API withheld from this reader, as opposed to one that is genuinely empty.
   *
   * `GET /api/company-settings` strips the banking fields — including `hst_number` — for anyone
   * below `accounting`, and the key is absent rather than null. Rendering that as an ordinary blank
   * box told the reader the brokerage has no HST registration and offered them an editable field in
   * which to type one they were never allowed to see.
   */
  const isWithheld = (k: string) => !(k in form);

  const grid = (fields: [string, string][]) => (
    <div className="g3">
      {fields.map(([k, l]) => {
        const withheld = isWithheld(k);
        return (
          <div className="field" key={k}>
            {/* `htmlFor`/`id` rather than a bare <label> beside an <input>: without the pair the
                control has no accessible name, which was true of 26 of the 41 controls across the
                Settings screens. */}
            <label htmlFor={`cs-${k}`}>{l}</label>
            <input
              id={`cs-${k}`}
              value={withheld ? '' : String(form[k] ?? '')}
              placeholder={withheld ? 'Hidden — you do not have access to this' : undefined}
              disabled={!canEdit || withheld}
              onChange={(e) => set(k, e.target.value)}
            />
            {withheld && (
              <span className="help">
                Withheld. Only Accounting and above may see the brokerage's banking and tax numbers.
                Leaving this alone does not clear the stored value.
              </span>
            )}
          </div>
        );
      })}
    </div>
  );

  return (
    <>
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 className="modal-h" style={{ fontSize: 14, margin: 0 }}>Company Settings</h3>
          {canEdit && <button className="btn primary sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>}
        </div>
        {!canEdit && <span className="help">Read-only — only administrators can change company settings.</span>}
      </div>

      <div className="card">
        <h3 className="modal-h" style={{ fontSize: 14 }}>Brand Logo</h3>
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

      <div className="card"><h3 className="modal-h" style={{ fontSize: 14 }}>Company Profile</h3>{grid(FIELDS_A)}</div>

      {/*
        Invoice Settings (bank details and invoice defaults), Automatic Reminders and Invoicing Defaults
        are Transaction Desk settings: they configure invoices and deposit receipts, the lawyer-detail
        reminder that chases a deal, and invoice numbering and tax. Company Settings itself is shared, so only these three sections are
        held back from the CRM — the profile and logo above stay on both sides.

        Hidden, not dropped from the payload. `save` sends the whole form as it was loaded, so these
        values go back unchanged when the CRM saves; nothing is cleared by editing from that side.
      */}
      {area === 'desk' && (<>
        {/*
          Invoice Settings - what every invoice prints or starts with. The bank details are read live
          (an edit here shows on every invoice, old ones included, and on the Deposit Receipt, Lawyer
          Statement, Notice of Sale and Trade Sheet). The notes, terms and signature are COPIED onto
          each new invoice, which can then change its own copy before it is sent.
        */}
        <div className="card">
          <h3 className="modal-h" style={{ fontSize: 14 }}>Invoice Settings</h3>
          <h4 style={{ fontSize: 12.5, margin: '4px 0 6px' }}>Bank / Deposit Instructions</h4>
          <p className="help" style={{ marginTop: 0 }}>Printed in the Deposit Instructions of every invoice, and on the Deposit Receipt, Lawyer Statement, Notice of Sale and Trade Sheet.</p>
          {grid(FIELDS_BANK)}
          <h4 style={{ fontSize: 12.5, margin: '14px 0 6px' }}>Invoice defaults</h4>
          <p className="help" style={{ marginTop: 0 }}>Each new invoice starts with these. They can be changed for an individual deal before the invoice is sent.</p>
          <div className="g2">
            <div className="field">
              <label htmlFor="cs-thank_you_note">Default Customer Notes</label>
              <textarea id="cs-thank_you_note" rows={3} maxLength={2000} value={String(form.thank_you_note ?? '')} disabled={!canEdit} onChange={(e) => set('thank_you_note', e.target.value)} />
            </div>
            {!isWithheld('invoice_terms_conditions') && (
              <div className="field">
                <label htmlFor="cs-invoice_terms_conditions">Default Terms &amp; Conditions</label>
                <textarea id="cs-invoice_terms_conditions" rows={3} maxLength={2000} value={String(form.invoice_terms_conditions ?? '')} disabled={!canEdit} onChange={(e) => set('invoice_terms_conditions', e.target.value)} />
              </div>
            )}
          </div>
          {!isWithheld('invoice_signature') && (
            <div className="field">
              <label>Invoice Signature</label>
              <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 8, background: '#fff', minWidth: 200, minHeight: 70, display: 'grid', placeItems: 'center' }}>
                  {form.invoice_signature
                    ? <img src={String(form.invoice_signature)} alt="Invoice signature" style={{ maxHeight: 70, maxWidth: 260, display: 'block' }} />
                    : <span className="help">No signature</span>}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <input ref={sigInput} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => pickSignature(e.target.files?.[0] ?? null)} />
                  <button className="btn primary sm" disabled={!canEdit} onClick={() => sigInput.current?.click()}>
                    {form.invoice_signature ? '⭱ Replace Signature' : '⭱ Upload Signature'}
                  </button>
                  {form.invoice_signature && (
                    <button className="btn ghost sm" disabled={!canEdit} onClick={() => set('invoice_signature', '')}>🗑 Remove Signature</button>
                  )}
                  <span className="help" style={{ maxWidth: 260 }}>Shown under "Acknowledged by" on every new invoice. PNG or JPG, ideally on a plain background. Save to apply.</span>
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="card">
          <h3 className="modal-h" style={{ fontSize: 14 }}>Automatic Reminders</h3>
          <div className="g3">
            <div className="field">
              <label htmlFor="cs-lawyer_reminder_days">Lawyer detail reminders</label>
              {/* 29 Oct 2026 (Sai) - the number only ever worked as On (above 0) / Off (0), so it is
                  shown as that: On stores 3 (its old default), Off stores 0. The days themselves
                  are set on the Triggers screen. */}
              <select id="cs-lawyer_reminder_days" value={Number(form.lawyer_reminder_days ?? 3) > 0 ? 'on' : 'off'} disabled={!canEdit}
                onChange={(e) => { setDirty(true); setForm((f) => (f ? { ...f, lawyer_reminder_days: e.target.value === 'on' ? 3 : 0 } : f)); }}>
                <option value="on">On</option>
                <option value="off">Off</option>
              </select>
              <span className="help">Agents are reminded while buyer/seller lawyer details are missing on a Buying deal. The days are set on the Triggers screen.</span>
            </div>
          </div>
        </div>

        <div className="card">
          <h3 className="modal-h" style={{ fontSize: 14 }}>Invoicing Defaults</h3>
          {grid(FIELDS_INV)}
          <div className="g2">
            <div className="field">
              <label htmlFor="cs-deposit_heading">Deposit Heading</label>
              <textarea id="cs-deposit_heading" rows={2} maxLength={2000} value={String(form.deposit_heading ?? '')} disabled={!canEdit} onChange={(e) => set('deposit_heading', e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="cs-deposit_signatory">Deposit Signatory</label>
              <input id="cs-deposit_signatory" maxLength={255} value={String(form.deposit_signatory ?? '')} disabled={!canEdit} onChange={(e) => set('deposit_signatory', e.target.value)} placeholder="Broker of record" />
            </div>
          </div>
        </div>
      </>)}
    </>
  );
}
