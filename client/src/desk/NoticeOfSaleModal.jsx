import { useEffect, useRef, useState } from 'react';
import { formatCurrency } from './format';
import { getDocuments } from '../lib/api';
import { printDoc } from './printDoc';

const BRAND = '#c8102e';

const MANDATORY_DOCS = [
  { label: 'Agreement of Purchase and Sale', keys: ['agreement of purchase', 'aps', 'agreement to lease'] },
  { label: 'Co-op', keys: ['co-op', 'coop'] },
  { label: 'Schedule B', keys: ['schedule b'] },
  { label: 'Deposit Receipt', keys: ['deposit receipt', 'deposit slip'] },
  { label: 'MLS Data Information', keys: ['mls data'] },
  { label: 'MLS (Copy of Listing)', keys: ['mls'], exclude: ['mls data'] },
  { label: 'FINTRAC', keys: ['fintrac'] },
  { label: 'Waiver (if conditional offer)', keys: ['waiver'] },
  { label: 'Amendment (if any changes in APS)', keys: ['amendment'] },
  { label: 'Trade Sheet', keys: ['trade sheet'] },
  { label: 'Buyer Representation', keys: ['buyer representation', 'tenant representation', 'representation'] },
];

function isValid(docs, item) {
  return docs.some((d) => {
    const t = (d.title || '').toLowerCase();
    if (item.exclude && item.exclude.some((x) => t.includes(x))) return false;
    return item.keys.some((k) => t.includes(k)) && d.validation === 'Valid';
  });
}

