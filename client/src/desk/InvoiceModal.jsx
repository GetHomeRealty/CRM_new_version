import { useRef } from 'react';
import { formatCurrency, commissionSummary } from './format';
import { printDoc } from './printDoc';

const BRAND = '#c8102e';

const COMPANY = {
  name: 'GetHomeRealty Inc',
  address: '218 Export Blvd, Unit – 101, Mississauga, ON, L5S 0A7',
  phone: '+1 (905) 565-9933',
  email: 'Commissionpayouts@gethomerealty.ca',
  hst: '786493262RT0001',
  broker: 'Sai Venkata Ramesh Gollu',
};

const isoPlus = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

export default function InvoiceModal({ open, onClose, txn }) {
  const ref = useRef(null);
  if (!open) return null;

  const c = commissionSummary(txn.financial);
  const brokerage = txn.brokerage || {};
  const coopAgent = (brokerage.agents && brokerage.agents[0]) || txn.agent || '-';
  const invNo = `INV-${String(txn.trade_no).padStart(6, '0')}`;

  const dCell = { border: '1px solid #e6e8ef', padding: '7px 10px', fontSize: 12 };
  const dLabel = { ...dCell, background: '#fafbfd', color: '#64748b', textAlign: 'right', whiteSpace: 'nowrap' };
  const dVal = { ...dCell, textAlign: 'right' };
  const lblBlock = { fontSize: 11, fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '.03em', marginTop: 12 };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal lg">
        <button className="close" onClick={onClose}>✕</button>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div className="modal-h" style={{ margin: 0, border: 0, padding: 0 }}>Invoice</div>
          <button className="btn primary sm" onClick={() => printDoc(invNo, ref.current.innerHTML)}>🖨 Print / Save PDF</button>
        </div>

        <div ref={ref} style={{ fontSize: 13, color: '#0f172a' }}>
          {/* Letterhead */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: BRAND, letterSpacing: '-0.5px' }}>
              GET<span style={{ color: '#0f172a' }}>&#9730;</span>HOME REALTY
              <div style={{ fontSize: 10, color: '#64748b', fontStyle: 'italic', fontWeight: 400 }}>"A Tradition of Trust" — Brokerage</div>
            </div>
            <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: '1px' }}>INVOICE</div>
          </div>

          {/* Company + details table */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, marginBottom: 14 }}>
            <div style={{ fontSize: 12, lineHeight: 1.7 }}>
              <div style={{ fontWeight: 700 }}>{COMPANY.name}</div>
              <div style={{ color: '#475569' }}>{COMPANY.address}</div>
              <div style={{ color: '#475569' }}>Phone: {COMPANY.phone}</div>
              <div style={{ color: '#475569' }}>Email: {COMPANY.email}</div>
              <div style={{ display: 'inline-block', marginTop: 10, border: `1px solid ${BRAND}`, color: BRAND, fontWeight: 700, padding: '5px 10px', borderRadius: 6 }}>
                Balance Due : {formatCurrency(c.total)}
              </div>
            </div>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <tbody>
                <tr><td style={dLabel}>Invoice Number:</td><td style={{ ...dVal, fontWeight: 700 }}>{invNo}</td></tr>
                <tr><td style={dLabel}>Invoice Date:</td><td style={dVal}>{isoPlus(0)}</td></tr>
                <tr><td style={dLabel}>Due Date:</td><td style={dVal}>{isoPlus(3)}</td></tr>
                <tr><td style={dLabel}>Trade No.:</td><td style={dVal}>{txn.trade_no}</td></tr>
                <tr><td style={dLabel}>Deal Name:</td><td style={dVal}>{txn.property}</td></tr>
                <tr><td style={dLabel}>Purchase Price:</td><td style={{ ...dVal, fontWeight: 700 }}>{formatCurrency(txn.price)}</td></tr>
                <tr><td style={dLabel}>Transaction Type:</td><td style={dVal}>{txn.type}</td></tr>
              </tbody>
            </table>
          </div>

          <div style={{ borderTop: '1px solid #eef0f5', paddingTop: 10, marginBottom: 6 }}>
            <strong>Subject: </strong>Co-op Commission for {txn.property}
          </div>

          {/* Customer / shipping */}
          <div style={lblBlock}>Customer:</div>
          <div style={{ fontWeight: 700, fontSize: 14 }}>{brokerage.name || '-'}</div>
          <div style={{ color: '#475569', lineHeight: 1.7 }}>
            <div>{brokerage.address || '-'}</div>
            <div>{brokerage.phone || '-'}</div>
            <div>{brokerage.email || brokerage.agent_email || '-'}</div>
          </div>
          <div style={lblBlock}>Shipping Address:</div>
          <div style={{ color: '#475569' }}>{brokerage.address || '-'}</div>

          <div style={lblBlock}>Agent Details</div>
          <div style={{ color: '#64748b', fontSize: 11.5 }}>Sales Person (Co-op Agent):</div>
          <div style={{ marginBottom: 6 }}>{coopAgent}</div>
          <div style={{ color: '#64748b', fontSize: 11.5 }}>Listing Agent / Sales Person:</div>
          <div>{txn.agent || '-'}</div>

          {/* Line items */}
          <table style={{ borderCollapse: 'collapse', width: '100%', marginTop: 16 }}>
            <thead>
              <tr>
                <th style={{ border: '1px solid #e6e8ef', background: '#f3f5f9', padding: '8px 10px', textAlign: 'left', fontSize: 11.5 }}>DESCRIPTION</th>
                <th style={{ border: '1px solid #e6e8ef', background: '#f3f5f9', padding: '8px 10px', textAlign: 'right', fontSize: 11.5, width: 180 }}>AMOUNT (CAD)</th>
              </tr>
            </thead>
            <tbody>
              <tr><td style={{ border: '1px solid #e6e8ef', padding: '8px 10px', fontWeight: 600 }}>Co-op Commission</td><td style={{ border: '1px solid #e6e8ef', padding: '8px 10px', textAlign: 'right', fontWeight: 600 }}>{formatCurrency(c.commission)}</td></tr>
              <tr><td style={{ border: '1px solid #e6e8ef', padding: '8px 10px', fontWeight: 600 }}>HST(13)</td><td style={{ border: '1px solid #e6e8ef', padding: '8px 10px', textAlign: 'right', fontWeight: 600 }}>{formatCurrency(c.hst)}</td></tr>
            </tbody>
          </table>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
            <table style={{ borderCollapse: 'collapse', minWidth: 280 }}>
              <tbody>
                <tr><td style={{ padding: '4px 10px', color: '#475569' }}>Sub Total</td><td style={{ padding: '4px 10px', textAlign: 'right', fontWeight: 600 }}>{formatCurrency(c.total)}</td></tr>
                <tr><td style={{ padding: '4px 10px', color: '#475569' }}>Discount</td><td style={{ padding: '4px 10px', textAlign: 'right' }}>{formatCurrency(0)}</td></tr>
                <tr><td style={{ padding: '8px 10px', fontWeight: 800, borderTop: '2px solid #0f172a' }}>GRAND TOTAL</td><td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 800, borderTop: '2px solid #0f172a' }}>{formatCurrency(c.total)}</td></tr>
              </tbody>
            </table>
          </div>

          {/* Footer */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginTop: 20, borderTop: '1px solid #eef0f5', paddingTop: 14, fontSize: 11.5, color: '#475569' }}>
            <div>
              <div style={{ fontWeight: 700, color: '#334155' }}>Customer Notes:</div>
              <div style={{ marginBottom: 12 }}>Thank you for the payment. You just made our day.</div>
              <div style={{ fontWeight: 700, color: '#334155' }}>Deposit Instructions:</div>
              <div>Beneficiary Bank Account Detail:</div>
              <div>Beneficiary Name : GET HOME REALTY INC</div>
              <div>Bank Name: TD</div>
              <div>Bank Transit Number: 21222</div>
              <div>Account Number: 5086185</div>
              <div>Institution Number: 004</div>
            </div>
            <div>
              <div style={{ fontWeight: 700, color: '#334155' }}>Terms &amp; Conditions:</div>
              <div style={{ marginBottom: 18 }}>-</div>
              <div style={{ fontWeight: 700, color: '#334155' }}>Acknowledged by:</div>
              <div style={{ borderBottom: '1px dotted #94a3b8', height: 24, marginBottom: 4 }} />
              <div style={{ fontStyle: 'italic' }}>(Broker Manager / Broker of Record): <strong>{COMPANY.broker}</strong></div>
            </div>
          </div>

          <div style={{ marginTop: 14, fontWeight: 700, fontSize: 12 }}>HST Number : {COMPANY.hst}</div>
          <div style={{ marginTop: 12, textAlign: 'center', fontStyle: 'italic', fontSize: 11, color: '#94a3b8', borderTop: '1px solid #eef0f5', paddingTop: 8 }}>
            This is a system-generated invoice from {COMPANY.name}.
          </div>
        </div>

        <div className="actions"><button className="btn ghost" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
