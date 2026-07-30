import { useEffect, useState, type ReactNode } from 'react';
import { updateTransaction, getLawyerSuggestions } from '../lib/api';
import { isPreconType } from './format';
import { useToast } from './toast';
import { apiErrorMessage } from '../lib/apiError';
import SavedBadge from './SavedBadge';
import AutoComplete from './AutoComplete';
import type { LawyerSuggestion, Transaction } from '../types';

interface LawyerForm {
  lawyer_name: string; lawyer_email: string; lawyer_phone: string; lawyer_address: string;
  buyer_lawyer_name: string; buyer_lawyer_email: string; buyer_lawyer_phone: string; buyer_lawyer_address: string;
  seller_lawyer_name: string; seller_lawyer_email: string; seller_lawyer_phone: string; seller_lawyer_address: string;
}
type LawyerPrefix = '' | 'buyer_' | 'seller_';
type LawyerSide = 'buyer' | 'seller';

interface LawyerModalProps {
  open: boolean;
  onClose: () => void;
  transactionId: number | string;
  txn: Transaction;
  onSaved?: (updated: Transaction) => void;
  readOnly?: boolean;
  isAgent?: boolean;
}

export default function LawyerModal({ open, onClose, transactionId, txn, onSaved, readOnly = false, isAgent = false }: LawyerModalProps) {
  const toast = useToast();
  // Sale/Buy deals capture both the Buyer's and Seller's lawyer; Lease, Preconstruction
  // and Referral keep the single Lawyer Details section.
  const dual = !/lease/i.test(txn.type) && !isPreconType(txn.type) && txn.type !== 'Referral';
  // Which side feeds the legacy lawyer_* fields (Notice of Sale / Trade Sheet auto-fill).
  const primary: LawyerSide = /buying/i.test(txn.type) ? 'buyer' : 'seller';
  // Primary-contact label for the note: Buyer for Buying & Preconstruction, Seller for Sale Listings.
  const primaryLabel = (/buying/i.test(txn.type) || isPreconType(txn.type)) ? 'Buyer' : 'Seller';
  const showPrimaryNote = dual || isPreconType(txn.type);

  const [form, setForm] = useState<LawyerForm>({
    lawyer_name: txn.lawyer_name || '',
    lawyer_email: txn.lawyer_email || '',
    lawyer_phone: txn.lawyer_phone || '',
    lawyer_address: txn.lawyer_address || '',
    buyer_lawyer_name: txn.buyer_lawyer_name || '',
    buyer_lawyer_email: txn.buyer_lawyer_email || '',
    buyer_lawyer_phone: txn.buyer_lawyer_phone || '',
    buyer_lawyer_address: txn.buyer_lawyer_address || '',
    seller_lawyer_name: txn.seller_lawyer_name || '',
    seller_lawyer_email: txn.seller_lawyer_email || '',
    seller_lawyer_phone: txn.seller_lawyer_phone || '',
    seller_lawyer_address: txn.seller_lawyer_address || '',
  });
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false); // §3.2 — "Saved" then auto-close
  const [suggestions, setSuggestions] = useState<LawyerSuggestion[]>([]);
  useEffect(() => { if (open) getLawyerSuggestions().then(setSuggestions).catch(() => {}); }, [open]);
  if (!open) return null;

  const set = (k: keyof LawyerForm, v: string) => setForm((f) => ({ ...f, [k]: v }));
  // Fill a lawyer group (prefix '', 'buyer_' or 'seller_') from a picked suggestion.
  const pick = (prefix: LawyerPrefix) => (s: LawyerSuggestion) => setForm((f) => ({
    ...f,
    [`${prefix}lawyer_name`]: s.name || '',
    [`${prefix}lawyer_email`]: s.email || f[`${prefix}lawyer_email`],
    [`${prefix}lawyer_phone`]: s.phone || f[`${prefix}lawyer_phone`],
    [`${prefix}lawyer_address`]: s.address || f[`${prefix}lawyer_address`],
  }));

  const FIELDS = ['name', 'address', 'email', 'phone'] as const;
  const sideComplete = (s: LawyerSide) => FIELDS.every((f) => form[`${s}_lawyer_${f}`].trim());
  const sideTouched = (s: LawyerSide) => FIELDS.some((f) => form[`${s}_lawyer_${f}`].trim());

  const save = async () => {
    let payload: Record<string, unknown> = { ...form };
    if (dual) {
      // Only a section that's been started is mandatory — complete it, or leave it empty.
      const badSide = (['buyer', 'seller'] as const).find((s) => sideTouched(s) && !sideComplete(s));
      if (badSide) {
        window.alert(`Please complete all ${badSide === 'buyer' ? 'Buyer' : 'Seller'} Lawyer fields, or clear that section.`);
        return;
      }
      if (!sideComplete('buyer') && !sideComplete('seller')) {
        window.alert('Please fill at least one of Buyer Lawyer or Seller Lawyer details, and save.');
        return;
      }
      // Mirror a completed side into the legacy lawyer_* fields (Notice of Sale / Trade Sheet):
      // prefer the primary side; fall back to whichever side is filled.
      const other: LawyerSide = primary === 'buyer' ? 'seller' : 'buyer';
      const mirrorSide = sideComplete(primary) ? primary : other;
      payload = {
        ...payload,
        lawyer_name: form[`${mirrorSide}_lawyer_name`],
        lawyer_email: form[`${mirrorSide}_lawyer_email`],
        lawyer_phone: form[`${mirrorSide}_lawyer_phone`],
        lawyer_address: form[`${mirrorSide}_lawyer_address`],
      };
    } else if (!form.lawyer_name.trim() || !form.lawyer_address.trim() || !form.lawyer_email.trim() || !form.lawyer_phone.trim()) {
      window.alert('Please fill all the mandatory fields (Lawyer Name, Address, Email, Phone) and save.');
      return;
    }
    setSaving(true);
    try {
      const updated = await updateTransaction(transactionId, payload);
      onSaved?.(updated);
      setSavedOk(true);
      setTimeout(() => { setSavedOk(false); onClose(); }, 2000);
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not save'), 'bad');
      setSaving(false);
    }
  };

  // One lawyer group (Name / Address / Email / Phone) for the given prefix.
  const lawyerGroup = (prefix: LawyerPrefix): ReactNode => (
    <>
      <div className="field"><label>Lawyer Name <span className="req">*</span></label>
        <AutoComplete
          value={form[`${prefix}lawyer_name`]} onChange={(v) => set(`${prefix}lawyer_name`, v)} onPick={pick(prefix)}
          options={suggestions} getLabel={(s) => s.name || ''}
          getSub={(s) => [s.email, s.phone].filter(Boolean).join(' · ')}
          placeholder="e.g. Jane Smith"
        />
      </div>
      <div className="field"><label>Address <span className="req">*</span></label><input value={form[`${prefix}lawyer_address`]} onChange={(e) => set(`${prefix}lawyer_address`, e.target.value)} placeholder="123 Legal Ave, Toronto, ON" /></div>
      <div className="field"><label>Email <span className="req">*</span></label><input type="email" value={form[`${prefix}lawyer_email`]} onChange={(e) => set(`${prefix}lawyer_email`, e.target.value)} placeholder="lawyer@example.ca" /></div>
      <div className="field"><label>Phone <span className="req">*</span></label><input value={form[`${prefix}lawyer_phone`]} onChange={(e) => set(`${prefix}lawyer_phone`, e.target.value)} placeholder="+1 000-000-0000" /></div>
    </>
  );

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={dual ? 'modal lg' : 'modal'}>
        <button className="close" onClick={onClose}>✕</button>
        <div className="modal-h">Lawyer Details</div>
        {readOnly && !isAgent && (
          <div className="card" style={{ borderLeft: '4px solid #2563eb', background: 'var(--info-bg)', marginBottom: 12 }}>
            <span style={{ fontSize: 12.5, color: 'var(--info-ink)' }}>🔒 View-only — click <strong>Edit</strong> on the transaction to make changes.</span>
          </div>
        )}
        <fieldset disabled={readOnly} style={{ border: 0, margin: 0, padding: 0, minInlineSize: 0 }}>
        {dual ? (
          <div className="g2">
            <div>
              <div className="modal-sub" style={{ marginTop: 0 }}>Buyer Lawyer Details</div>
              {lawyerGroup('buyer_')}
            </div>
            <div>
              <div className="modal-sub" style={{ marginTop: 0 }}>Seller Lawyer Details</div>
              {lawyerGroup('seller_')}
            </div>
          </div>
        ) : (
          lawyerGroup('')
        )}
        <span className="help">Used to auto-fill the Notice of Sale and Trade Sheet documents{showPrimaryNote ? ` (the ${primaryLabel} Lawyer is used as the primary contact).` : '.'}</span>
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
