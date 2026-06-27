import { useEffect, useRef, useState } from 'react';
import { formatCurrency, isListingFinancialType } from './format';
import { getDocuments, getNoticeOfSale, saveNoticeOfSale, sendNoticeOfSale } from '../lib/api';
import { printDoc } from './printDoc';
import { useToast } from './toast';

const BRAND = '#c8102e';

// Mandatory Documents tailored to the transaction type — drawn solely from the
// Legal & Documentation checklist. Lease / business variants swap labels.
function mandatoryDocsFor(type) {
  const t = (type || '').toLowerCase();
  const isLease = t.includes('lease');
  const isBusiness = t.includes('business');
  const list = [
    { label: isLease ? 'Agreement to Lease' : 'Agreement of Purchase and Sale', keys: ['agreement of purchase', 'aps', 'agreement to lease'] },
    { label: 'Co-op', keys: ['co-op', 'coop'] },
    { label: 'Schedule B', keys: ['schedule b'] },
    { label: isLease ? 'First & Last Month Deposit Receipt' : 'Deposit Receipt', keys: ['deposit receipt', 'deposit slip'] },
    { label: 'MLS Data Information', keys: ['mls data'] },
    { label: 'MLS (Copy of Listing)', keys: ['mls'], exclude: ['mls data'] },
    { label: 'FINTRAC', keys: ['fintrac'] },
    { label: 'Waiver (if conditional offer)', keys: ['waiver'] },
    { label: 'Amendment (if any changes in APS)', keys: ['amendment'] },
    { label: 'Trade Sheet', keys: ['trade sheet'] },
    { label: isLease ? 'Tenant Representation' : 'Buyer Representation', keys: ['buyer representation', 'tenant representation', 'representation'] },
  ];
  if (isBusiness) list.push({ label: 'Asset List / Chattels', keys: ['asset list', 'chattels'] });
  return list;
}

function isValid(docs, item) {
  return docs.some((d) => {
    const t = (d.title || '').toLowerCase();
    if (item.exclude && item.exclude.some((x) => t.includes(x))) return false;
    return item.keys.some((k) => t.includes(k)) && d.validation === 'Valid';
  });
}

