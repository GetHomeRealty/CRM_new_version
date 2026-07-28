import { useState } from 'react';
import { formatCurrency, commissionSummary } from './format';
import { printDoc } from './printDoc';
import BrandMark, { brandMarkHtml } from './BrandMark';
import type { CompanySettings, Transaction } from '../types';

const BRAND = '#c8102e';
const today = () => new Date().toISOString().slice(0, 10);

// Direct-deposit bank block (GHR's fixed details; matches the printed statement).
const BANK = { name: 'TD Canada Trust', beneficiary: 'Get Home Realty Inc.', transit: '21222', institution: '004', account: '2122-5073474' };

const WIRE_NOTE = "We recommend avoiding due to the significant fees involved. However, if you choose to proceed with a wire transfer, please consider adding an additional $17.50 to the deposit amount, in addition to your bank's basic wire transfer charges. This will ensure the full amount is credited to our account without any deductions.";
const DISCLAIMER = '*Please Confirm with the Client before Processing on this Transaction. Get Home Realty is not Responsible for any Legal Fee during the Transaction*';

interface StatementForm {
  date: string;
  lawyer_name: string;
  lawyer_address: string;
  lawyer_mail: string;
  lawyer_contact: string;
  property: string;
  sale_price: number | string;
  deposit_received: number | string;
  commission_payable: number | string;
  hst: number | string;
  total_commission: number | string;
  amount_payable_client: number | string;
  amount_receivable_brokerage: number | string;
  amount_received_lawyer: number | string;
  balance_lawyer: number | string;
}

interface LawyerStatementModalProps {
  open: boolean;
  onClose: () => void;
  txn: Transaction;
  settings?: CompanySettings | null;
}