const ORD = ['', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'];
const ordinal = (i) => (i === 0 ? 'Salesperson' : `${ORD[i] || `${i + 1}th`} Salesperson`);

// ---- shared inline styles (carry into the print window) ----
const card = { border: '1px solid #e6e8ef', borderRadius: 14, padding: 20, marginBottom: 16 };
const label = { fontSize: 11.5, color: '#334155', fontWeight: 600, marginBottom: 6, display: 'block' };
const boxField = { background: '#f9fafb', border: '1px solid #e6e8ef', borderRadius: 8, padding: '9px 11px', fontSize: 13, color: '#0f172a', minHeight: 38 };
const sectionTitle = { fontSize: 13, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', margin: '4px 0 12px' };
const grid2 = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 };
const grid3 = { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14, marginBottom: 12 };
const divider = { borderTop: '1px solid #eef0f5', margin: '6px 0 16px' };

function Field({ label: lbl, value }) {
  return (
    <div>
      <span style={label}>{lbl}</span>
      <div style={boxField}>{value || ' '}</div>
    </div>
  );
}

export default function NoticeOfSaleModal({ open, onClose, txn }) {
  const ref = useRef(null);
  const [docs, setDocs] = useState([]);

  useEffect(() => {
    if (!open) return;
    getDocuments(txn.id).then((d) => setDocs(d.documents || [])).catch(() => setDocs([]));
  }, [open, txn.id]);

  if (!open) return null;

  const brokerage = txn.brokerage || {};
  const clients = txn.clients || [];
  const team = (txn.team && txn.team.length) ? txn.team : (txn.agent ? [{ name: txn.agent, split: 100 }] : []);
  const commRate = txn.comm_type === 'Fixed' ? formatCurrency(txn.comm_value) : `${txn.comm_value || txn.comm_pct || 0}%`;
  const buyers = clients.map((c) => c.name).filter(Boolean).join(', ');

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal lg">
        <button className="close" onClick={onClose}>✕</button>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div className="modal-h" style={{ margin: 0, border: 0, padding: 0 }}>Notice of Sale</div>
          <button className="btn primary sm" onClick={() => printDoc(`Notice of Sale ${txn.trade_no}`, ref.current.innerHTML)}>🖨 Print / Save PDF</button>
        </div>

        <div ref={ref}>
          {/* Letterhead */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 22, fontWeight: 800, color: BRAND, letterSpacing: '-0.5px' }}>GET<span style={{ color: '#0f172a' }}>&#9730;</span>HOME REALTY</div>
              <div style={{ fontSize: 10, color: '#64748b', fontStyle: 'italic' }}>"A Tradition of Trust" — Brokerage</div>
            </div>
            <div style={{ color: BRAND, fontSize: 22, fontWeight: 700 }}>Notice of Sale</div>
          </div>

          {/* Main details card */}
          <div style={card}>
            <div style={grid2}>
              <Field label="Property Address" value={txn.property} />
              <Field label="Transaction Type" value={txn.type} />
            </div>
            <div style={grid2}>
              <Field label="Purchase Price" value={formatCurrency(txn.price)} />
              <Field label="Sold Date" value={txn.offer_date} />
            </div>
            <div style={grid2}>
              <Field label="Closing Date" value={txn.closing_date} />
              <Field label="MLS Number" value={txn.mls_num} />
            </div>
            <div style={{ marginBottom: 4 }}>
              <Field label="Buyers (Client Names)" value={buyers || '—'} />
              <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 4, fontStyle: 'italic' }}>Auto-filled from Client Information on the transaction.</div>
            </div>
            <div style={{ marginTop: 14 }}>
              <Field label="Sellers" value="" />
            </div>

            <div style={divider} />
            <div style={sectionTitle}>Lawyer Information</div>
            <div style={{ marginBottom: 14 }}><Field label="Name" value={txn.lawyer_name} /></div>
            <div style={grid2}>
              <Field label="Phone" value={txn.lawyer_phone} />
              <Field label="Email" value={txn.lawyer_email} />
            </div>
            <div style={grid2}>
              <Field label="Listing Brokerage Name" value={brokerage.name || 'GET HOME REALTY'} />
              <Field label="Salesperson Name" value={team[0]?.name} />
            </div>

            <div style={divider} />
            <div style={sectionTitle}>Activity</div>
            {team.map((m, i) => (
              <div style={grid3} key={i}>
                <Field label={`Name of ${ordinal(i)}${i > 0 ? ' (if any)' : ''}`} value={m.name} />
                <Field label="Commission in %/$" value={commRate} />
                <Field label="Split in %" value={`${m.split}%`} />
              </div>
            ))}
            {team.length === 0 && <div style={{ fontSize: 12, color: '#64748b' }}>No salespersons assigned (set the agent / Team Split).</div>}
          </div>

          {/* Documents & Signatures card */}
          <div style={card}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 14 }}>Documents &amp; Signatures</div>
            <div style={sectionTitle}>Mandatory Sale Documents</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
              {MANDATORY_DOCS.map((item) => {
                const checked = isValid(docs, item);
                return (
                  <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13 }}>
                    <span style={{
                      width: 16, height: 16, borderRadius: 4, flexShrink: 0,
                      border: `1.5px solid ${checked ? '#2563eb' : '#94a3b8'}`,
                      background: checked ? '#2563eb' : '#fff',
                      color: '#fff', fontSize: 11, fontWeight: 700, lineHeight: '14px', textAlign: 'center',
                    }}>{checked ? '✓' : ''}</span>
                    {item.label}
                  </div>
                );
              })}
            </div>
            <div style={{ background: '#f9fafb', border: '1px solid #eef0f5', borderRadius: 8, padding: '12px 14px', fontStyle: 'italic', fontSize: 12.5, color: '#475569', marginBottom: 18 }}>
              Information provided on this document is accurate to the best of my knowledge and belief.
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '22px 24px' }}>
              {(team.length ? team : [{ name: '' }]).map((m, i) => (
                <div key={i}>
                  <span style={label}>Name</span>
                  <div style={{ fontSize: 14, fontWeight: 600, paddingBottom: 6, borderBottom: '1px solid #cbd5e1', marginBottom: 12 }}>{m.name || ' '}</div>
                  <span style={label}>Date (dd/mm/yyyy)</span>
                  <div style={{ ...boxField, marginBottom: 12 }}>&#160;</div>
                  <span style={label}>Signature</span>
                  <div style={{ borderBottom: '1px dotted #94a3b8', height: 28 }} />
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="actions"><button className="btn ghost" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
