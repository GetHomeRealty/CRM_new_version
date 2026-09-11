import { useState } from 'react';
import { formatCurrency, commissionSummary } from './format';
import { printDoc } from './printDoc';
import BrandMark, { brandMarkHtml } from './BrandMark';
import { elementToPdfBase64 } from './pdf';
import { sendLawyerStatement } from '../lib/api';
import { useToast } from './toast';
import ConfirmDialog from './ConfirmDialog';
import { apiErrorMessage } from '../lib/apiError';
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
  const toast = useToast();
  /** The uploaded signature (data URI) — shown on the statement, printed, and in the emailed PDF. */
  const [signature, setSignature] = useState<string | null>(null);
  /** The name printed under the signature — editable, for whoever signs this statement. */
  const [signatory, setSignatory] = useState('Sai Ramesh Gollu');
  /** The Send dialog, and who it goes to — filled with the lawyer's Mail ID each time it opens. */
  const [sendOpen, setSendOpen] = useState(false);
  const [sendTo, setSendTo] = useState('');
  const [sending, setSending] = useState(false);
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
  /*
   * Every typed value is escaped on its way into the statement's markup. The statement is rendered
   * into this page to build the emailed PDF, and lawyer details are editable by agents — so a name
   * carrying markup must print as text, not run here. Plain text reads exactly as before.
   */
  const esc = (v: unknown): string => String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
  const money = (v: number | string) => esc(v !== '' && v != null ? formatCurrency(v) : '$');

  const printHtml = () => `
    <div style="text-align:center">
      <div style="display:flex;justify-content:center">${brandMarkHtml(!!settings?.logo_path, { color: BRAND, height: 96, version: settings?.updated_at })}</div>
      <div style="font-size:11px;color:#475569">${esc(settings?.address || 'Unit-101, 218 Export Blvd, Mississauga, L5S 0A7, Ontario, Canada')}</div>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin:14px 0">
      <div style="background:${BRAND};color:#fff;font-weight:800;padding:6px 16px;border-radius:4px;font-size:18px">Commission Statement</div>
      <div style="font-weight:700">Date: ${esc(f.date)}</div>
    </div>
    <p style="font-weight:700">Trade No: ${esc(tradeNo)}</p>
    <p style="font-weight:700;text-decoration:underline">Lawyer Details:</p>
    <ul style="line-height:1.9">
      <li>Name: ${esc(f.lawyer_name)}</li>
      <li>Address: ${esc(f.lawyer_address)}</li>
      <li>Mail ID: ${esc(f.lawyer_mail)}</li>
      <li>Contact: ${esc(f.lawyer_contact)}</li>
    </ul>
    <p style="font-weight:700;text-decoration:underline">Property Details:</p>
    <ul style="line-height:1.9">
      <li>Name: ${esc(f.property)}</li>
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
      <li>Name of Bank: <strong style="color:${BRAND}">${esc(bank.name)}</strong></li>
      <li>Beneficiary Name: <strong style="color:${BRAND}">${esc(bank.beneficiary)}</strong></li>
      <li>Transit: <strong style="color:${BRAND}">${esc(bank.transit)}</strong></li>
      <li>Institution Number: <strong style="color:${BRAND}">${esc(bank.institution)}</strong></li>
      <li>Account Number: <strong style="color:${BRAND}">${esc(bank.account)}</strong></li>
    </ul>
    <p style="font-size:11px;color:#475569">${WIRE_NOTE}</p>
    <div style="margin-top:30px">Signature: ${signature ? `<img src="${esc(signature)}" alt="Signature" style="max-height:48px;max-width:220px;vertical-align:bottom" />` : '______________________________'}</div>
    <div style="font-weight:700">${esc(signatory)}</div>
    <p style="text-align:center;margin-top:16px;font-weight:700">${DISCLAIMER}</p>
    <p style="text-align:center">Admin Department @ Get Home Realty</p>
  `;

  const onSignature = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast('Choose an image file of the signature (PNG or JPEG).', 'bad'); return; }
    const reader = new FileReader();
    reader.onload = () => setSignature(reader.result as string);
    reader.readAsDataURL(file);
  };

  const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

  /*
   * Email the statement to the lawyer as a PDF — the same document Print produces, signature
   * included — rendered off-screen the way the Notice of Sale builds its attachment.
   */
  const send = async (to: string) => {
    const recipient = to.trim();
    setSendOpen(false);
    if (!isEmail(recipient)) { toast('Enter a valid email address to send to.', 'bad'); return; }
    setSending(true);
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:760px;background:#ffffff;padding:16px;'
      + 'font-family:Inter,Arial,sans-serif;color:#0f172a;font-size:13px;line-height:1.5;';
    holder.innerHTML = printHtml();
    document.body.appendChild(holder);
    try {
      const pdf = await elementToPdfBase64(holder);
      const r = await sendLawyerStatement(txn.id, recipient, {
        pdf, filename: `Commission Statement - ${tradeNo}.pdf`, lawyer_name: f.lawyer_name,
      });
      toast(r.message || `Sent to ${recipient}`, 'ok');
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not send the statement'), 'bad');
    } finally {
      holder.remove();
      setSending(false);
    }
  };

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
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn primary sm" onClick={() => printDoc(`Commission Statement - ${tradeNo}`, printHtml())}>🖨 Print / Save PDF</button>
            <button className="btn primary sm" disabled={sending} onClick={() => { setSendTo(f.lawyer_mail || ''); setSendOpen(true); }}>
              {sending ? 'Sending…' : '✉ Send Email'}
            </button>
          </div>
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
          {/* The values in the brand red, so the numbers a lawyer has to copy stand out from their labels. */}
          <div>Name of Bank: <strong style={{ color: BRAND }}>{bank.name}</strong></div>
          <div>Beneficiary Name: <strong style={{ color: BRAND }}>{bank.beneficiary}</strong></div>
          <div>Transit: <strong style={{ color: BRAND }}>{bank.transit}</strong> · Institution Number: <strong style={{ color: BRAND }}>{bank.institution}</strong> · Account Number: <strong style={{ color: BRAND }}>{bank.account}</strong></div>
        </div>
        <p style={{ fontSize: 11.5, color: '#475569', lineHeight: 1.6, marginTop: 8 }}>{WIRE_NOTE}</p>

        <div style={{ marginTop: 16 }}>
          <div style={lbl}>Signature</div>
          {signature
            ? <img src={signature} alt="Signature" style={{ maxHeight: 48, maxWidth: 300, marginTop: 4, display: 'block' }} />
            : <div style={{ borderBottom: '1px dotted #94a3b8', height: 24, maxWidth: 300, marginTop: 4 }} />}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            <label className="btn ghost sm" style={{ cursor: 'pointer' }}>{signature ? 'Replace Signature' : '📤 Upload Signature'}
              <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { onSignature(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
            {signature && <button className="row-rm" title="Remove the signature" onClick={() => setSignature(null)}>🗑️</button>}
          </div>
          <input value={signatory} onChange={(e) => setSignatory(e.target.value)} aria-label="Name under the signature"
            title="Click to edit the name" placeholder="Name"
            style={{ ...inp, fontWeight: 700, marginTop: 6, maxWidth: 300, display: 'block' }} />
        </div>
        <p style={{ textAlign: 'center', marginTop: 14, fontWeight: 700, fontSize: 12 }}>{DISCLAIMER}</p>

        <div className="actions"><button className="btn ghost" onClick={onClose}>Close</button></div>
      </div>

      {/* The address, asked for when Send is pressed — built inline so the input re-renders as it
          is typed (useConfirm snapshots its options; see TradeSheetModal). */}
      <ConfirmDialog
        confirm={sendOpen ? {
          title: 'Send the Lawyer Statement',
          message: `The Commission Statement for ${txn.property || `Trade #${tradeNo}`} is attached to the email as a PDF.`,
          body: (
            <label style={{ display: 'block', marginTop: 10, fontSize: 13 }}>
              Send to
              <input className="inp" type="email" autoFocus value={sendTo} onChange={(e) => setSendTo(e.target.value)}
                placeholder="lawyer@example.com" style={{ width: '100%', marginTop: 4 }} />
            </label>
          ),
          confirmLabel: 'Send',
          variant: 'primary' as const,
          confirmDisabled: !isEmail(sendTo),
          onConfirm: () => { void send(sendTo); },
        } : null}
        onClose={() => setSendOpen(false)}
      />
    </div>
  );
}