// Commission / Lawyer Statement document (listing-side transactions).
export default function LawyerStatementModal({ open, onClose, txn, settings }: LawyerStatementModalProps) {
  const fin = txn.financial || {};
  const cs = commissionSummary(fin);
  const [f, setF] = useState<StatementForm>(() => ({
    date: today(),
    lawyer_name: txn.lawyer_name || '',
    lawyer_address: txn.lawyer_address || '',
    lawyer_mail: txn.lawyer_email || '',
    lawyer_contact: txn.lawyer_phone || '',
    property: txn.property || '',
    sale_price: txn.price ?? '',
    deposit_received: txn.deposit ?? '',
    commission_payable: cs.commission ?? '',
    hst: cs.hst ?? '',
    total_commission: cs.total ?? '',
    amount_payable_client: fin.payable_to_client ?? '',
    amount_receivable_brokerage: fin.receivable_from_lawyer ?? cs.total ?? '',
    amount_received_lawyer: '',
    balance_lawyer: '',
  }));
  if (!open) return null;
  const set = (k: keyof StatementForm, v: string) => setF((p) => ({ ...p, [k]: v }));
  const tradeNo = txn.trade_no || '';
  const bank = {
    name: settings?.bank_name || BANK.name,
    beneficiary: settings?.bank_beneficiary || BANK.beneficiary,
    transit: settings?.transit_no || BANK.transit,
    institution: settings?.institution_no || BANK.institution,
    account: settings?.account_no || BANK.account,
  };
  const money = (v: number | string) => (v !== '' && v != null ? formatCurrency(v) : '$');

  const printHtml = () => `
    <div style="text-align:center">
      <div style="display:flex;justify-content:center">${brandMarkHtml(!!settings?.logo_path, { color: BRAND, height: 96, version: settings?.updated_at })}</div>
      <div style="font-size:11px;color:#475569">${settings?.address || 'Unit-101, 218 Export Blvd, Mississauga, L5S 0A7, Ontario, Canada'}</div>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin:14px 0">
      <div style="background:${BRAND};color:#fff;font-weight:800;padding:6px 16px;border-radius:4px;font-size:18px">Commission Statement</div>
      <div style="font-weight:700">Date: ${f.date || ''}</div>
    </div>
    <p style="font-weight:700">Trade No: ${tradeNo}</p>
    <p style="font-weight:700;text-decoration:underline">Lawyer Details:</p>
    <ul style="line-height:1.9">
      <li>Name: ${f.lawyer_name || ''}</li>
      <li>Address: ${f.lawyer_address || ''}</li>
      <li>Mail ID: ${f.lawyer_mail || ''}</li>
      <li>Contact: ${f.lawyer_contact || ''}</li>
    </ul>
    <p style="font-weight:700;text-decoration:underline">Property Details:</p>
    <ul style="line-height:1.9">
      <li>Name: ${f.property || ''}</li>
      <li>Sale Price: ${money(f.sale_price)}</li>
      <li>Deposit Received: ${money(f.deposit_received)}</li>
      <li>Commission Payable: ${money(f.commission_payable)}</li>
      <li>Harmonized Sales Tax: ${money(f.hst)}</li>
      <li>Total Commission Payable: ${money(f.total_commission)}</li>
      <li>Amount payable to Client: ${money(f.amount_payable_client)}</li>
      <li>Amount Receivable to Brokerage: ${money(f.amount_receivable_brokerage)}</li>
      <li>Amount Received from Lawyer: ${money(f.amount_received_lawyer)}</li>
      <li>Balance Amount from Lawyer: ${money(f.balance_lawyer)}</li>
    </ul>
    <p style="font-weight:700;text-decoration:underline">Direct Deposit Information:</p>
    <ul style="line-height:1.9">
      <li>Name of Bank: ${bank.name}</li>
      <li>Beneficiary Name: ${bank.beneficiary}</li>
      <li>Transit: ${bank.transit}</li>
      <li>Institution Number: ${bank.institution}</li>
      <li>Account Number: ${bank.account}</li>
    </ul>
    <p style="font-size:11px;color:#475569">${WIRE_NOTE}</p>
    <div style="margin-top:30px">Signature: ______________________________</div>
    <div style="font-weight:700">Sai Ramesh Gollu @ Get Home Realty</div>
    <p style="text-align:center;margin-top:16px;font-weight:700">${DISCLAIMER}</p>
    <p style="text-align:center">Admin Department @ Get Home Realty</p>
  `;

  const lbl = { fontSize: 11.5, color: 'var(--text-2)', fontWeight: 600 };
  const inp = { border: '1px solid #e6e8ef', borderRadius: 6, padding: '5px 8px', width: '100%' };
  const Row = ({ label, k, type }: { label: string; k: keyof StatementForm; type?: string }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
      <span style={{ ...lbl, minWidth: 210 }}>{label}</span>
      <input type={type || 'text'} value={f[k]} onChange={(e) => set(k, e.target.value)} style={inp} />
    </div>
  );

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal lg" style={{ maxHeight: '92vh', overflowY: 'auto' }}>
        <button className="close" onClick={onClose}>✕</button>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div className="modal-h" style={{ margin: 0, border: 0, padding: 0 }}>Commission / Lawyer Statement</div>
          <button className="btn primary sm" onClick={() => printDoc(`Commission Statement - ${tradeNo}`, printHtml())}>🖨 Print / Save PDF</button>
        </div>

        <div style={{ textAlign: 'center', marginBottom: 12, display: 'grid', justifyItems: 'center' }}>
          <BrandMark color={BRAND} version={settings?.updated_at} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <span style={{ background: BRAND, color: '#fff', fontWeight: 700, padding: '4px 14px', borderRadius: 4 }}>Commission Statement</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span style={lbl}>Date</span><input type="date" value={f.date} onChange={(e) => set('date', e.target.value)} style={{ ...inp, width: 'auto' }} /></div>
        </div>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Trade No: {tradeNo}</div>

        <div className="modal-sub" style={{ marginTop: 0 }}>Lawyer Details</div>
        <Row label="Name" k="lawyer_name" />
        <Row label="Address" k="lawyer_address" />
        <Row label="Mail ID" k="lawyer_mail" />
        <Row label="Contact" k="lawyer_contact" />

        <div className="modal-sub">Property &amp; Commission</div>
        <Row label="Name" k="property" />
        <Row label="Sale Price ($)" k="sale_price" />
        <Row label="Deposit Received ($)" k="deposit_received" />
        <Row label="Commission Payable ($)" k="commission_payable" />
        <Row label="Harmonized Sales Tax ($)" k="hst" />
        <Row label="Total Commission Payable ($)" k="total_commission" />
        <Row label="Amount payable to Client ($)" k="amount_payable_client" />
        <Row label="Amount Receivable to Brokerage ($)" k="amount_receivable_brokerage" />
        <Row label="Amount Received from Lawyer ($)" k="amount_received_lawyer" />
        <Row label="Balance Amount from Lawyer ($)" k="balance_lawyer" />

        <div className="modal-sub">Direct Deposit Information</div>
        <div style={{ fontSize: 12.5, color: '#334155', lineHeight: 1.8, background: '#f8fafc', border: '1px solid #e6e8ef', borderRadius: 8, padding: 12 }}>
          <div>Name of Bank: <strong>{bank.name}</strong></div>
          <div>Beneficiary Name: <strong>{bank.beneficiary}</strong></div>
          <div>Transit: <strong>{bank.transit}</strong> · Institution Number: <strong>{bank.institution}</strong> · Account Number: <strong>{bank.account}</strong></div>
        </div>
        <p style={{ fontSize: 11.5, color: '#475569', lineHeight: 1.6, marginTop: 8 }}>{WIRE_NOTE}</p>

        <div style={{ marginTop: 16 }}>
          <div style={lbl}>Signature</div>
          <div style={{ borderBottom: '1px dotted #94a3b8', height: 24, maxWidth: 300, marginTop: 4 }} />
          <div style={{ fontWeight: 700, marginTop: 6 }}>Sai Ramesh Gollu @ Get Home Realty</div>
        </div>
        <p style={{ textAlign: 'center', marginTop: 14, fontWeight: 700, fontSize: 12 }}>{DISCLAIMER}</p>

        <div className="actions"><button className="btn ghost" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