const ORD = ['', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'];
const ordinal = (i) => (i === 0 ? 'Salesperson' : `${ORD[i] || `${i + 1}th`} Salesperson`);

const todayISO = () => new Date().toISOString().slice(0, 10);
const fmtDMY = (iso) => {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return (d && m && y) ? `${d}/${m}/${y}` : iso;
};

// ---- shared inline styles (carry into the print window) ----
const card = { border: '1px solid #e6e8ef', borderRadius: 14, padding: 20, marginBottom: 16 };
const label = { fontSize: 11.5, color: '#334155', fontWeight: 600, marginBottom: 6, display: 'block' };
const boxField = { background: '#f9fafb', border: '1px solid #e6e8ef', borderRadius: 8, padding: '9px 11px', fontSize: 13, color: '#0f172a', minHeight: 38 };
const boxInput = { ...boxField, width: '100%', display: 'block' };
const sectionTitle = { fontSize: 13, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', margin: '4px 0 12px' };
const grid2 = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 };
const grid3 = { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14, marginBottom: 12 };
const divider = { borderTop: '1px solid #eef0f5', margin: '6px 0 16px' };

function Field({ label: lbl, value }) {
  return (
    <div>
      <span style={label}>{lbl}</span>
      <div style={boxField}>{value || ' '}</div>
    </div>
  );
}

export default function NoticeOfSaleModal({ open, onClose, txn }) {
  const toast = useToast();
  const ref = useRef(null);
  const [docs, setDocs] = useState([]);

  const brokerage = txn.brokerage || {};
  const clients = txn.clients || [];
  const team = (txn.team && txn.team.length) ? txn.team : (txn.agent ? [{ name: txn.agent, split: 100 }] : []);
  const commRate = txn.comm_type === 'Fixed' ? formatCurrency(txn.comm_value) : `${txn.comm_value || txn.comm_pct || 0}%`;

  // Salesperson(s) = Listing Agent Name(s) from Listing Brokerage Information.
  const listingAgents = (brokerage.agents || []).filter(Boolean);
  const salespersons = listingAgents.length ? listingAgents : team.map((m) => m.name).filter(Boolean);

  // Which party the brokerage's clients represent:
  //  - Listing-side types (Sale/Lease Listings + Business Sale): clients are the
  //    SELLERS, so the Buyers field is editable.
  //  - Deal-side types (Buying / Lease / Pre-construction / Referral): clients are
  //    the BUYERS, so the Sellers field is editable.
  const buyersEditable = isListingFinancialType(txn.type);
  const sellersEditable = !buyersEditable;
  const clientNamesStr = clients.map((c) => c.name).filter(Boolean).join(', ');

  // ---- editable Notice of Sale state (single comma-separated fields, as before) ----
  const [buyers, setBuyers] = useState(buyersEditable ? '' : clientNamesStr);
  const [sellers, setSellers] = useState(sellersEditable ? '' : clientNamesStr);
  const [agents, setAgents] = useState({}); // name => { signature(dataURI), signed_date, sent_at }
  const [sentAt, setSentAt] = useState(null);
  const [saving, setSaving] = useState(false);

  const applyNotice = (n) => {
    const sa=(arr) => (arr && arr.length) ? arr.join(', ') : '';
    if (buyersEditable) {
      setBuyers(sa(n.buyers));
      setSellers(clientNamesStr || sa(n.sellers));
    } else {
      setSellers(sa(n.sellers));
      setBuyers(clientNamesStr || sa(n.buyers));
    }
    setAgents(n.agents || {});
    setSentAt(n.sent_at || null);
  };

  useEffect(() => {
    if (!open) return;
    getDocuments(txn.id).then((d) => setDocs(d.documents || [])).catch(() => setDocs([]));
    getNoticeOfSale(txn.id).then(applyNotice).catch(() => {});
  }, [open, txn.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  const mandatory = mandatoryDocsFor(txn.type);

  // ---- signatures ----
  const setAgentDate = (name, v) => setAgents((a) => ({ ...a, [name]: { ...(a[name] || {}), signed_date: v } }));
  const onSig = (name, file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setAgents((a) => ({ ...a, [name]: { ...(a[name] || {}), signature: reader.result, signed_date: a[name]?.signed_date || todayISO() } }));
    reader.readAsDataURL(file);
  };
  const clearSig = (name) => setAgents((a) => ({ ...a, [name]: { ...(a[name] || {}), signature: null } }));

  const toArr = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
  const persist = async () => {
    const res = await saveNoticeOfSale(txn.id, { buyers: toArr(buyers), sellers: toArr(sellers), date: null, agents });
    applyNotice(res);
    return res;
  };
  const save = async () => {
    setSaving(true);
    try { await persist(); toast('Notice of Sale saved', 'ok'); }
    catch { toast('Could not save Notice of Sale', 'bad'); }
    finally { setSaving(false); }
  };
  const doSend = async (names) => {
    if (!names.length) { toast('No salesperson to send to', 'info'); return; }
    setSaving(true);
    try {
      await persist();
      const res = await sendNoticeOfSale(txn.id, names);
      applyNotice(res);
      toast(names.length === 1 ? `Resent to ${names[0]}` : `Notice sent to ${names.length} salesperson(s)`, 'ok');
    } catch { toast('Could not send', 'bad'); }
    finally { setSaving(false); }
  };

  // Print: replace live inputs with styled text (so typed values + dd/mm/yyyy dates
  // survive serialization) and drop edit-only controls — keeping the original look.
  const printNow = () => {
    const root = ref.current;
    if (!root) return;
    root.querySelectorAll('input').forEach((el) => el.setAttribute('value', el.value));
    const clone = root.cloneNode(true);
    clone.querySelectorAll('[data-noprint]').forEach((el) => el.remove());
    clone.querySelectorAll('input').forEach((el) => {
      const div = document.createElement('div');
      div.style.cssText = 'background:#f9fafb;border:1px solid #e6e8ef;border-radius:8px;padding:9px 11px;font-size:13px;color:#0f172a;min-height:38px';
      div.textContent = el.getAttribute('type') === 'date' ? fmtDMY(el.getAttribute('value')) : (el.getAttribute('value') || ' ');
      el.replaceWith(div);
    });
    printDoc(`Notice of Sale ${txn.trade_no}`, clone.innerHTML);
  };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal lg" style={{ maxHeight: '92vh', overflowY: 'auto' }}>
        <button className="close" onClick={onClose}>✕</button>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 8, flexWrap: 'wrap' }}>
          <div className="modal-h" style={{ margin: 0, border: 0, padding: 0 }}>Notice of Sale</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn ghost sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : '💾 Save'}</button>
            <button className="btn ghost sm" onClick={() => doSend(salespersons)} disabled={saving || !salespersons.length}>✉ Send</button>
            <button className="btn primary sm" onClick={printNow}>🖨 Print / Save PDF</button>
          </div>
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

            <div style={{ marginBottom: 14 }}>
              <span style={label}>Buyers (Client Names)</span>
              {buyersEditable
                ? <input data-noprint-style style={boxInput} value={buyers} onChange={(e) => setBuyers(e.target.value)} placeholder="Enter buyer name(s), comma separated" />
                : <div style={boxField}>{buyers || '—'}</div>}
              {!buyersEditable && <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 4, fontStyle: 'italic' }}>Auto-filled from Client Information on the transaction.</div>}
            </div>
            <div style={{ marginBottom: 4 }}>
              <span style={label}>Sellers</span>
              {sellersEditable
                ? <input data-noprint-style style={boxInput} value={sellers} onChange={(e) => setSellers(e.target.value)} placeholder="Enter seller name(s), comma separated" />
                : <div style={boxField}>{sellers || '—'}</div>}
              {!sellersEditable && <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 4, fontStyle: 'italic' }}>Auto-filled from Client Information on the transaction.</div>}
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
              <Field label="Salesperson Name" value={salespersons.join(', ')} />
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
            <div style={sectionTitle}>Mandatory Documents</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
              {mandatory.map((item) => {
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

            {sentAt && <div data-noprint className="help" style={{ marginBottom: 10 }}>Last sent for signature: {new Date(sentAt).toLocaleString()}</div>}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '22px 24px' }}>
              {(salespersons.length ? salespersons : ['']).map((name, i) => {
                const a = agents[name] || {};
                const needsResend = !!sentAt && !!name && !a.signature;
                return (
                  <div key={i}>
                    <span style={label}>Name</span>
                    <div style={{ fontSize: 14, fontWeight: 600, paddingBottom: 6, borderBottom: '1px solid #cbd5e1', marginBottom: 12 }}>{name || ' '}</div>
                    <span style={label}>Date (dd/mm/yyyy)</span>
                    <input type="date" style={{ ...boxInput, marginBottom: 12 }} value={a.signed_date ? String(a.signed_date).slice(0, 10) : ''} onChange={(e) => setAgentDate(name, e.target.value)} />
                    <span style={label}>Signature</span>
                    {a.signature
                      ? <img src={a.signature} alt="signature" style={{ maxHeight: 48, maxWidth: '100%' }} />
                      : <div style={{ borderBottom: '1px dotted #94a3b8', height: 28 }} />}
                    {name && (
                      <div data-noprint style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                        <label className="btn ghost sm" style={{ cursor: 'pointer' }}>{a.signature ? 'Replace Signature' : 'Upload Signature'}
                          <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { onSig(name, e.target.files[0]); e.target.value = ''; }} />
                        </label>
                        {a.signature && <button className="row-rm" onClick={() => clearSig(name)}>🗑️</button>}
                        {needsResend && <button className="btn ghost sm" onClick={() => doSend([name])} disabled={saving}>↻ Resend</button>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="actions"><button className="btn ghost" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
