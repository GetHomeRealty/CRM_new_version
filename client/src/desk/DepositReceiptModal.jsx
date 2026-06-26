import { useState } from 'react';
import { formatCurrency, parseNumber } from './format';
import { printDoc } from './printDoc';

const BRAND = '#c8102e';
const today = () => new Date().toISOString().slice(0, 10);

// Deposit Receipt document (listing-side transactions). Auto-fills from the
// transaction; blank fields are editable. Print/Save-PDF builds the markup from
// state so typed values are included.
export default function DepositReceiptModal({ open, onClose, txn }) {
  const [f, setF] = useState(() => ({
    date: today(),
    address: txn.property || '',
    coop_brokerage: txn.brokerage?.name || '',
    coop_agent: (txn.brokerage?.agents || []).filter(Boolean).join(', '),
    contact_sales: txn.brokerage?.phone || '',
    bank_name: '',
    received_from: (txn.clients && txn.clients[0]?.name) || '',
    deposit_amount: txn.deposit ?? '',
    date_transfer: '',
    balance_due: '',
    listing_agent: txn.agent || '',
  }));
  if (!open) return null;
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const tradeNo = txn.trade_no || '';

  const printHtml = () => `
    <div style="text-align:center">
      <div style="font-size:24px;font-weight:800;color:${BRAND}">GET&#9730;HOME REALTY</div>
      <div style="font-size:11px;font-style:italic;color:#64748b">"A Tradition of Trust" — Brokerage</div>
      <div style="font-size:11px;color:#475569">Unit-101, 218 Export Blvd, Mississauga, L5S 0A7, Ontario, Canada</div>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin:14px 0">
      <div style="background:${BRAND};color:#fff;font-weight:800;padding:6px 16px;border-radius:4px;font-size:18px">Deposit Receipt</div>
      <div style="font-weight:700">Date: ${f.date || ''}</div>
    </div>
    <p style="font-weight:700">Trade No: ${tradeNo}</p>
    <p style="font-weight:700;text-decoration:underline">Property Details:</p>
    <ul style="line-height:1.9">
      <li>Address: ${f.address || ''}</li>
      <li>Co-op Brokerage: ${f.coop_brokerage || ''}</li>
      <li>Co-op Agent: ${f.coop_agent || ''}</li>
      <li>Contact of Sales Person: ${f.contact_sales || ''}</li>
    </ul>
    <p style="font-weight:700;text-decoration:underline">Deposit Information:</p>
    <ul style="line-height:1.9">
      <li>Name of the Bank: ${f.bank_name || ''}</li>
      <li>Received From: ${f.received_from || ''}</li>
      <li>Deposit Amount: ${f.deposit_amount !== '' ? formatCurrency(f.deposit_amount) : '$'}</li>
      <li>Date of Transfer: ${f.date_transfer || ''}</li>
      <li>Balance due: ${f.balance_due !== '' ? formatCurrency(f.balance_due) : '$'}</li>
      <li>Name of the Listing Agent: ${f.listing_agent || ''}</li>
    </ul>
    <p style="font-weight:700">Copy of Deposit slip:</p>
    <div style="height:160px;border:1px dashed #cbd5e1;border-radius:6px;margin:6px 0"></div>
    <div style="margin-top:40px">Signature: ______________________________</div>
    <p style="text-align:center;margin-top:20px;font-style:italic">*This is to confirm the Deposit amount received from the client*<br/>Admin Department @ Get Home Realty</p>
  `;

  const lbl = { fontSize: 11.5, color: 'var(--text-2)', fontWeight: 600 };
  const inp = { border: '1px solid #e6e8ef', borderRadius: 6, padding: '5px 8px', width: '100%' };
  const Row = ({ label, k, type }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
      <span style={{ ...lbl, minWidth: 190 }}>{label}</span>
      <input type={type || 'text'} value={f[k]} onChange={(e) => set(k, e.target.value)} style={inp} />
    </div>
  );

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal lg" style={{ maxHeight: '92vh', overflowY: 'auto' }}>
        <button className="close" onClick={onClose}>✕</button>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div className="modal-h" style={{ margin: 0, border: 0, padding: 0 }}>Deposit Receipt</div>
          <button className="btn primary sm" onClick={() => printDoc(`Deposit Receipt - ${tradeNo}`, printHtml())}>🖨 Print / Save PDF</button>
        </div>

        <div style={{ textAlign: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: BRAND }}>GET<span style={{ color: '#0f172a' }}>&#9730;</span>HOME REALTY</div>
          <div style={{ fontSize: 10, fontStyle: 'italic', color: '#64748b' }}>"A Tradition of Trust" — Brokerage</div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <span style={{ background: BRAND, color: '#fff', fontWeight: 700, padding: '4px 14px', borderRadius: 4 }}>Deposit Receipt</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span style={lbl}>Date</span><input type="date" value={f.date} onChange={(e) => set('date', e.target.value)} style={{ ...inp, width: 'auto' }} /></div>
        </div>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Trade No: {tradeNo}</div>

        <div className="modal-sub" style={{ marginTop: 0 }}>Property Details</div>
        <Row label="Address" k="address" />
        <Row label="Co-op Brokerage" k="coop_brokerage" />
        <Row label="Co-op Agent" k="coop_agent" />
        <Row label="Contact of Sales Person" k="contact_sales" />

        <div className="modal-sub">Deposit Information</div>
        <Row label="Name of the Bank" k="bank_name" />
        <Row label="Received From" k="received_from" />
        <Row label="Deposit Amount ($)" k="deposit_amount" />
        <Row label="Date of Transfer" k="date_transfer" type="date" />
        <Row label="Balance due ($)" k="balance_due" />
        <Row label="Name of the Listing Agent" k="listing_agent" />

        <div style={{ fontWeight: 700, marginTop: 10 }}>Copy of Deposit slip</div>
        <div style={{ height: 120, border: '1px dashed #cbd5e1', borderRadius: 6, marginTop: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 12 }}>Attach the deposit slip image when printing/sharing.</div>

        <div className="actions"><button className="btn ghost" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
