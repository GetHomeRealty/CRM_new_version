import { useEffect, useRef, useState } from 'react';
import { formatCurrency, isListingFinancialType } from './format';
import { getDocuments, getNoticeOfSale, saveNoticeOfSale, sendNoticeOfSale } from '../lib/api';
import { printDoc } from './printDoc';
import { elementToPdfBase64 } from './pdf';
import { useToast } from './toast';

const BRAND = '#c8102e';

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

  const clients = txn.clients || [];
  const team = (txn.team && txn.team.length) ? txn.team : (txn.agent ? [{ name: txn.agent, split: 100 }] : []);
  // Commission in %/$: the value shown beside "Agent (T4A)" in Financial Information
  // (sum of each agent's T4A total), for all transaction types. `financial.agents`
  // carries t4a for both the standard and listing variants (listing `members` omit it).
  const fin = txn.financial || {};
  let t4aTotal = 0;
  if (fin.terms?.length) fin.terms.forEach((t) => (t.agents || []).forEach((a) => { t4aTotal += a.t4a?.total || 0; }));
  else if (fin.agents?.length) fin.agents.forEach((a) => { t4aTotal += a.t4a?.total || 0; });
  else (fin.members || []).forEach((m) => { t4aTotal += m.t4a?.total ?? m.earned ?? 0; });
  const commRate = t4aTotal > 0
    ? formatCurrency(t4aTotal)
    : (txn.comm_type === 'Fixed' ? formatCurrency(txn.comm_value) : `${txn.comm_value || txn.comm_pct || 0}%`);
  // Lawyer Information source: Buyer Lawyer for Buying deals, Seller Lawyer otherwise;
  // fall back to the legacy (mirrored) lawyer_* fields.
  const useBuyerLawyer = /buying/i.test(txn.type);
  const lw = (field) => (useBuyerLawyer ? txn[`buyer_lawyer_${field}`] : txn[`seller_lawyer_${field}`]) || txn[`lawyer_${field}`] || '';

  // Signatories = the deal's primary agent + any split agents (the Team), who sign at the bottom.
  const signatories = team.map((m) => m.name).filter(Boolean);

  // The Mutual Release document is a Mutual-Release-status artefact and must never
  // appear on the Notice of Sale.
  const nosDocs = docs.filter((d) => !/mutual release/i.test(d.title || ''));

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
      const pdf = await buildDocBase64();
      const extra = pdf ? { pdf, filename: `Notice of Sale ${txn.trade_no}.pdf` } : {};
      const res = await sendNoticeOfSale(txn.id, names, extra);
      applyNotice(res);
      toast(names.length === 1 ? `Resent to ${names[0]}` : `Notice sent to ${names.length} salesperson(s)`, 'ok');
    } catch { toast('Could not send', 'bad'); }
    finally { setSaving(false); }
  };

  // Print: replace live inputs with styled text (so typed values + dd/mm/yyyy dates
  // survive serialization) and drop edit-only controls — keeping the original look.
  // Build a print-ready clone: live inputs → styled text, edit-only controls removed.
  const buildPrintClone = () => {
    const root = ref.current;
    if (!root) return null;
    root.querySelectorAll('input').forEach((el) => el.setAttribute('value', el.value));
    const clone = root.cloneNode(true);
    clone.querySelectorAll('[data-noprint]').forEach((el) => el.remove());
    clone.querySelectorAll('input').forEach((el) => {
      const div = document.createElement('div');
      div.style.cssText = 'background:#f9fafb;border:1px solid #e6e8ef;border-radius:8px;padding:9px 11px;font-size:13px;color:#0f172a;min-height:38px';
      div.textContent = el.getAttribute('type') === 'date' ? fmtDMY(el.getAttribute('value')) : (el.getAttribute('value') || ' ');
      el.replaceWith(div);
    });
    return clone;
  };
  const printNow = () => {
    const clone = buildPrintClone();
    if (clone) printDoc(`Notice of Sale ${txn.trade_no}`, clone.innerHTML);
  };
  // Render the notice to a PDF (base64) for attaching to the email — best-effort.
  const buildDocBase64 = async () => {
    const clone = buildPrintClone();
    if (!clone) return null;
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:760px;background:#ffffff;padding:16px;font-family:Inter,Arial,sans-serif;color:#0f172a;';
    holder.appendChild(clone);
    document.body.appendChild(holder);
    try { return await elementToPdfBase64(holder); }
    catch { return null; }
    finally { holder.remove(); }
  };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal lg" style={{ maxHeight: '92vh', overflowY: 'auto' }}>
        <button className="close" onClick={onClose}>✕</button>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 8, flexWrap: 'wrap' }}>
          <div className="modal-h" style={{ margin: 0, border: 0, padding: 0 }}>Notice of Sale</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn ghost sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : '💾 Save'}</button>
            <button className="btn ghost sm" onClick={() => doSend(signatories)} disabled={saving || !signatories.length}>✉ {sentAt ? 'Resend' : 'Send'}</button>
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
            <div style={{ color: BRAND, fontSize: 44, fontWeight: 700 }}>Notice of Sale</div>
          </div>

          {/* Main details card */}
          <div style={card}>
            <div style={grid3}>
              <Field label="Property Address" value={txn.property} />
              <Field label="Transaction Type" value={txn.type} />
              <Field label="MLS Number" value={txn.mls_num} />
            </div>
            <div style={grid3}>
              <Field label="Purchase Price" value={formatCurrency(txn.price)} />
              <Field label="Sold Date" value={txn.offer_date} />
              <Field label="Closing Date" value={txn.closing_date} />
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
            <div style={grid3}>
              <Field label="Name" value={lw('name')} />
              <Field label="Phone" value={lw('phone')} />
              <Field label="Email" value={lw('email')} />
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
            <div style={sectionTitle}>Mandatory Documents</div>
            {nosDocs.length === 0 && <div style={{ fontSize: 12, color: '#64748b', marginBottom: 14 }}>No documents in the Legal &amp; Documentation section yet.</div>}
            {/* Column-major: up to 6 per column, then the 7th sits beside the 1st, 8th beside the 2nd, … */}
            <div style={{ display: 'grid', gridAutoFlow: 'column', gridTemplateRows: `repeat(${Math.min(6, nosDocs.length || 1)}, auto)`, gridAutoColumns: '1fr', gap: '8px 28px', marginBottom: 14 }}>
              {nosDocs.map((d) => {
                const checked = d.validation === 'Valid';
                return (
                  <div key={d.id ?? d.title} style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13 }}>
                    <span style={{
                      width: 16, height: 16, borderRadius: 4, flexShrink: 0,
                      border: `1.5px solid ${checked ? '#2563eb' : '#94a3b8'}`,
                      background: checked ? '#2563eb' : '#fff',
                      color: '#fff', fontSize: 11, fontWeight: 700, lineHeight: '14px', textAlign: 'center',
                    }}>{checked ? '✓' : ''}</span>
                    {d.title}
                  </div>
                );
              })}
            </div>
            <div style={{ background: '#f9fafb', border: '1px solid #eef0f5', borderRadius: 8, padding: '12px 14px', fontStyle: 'italic', fontSize: 12.5, color: '#475569', marginBottom: 18 }}>
              Information provided on this document is accurate to the best of my knowledge and belief.
            </div>

            {sentAt && <div data-noprint className="help" style={{ marginBottom: 10 }}>Last sent for signature: {new Date(sentAt).toLocaleString()}</div>}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '22px 24px' }}>
              {(signatories.length ? signatories : ['']).map((name, i) => {
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
