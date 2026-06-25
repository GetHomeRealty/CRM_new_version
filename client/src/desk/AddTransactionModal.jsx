import { useState } from 'react';
import { createTransaction } from '../lib/api';
import { TRANSACTION_TYPES, typeLabel, isListingType, parseNumber } from './format';
import { useToast } from './toast';

const EMPTY = {
  type: '', property: '',
  comm_type: '%', comm_value: '', price: '', deposit: '',
  offer_date: '', closing_date: '',
  listing_contract_date: '', listing_expiry_date: '',
};

export default function AddTransactionModal({ open, onClose, onCreated }) {
  const toast = useToast();
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);

  if (!open) return null;

  const listing = isListingType(form.type);
  const isLease = form.type === 'Residential Lease';
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const reset = () => setForm(EMPTY);
  const close = () => { reset(); onClose(); };

  const submit = async () => {
    if (!form.type || !form.property.trim()) { toast('Please fill all required fields', 'bad'); return; }
    const payload = { type: form.type, property: form.property.trim() };

    if (listing) {
      payload.listing_contract_date = form.listing_contract_date || null;
      payload.listing_expiry_date = form.listing_expiry_date || null;
    } else {
      const commValue = parseNumber(form.comm_value);
      const price = parseNumber(form.price);
      if (!commValue || !price || !form.offer_date || !form.closing_date) {
        toast('Please fill all required fields', 'bad'); return;
      }
      if (form.comm_type === '%' && commValue > 100) { toast('Commission % cannot exceed 100', 'bad'); return; }
      Object.assign(payload, {
        comm_type: form.comm_type,
        comm_value: commValue,
        price,
        deposit: parseNumber(form.deposit),
        offer_date: form.offer_date,
        closing_date: form.closing_date,
      });
    }

    setSaving(true);
    try {
      const created = await createTransaction(payload);
      toast('Transaction saved successfully', 'ok');
      close();
      onCreated?.(created);
    } catch (err) {
      const msg = err.response?.data?.message || 'Could not save transaction';
      toast(msg, 'bad');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal">
        <button className="close" onClick={close}>{'✕'}</button>
        <div className="modal-h">Add Transaction</div>

        <div className="field">
          <label>Transaction Type <span className="req">*</span></label>
          <select value={form.type} onChange={(e) => set('type', e.target.value)}>
            <option value="">Select type</option>
            {TRANSACTION_TYPES.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
          </select>
        </div>

        {form.type && (
          <>
            <div className="field">
              <label>Property Address <span className="req">*</span></label>
              <input value={form.property} onChange={(e) => set('property', e.target.value)} placeholder="Full street address" />
            </div>

            {listing ? (
              <div className="g2">
                <div className="field"><label>Listing Contract Date</label>
                  <input type="date" value={form.listing_contract_date} onChange={(e) => set('listing_contract_date', e.target.value)} /></div>
                <div className="field"><label>Listing Expiry Date</label>
                  <input type="date" value={form.listing_expiry_date} onChange={(e) => set('listing_expiry_date', e.target.value)} /></div>
              </div>
            ) : (
              <>
                <div className="g2">
                  <div className="field"><label>Commission Input Type <span className="req">*</span></label>
                    <select value={form.comm_type} onChange={(e) => set('comm_type', e.target.value)}>
                      <option value="%">% (Percentage)</option>
                      <option value="Fixed">Fixed Amount</option>
                    </select>
                  </div>
                  <div className="field"><label>Commission Value <span className="req">*</span></label>
                    <input value={form.comm_value} onChange={(e) => set('comm_value', e.target.value)} placeholder="0.00" /></div>
                </div>
                <div className="g3">
                  <div className="field"><label>{isLease ? 'Total lease price' : 'Total Purchase Price'} <span className="req">*</span></label>
                    <input value={form.price} onChange={(e) => set('price', e.target.value)} placeholder="0.00" /></div>
                  <div className="field"><label>Deposit</label>
                    <input value={form.deposit} onChange={(e) => set('deposit', e.target.value)} placeholder="0.00" /></div>
                </div>
                <div className="g2">
                  <div className="field"><label>Offer Date <span className="req">*</span></label>
                    <input type="date" value={form.offer_date} onChange={(e) => set('offer_date', e.target.value)} /></div>
                  <div className="field"><label>Closing Date <span className="req">*</span></label>
                    <input type="date" value={form.closing_date} onChange={(e) => set('closing_date', e.target.value)} /></div>
                </div>
              </>
            )}
          </>
        )}

        <div className="actions">
          <button className="btn ghost" onClick={close}>Close</button>
          <button className="btn primary" onClick={submit} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
