import { useRef } from 'react';
import { formatCurrency, commissionSummary, isListingType } from './format';
import { printDoc } from './printDoc';

const ink = '#0f172a';
const lineCol = '#475569';

// fill-in field rendered as an underlined value
const Fill = ({ value, w = 'auto', grow }) => (
  <span style={{ borderBottom: `1px solid ${lineCol}`, display: 'inline-block', minWidth: w, flex: grow ? 1 : undefined, padding: '0 4px', fontSize: 11.5, lineHeight: '18px' }}>{value || ' '}</span>
);
const Box = ({ on, label }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 10, fontSize: 11 }}>
    <span style={{ width: 11, height: 11, border: `1px solid ${ink}`, display: 'inline-block', textAlign: 'center', lineHeight: '10px', fontSize: 9 }}>{on ? '✓' : ''}</span>{label}
  </span>
);

export default function TradeSheetModal({ open, onClose, txn }) {
  const ref = useRef(null);
  if (!open) return null;

  const c = commissionSummary(txn.financial);
  const agents = (txn.financial && txn.financial.agents) || [];
  const team = (txn.team && txn.team.length) ? txn.team : (txn.agent ? [{ name: txn.agent }] : []);
  const brokerage = txn.brokerage || {};
  const clients = txn.clients || [];
  const buyer = clients[0] || {};
  const listing = isListingType(txn.type);

  const lbl = { fontSize: 11, fontWeight: 700 };
  const small = { fontSize: 9.5, color: '#64748b' };
  const row = { display: 'flex', alignItems: 'flex-end', gap: 6, margin: '5px 0' };
  const colBox = { border: `1px solid ${ink}`, padding: 10, width: '50%' };
  const cellH = { border: `1px solid ${ink}`, padding: '5px 6px', fontSize: 9.5, fontWeight: 700, textAlign: 'center', background: '#f3f5f9' };
  const cell = { border: `1px solid ${ink}`, padding: '6px', fontSize: 10.5, height: 22 };
  const moneyCell = { ...cell, textAlign: 'right' };

  const partyCol = (title, p, lawyer) => (
    <div style={colBox}>
      <div style={{ ...lbl, marginBottom: 4 }}>{title}</div>
      <div style={row}><Fill value={p.name} grow /></div>
      <div style={row}><Fill grow /></div>
      <div style={row}><span style={lbl}>Address</span><Fill grow /></div>
      <div style={row}><Fill grow /></div>
      <div style={row}><span style={lbl}>Tel</span><Fill value={p.phone} grow /></div>
      <div style={row}><span style={lbl}>Fax</span><Fill grow /></div>
      <div style={row}><span style={lbl}>Email Address</span><Fill value={p.email} grow /></div>
      <div style={row}><span style={lbl}>Lawyer</span><Fill value={lawyer?.name} grow /></div>
      <div style={row}><span style={lbl}>Tel. No.</span><Fill value={lawyer?.phone} grow /></div>
      <div style={row}><span style={lbl}>Email</span><Fill value={lawyer?.email} grow /></div>
    </div>
  );

  const commRows = [
    ['Total Receivable Commission:', c.commission, c.hst, c.total, true],
    ['Listing Brokerage:', null, null, null],
    [`Listing Salesperson #1   ${listing && team[0] ? team[0].name : ''}`, listing ? agents[0]?.agent?.commission : null, listing ? agents[0]?.agent?.hst : null, listing ? agents[0]?.agent?.total : null],
    [`Listing Salesperson #2   ${listing && team[1] ? team[1].name : ''}`, listing ? agents[1]?.agent?.commission : null, listing ? agents[1]?.agent?.hst : null, listing ? agents[1]?.agent?.total : null],
    ['Co-op Brokerage:', null, null, null],
    [`Salesperson #1   ${!listing && team[0] ? team[0].name : ''}`, !listing ? agents[0]?.agent?.commission : null, !listing ? agents[0]?.agent?.hst : null, !listing ? agents[0]?.agent?.total : null],
    [`Salesperson #2   ${!listing && team[1] ? team[1].name : ''}`, !listing ? agents[1]?.agent?.commission : null, !listing ? agents[1]?.agent?.hst : null, !listing ? agents[1]?.agent?.total : null],
    ['Referral Fee:', null, null, null],
    ['Referral Fee:', null, null, null],
    ['Real Estate Board:', null, null, null],
    ['Other:', null, null, null],
  ];

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal xl">
        <button className="close" onClick={onClose}>✕</button>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div className="modal-h" style={{ margin: 0, border: 0, padding: 0 }}>Trade Record Sheet — OREA Form 640</div>
          <button className="btn primary sm" onClick={() => printDoc(`Trade Sheet ${txn.trade_no}`, ref.current.innerHTML)}>🖨 Print / Save PDF</button>
        </div>

        <div ref={ref} style={{ color: ink }}>
          {/* ---------- PAGE 1 ---------- */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: `3px solid ${ink}`, paddingBottom: 6, marginBottom: 10 }}>
              <div>
                <span style={{ fontWeight: 800, fontSize: 18 }}>OREA</span>
                <span style={{ fontSize: 9, marginLeft: 6, color: '#475569' }}>Ontario Real Estate Association</span>
                <div style={{ fontWeight: 800, fontSize: 18, marginTop: 2 }}>Trade Record Sheet</div>
                <div style={{ ...small }}>Form 640 — for use in the Province of Ontario</div>
              </div>
              <table style={{ borderCollapse: 'collapse' }}><tbody>
                <tr><td style={{ ...cell, fontWeight: 700 }}>Sale No:</td><td style={{ ...cell, minWidth: 130 }}>{txn.trade_no}</td></tr>
                <tr><td style={{ ...cell, fontWeight: 700 }}>MLS® No:</td><td style={cell}>{txn.mls_num || ''}</td></tr>
              </tbody></table>
            </div>

            <div style={row}><Fill value="GET HOME REALTY" grow /><span style={small}>(Name of Brokerage)</span><span style={lbl}>Dated:</span><Fill w="160px" value={new Date().toLocaleDateString('en-CA')} /></div>
            <div style={row}><span style={lbl}>I,</span><Fill value={txn.agent} grow /><span style={small}>have today sold (leased, rented, exchanged, optioned):</span></div>
            <div style={row}><span style={lbl}>Property</span><Fill value={txn.property} grow /></div>

            <div style={{ display: 'flex', marginTop: 8 }}>
              {partyCol('SELLER/LANDLORD:', {}, null)}
              {partyCol('BUYER/TENANT:', buyer, { name: txn.lawyer_name, phone: txn.lawyer_phone, email: txn.lawyer_email })}
            </div>

            <div style={{ border: `1px solid ${ink}`, borderTop: 0, padding: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={lbl}>CO-OPERATING / LISTING BROKERAGE (if applicable):</span>
                <Box on={listing} label="Listing Brokerage" /><Box on={!listing} label="Co-operating Brokerage" />
              </div>
              <div style={row}><Fill value={brokerage.name} grow /></div>
              <div style={row}><span style={lbl}>Address</span><Fill value={brokerage.address} grow /><span style={lbl}>Tel. No.</span><Fill value={brokerage.phone} w="120px" /><span style={lbl}>Fax. No.</span><Fill w="100px" /></div>
              <div style={row}><span style={lbl}>Co-op Brokerage HST Number</span><Fill grow /></div>
            </div>

            <div style={{ border: `1px solid ${ink}`, borderTop: 0, padding: 10 }}>
              <div style={row}><span style={lbl}>REFERRAL BROKERAGE:</span><Fill grow /></div>
              <div style={row}><span style={lbl}>Address</span><Fill grow /><span style={lbl}>Tel. No.</span><Fill w="120px" /></div>
            </div>

            <div style={{ marginTop: 8 }}>
              <div style={row}><span style={lbl}>Total Consideration For Transaction $</span><Fill value={formatCurrency(txn.price).replace('$', '')} grow /></div>
              <div style={small}>(sale price, rent, exchange value, option price, fee (other))</div>
              <div style={row}><span style={lbl}>Completion Date</span><Fill value={txn.closing_date} grow /></div>
              <div style={row}><span style={lbl}>Deposit $</span><Fill value={txn.deposit ? formatCurrency(txn.deposit).replace('$', '') : ''} grow /><Box label="EFT" /><Box label="Cash" /><Box label="Cheque" /></div>
              <div style={row}><span style={lbl}>If cheque, payable to</span><Fill grow /><span style={small}>, in trust.</span></div>
              <div style={row}><span style={lbl}>Property Other Than Money Held In Trust</span><Fill grow /></div>
            </div>

            <div style={{ display: 'flex', gap: 16, marginTop: 10 }}>
              <div style={{ flex: 1 }}><span style={lbl}>Total Commission $</span><Fill value={formatCurrency(c.commission).replace('$', '')} grow /></div>
              <div style={{ flex: 1 }}><span style={lbl}>Total HST $</span><Fill value={formatCurrency(c.hst).replace('$', '')} grow /></div>
              <div style={{ flex: 1 }}><span style={lbl}>Total Receivable Comm $</span><Fill value={formatCurrency(c.total).replace('$', '')} grow /></div>
            </div>
            <div style={{ display: 'flex', gap: 16, marginTop: 24 }}>
              <div style={{ flex: 1, borderTop: `1px solid ${ink}`, ...small, paddingTop: 2 }}>(Salesperson/Broker/Broker of Record)</div>
              <div style={{ flex: 1, borderTop: `1px solid ${ink}`, ...small, paddingTop: 2 }}>(Salesperson/Broker/Broker of Record)</div>
            </div>
          </div>

          {/* ---------- PAGE 2 ---------- */}
          <div style={{ pageBreakBefore: 'always', marginTop: 28, paddingTop: 14, borderTop: '2px dashed #cbd5e1' }}>
            <div style={row}><span style={lbl}>Property</span><Fill value={txn.property} grow /><span style={lbl}>Sale No.:</span><Fill value={txn.trade_no} w="90px" /></div>
            <div style={row}><span style={lbl}>Seller/Landlord</span><Fill grow /><span style={lbl}>MLS® No.:</span><Fill value={txn.mls_num} w="90px" /></div>
            <div style={row}><span style={lbl}>Buyer/Tenant</span><Fill value={clients.map((x) => x.name).filter(Boolean).join(', ')} grow /></div>

            <div style={{ ...lbl, margin: '10px 0 6px' }}>THE FOLLOWING TO BE COMPLETED BY THE BROKERAGE:</div>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead><tr>
                <th style={{ ...cellH, textAlign: 'left', width: '34%' }}></th>
                <th style={cellH}>COMMISSION</th><th style={cellH}>HST</th><th style={cellH}>TOTAL</th><th style={cellH}>DATE PAID</th><th style={cellH}>CHEQUE NO.</th>
              </tr></thead>
              <tbody>
                {commRows.map((r, i) => (
                  <tr key={i}>
                    <td style={{ ...cell, fontWeight: r[0].endsWith(':') ? 700 : 400 }}>{r[0]}</td>
                    <td style={moneyCell}>{r[1] != null ? formatCurrency(r[1]) : ''}</td>
                    <td style={moneyCell}>{r[2] != null ? formatCurrency(r[2]) : ''}</td>
                    <td style={moneyCell}>{r[3] != null ? formatCurrency(r[3]) : ''}</td>
                    <td style={cell}></td><td style={cell}></td>
                  </tr>
                ))}
              </tbody>
            </table>

            {['Received deposit from (Salesperson/Broker)', 'Additional deposit from (Salesperson/Broker)', 'Deposited in Real Estate Trust Acc. (Amount)', 'Statement to Seller', 'Remitted to Seller/Buyer (Amount)', 'Transferred to Commission Trust (Amount)', 'Transferred Commission to Gen. Acct. (Amount)'].map((t) => (
              <div style={row} key={t}><span style={{ fontSize: 11 }}>{t}</span><Fill grow /><span style={lbl}>DATE</span><Fill w="90px" /></div>
            ))}
            <div style={row}><span style={{ fontSize: 11 }}>Additional Necessary Information</span><Fill grow /></div>

            <div style={{ marginTop: 14, fontSize: 11 }}>To the best of my knowledge and belief the above information is correct.</div>
            <div style={row}><span style={lbl}>DATED at</span><Fill w="150px" />Ontario, this <Fill w="50px" /> day of <Fill w="160px" />, 20<Fill w="40px" /></div>
            <div style={{ marginTop: 20, width: '60%', marginLeft: 'auto', borderTop: `1px solid ${ink}`, ...small, paddingTop: 2, textAlign: 'center' }}>(Signature of Broker of Record)</div>

            <div style={{ border: `1px solid ${ink}`, padding: 10, marginTop: 14 }}>
              <div style={lbl}>FOR OFFICE USE ONLY — COMMISSION TRUST AGREEMENT</div>
              <div style={{ fontSize: 10, color: '#475569', marginTop: 4, lineHeight: 1.5 }}>
                In consideration of the Salesperson(s) having successfully completed a trade in real estate on behalf of the Brokerage with respect to the property described in the foregoing Trade Record Sheet, all moneys received or receivable in connection with the transaction shall be receivable and held in trust, constituting a Commission Trust Agreement governed by the Office Policy.
              </div>
              <div style={{ display: 'flex', gap: 16, marginTop: 22 }}>
                <div style={{ flex: 1, borderTop: `1px solid ${ink}`, ...small, paddingTop: 2 }}>(Signature of Broker of Record/Manager)</div>
                <div style={{ flex: 1, borderTop: `1px solid ${ink}`, ...small, paddingTop: 2 }}>(Signature of Broker/Salesperson)</div>
              </div>
            </div>
          </div>
        </div>

        <div className="actions"><button className="btn ghost" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
