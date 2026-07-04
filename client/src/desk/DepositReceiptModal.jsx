import { useEffect, useRef, useState } from 'react';
import { formatCurrency, parseNumber } from './format';
import { printDoc } from './printDoc';
import { sendDepositReceipt, getAgentEmails, getDocuments, uploadDocClientFile } from '../lib/api';
import { useToast } from './toast';

// Convert a data URI (image) into a File so it can be uploaded as multipart.
function dataUriToFile(uri, name) {
  const [meta, b64] = uri.split(',');
  const mime = (meta.match(/data:(.*?);base64/) || [])[1] || 'image/png';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
  return new File([arr], name, { type: mime });
}

const BRAND = '#c8102e';
const today = () => new Date().toISOString().slice(0, 10);

const lbl = { fontSize: 11.5, color: 'var(--text-2)', fontWeight: 600 };
const inp = { border: '1px solid #e6e8ef', borderRadius: 6, padding: '5px 8px', width: '100%' };

// Defined at module scope so its identity is stable across renders — otherwise
// React remounts the input on every keystroke and it loses focus.
function Row({ label, k, type, value, onChange }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
      <span style={{ ...lbl, minWidth: 190 }}>{label}</span>
      <input type={type || 'text'} value={value} onChange={(e) => onChange(k, e.target.value)} style={inp} />
    </div>
  );
}

// Deposit Receipt document (listing-side transactions). Auto-fills from the
// transaction; blank fields are editable. Print/Save-PDF builds the markup from
// state so typed values are included.
export default function DepositReceiptModal({ open, onClose, txn }) {
  const toast = useToast();
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
    signatory_name: 'Anand Pericherla',
    signature: '',
    // Send To = Co-op Brokerage Information → Agent Email.
    recipient_email: txn.brokerage?.agent_email || txn.brokerage?.invoice_email || txn.brokerage?.email || (txn.clients && txn.clients[0]?.email) || '',
    cc: '',
  }));
  const [sending, setSending] = useState(false);
  // Cc the listing agents (GHR deal agents) — look up their emails by name.
  useEffect(() => {
    if (!open) return;
    getAgentEmails().then((map) => {
      setF((p) => {
        if (p.cc) return p; // don't override a manual edit
        const names = (txn.team && txn.team.length ? txn.team.map((t) => t.name) : (txn.agent ? [txn.agent] : [])).filter(Boolean);
        const cc = names.map((n) => map[n]).filter(Boolean).join(', ');
        return { ...p, cc };
      });
    }).catch(() => {});
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  // Deposit slips — seeded from the Agent FAQ Center uploads; each is individually
  // selectable for the receipt. Editing here (rotate/crop) is local to the receipt.
  const [slips, setSlips] = useState(() =>
    (txn.activity_tracker?.deposit_slips || []).filter((s) => s && s.data)
      .map((s) => ({ name: s.name || 'Deposit Slip', data: s.data, included: false })));
  const [cropIndex, setCropIndex] = useState(null);
  const [viewIndex, setViewIndex] = useState(null); // slip expanded for viewing
  const [sel, setSel] = useState(null); // crop selection {x,y,w,h} in displayed px
  const slipImgRef = useRef(null);
  const dragRef = useRef(null);
  if (!open) return null;
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const tradeNo = txn.trade_no || '';

  const onFile = (k, file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => set(k, reader.result);
    reader.readAsDataURL(file);
  };

  // --- Deposit slip list: add / remove / include / rotate / crop ---
  const addSlip = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setSlips((s) => [...s, { name: file.name, data: reader.result, included: true }]);
    reader.readAsDataURL(file);
  };
  const removeSlip = (i) => { setSlips((s) => s.filter((_, idx) => idx !== i)); if (cropIndex === i) { setCropIndex(null); setSel(null); } };
  const toggleSlip = (i) => setSlips((s) => s.map((x, idx) => idx === i ? { ...x, included: !x.included } : x));
  const updateSlipData = (i, data) => setSlips((s) => s.map((x, idx) => idx === i ? { ...x, data } : x));
  const rotateSlip = (i, deg) => {
    const cur = slips[i]; if (!cur) return;
    const img = new Image();
    img.onload = () => {
      const swap = Math.abs(deg) % 180 !== 0;
      const canvas = document.createElement('canvas');
      canvas.width = swap ? img.height : img.width;
      canvas.height = swap ? img.width : img.height;
      const ctx = canvas.getContext('2d');
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(deg * Math.PI / 180);
      ctx.drawImage(img, -img.width / 2, -img.height / 2);
      updateSlipData(i, canvas.toDataURL('image/png'));
    };
    img.src = cur.data;
  };
  const startCrop = (i) => { setCropIndex(i); setSel(null); };
  const cancelCrop = () => { setCropIndex(null); setSel(null); };
  const slipPos = (e) => { const r = slipImgRef.current.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const onSlipDown = (e) => { const p = slipPos(e); dragRef.current = p; setSel({ x: p.x, y: p.y, w: 0, h: 0 }); };
  const onSlipMove = (e) => {
    if (!dragRef.current) return;
    const p = slipPos(e); const s = dragRef.current;
    setSel({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
  };
  const onSlipUp = () => { dragRef.current = null; };
  const applyCrop = () => {
    const el = slipImgRef.current;
    const cur = cropIndex != null ? slips[cropIndex] : null;
    if (!cur || !el || !sel || sel.w < 5 || sel.h < 5) return;
    const sx = el.naturalWidth / el.clientWidth;
    const sy = el.naturalHeight / el.clientHeight;
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(sel.w * sx);
      canvas.height = Math.round(sel.h * sy);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, sel.x * sx, sel.y * sy, sel.w * sx, sel.h * sy, 0, 0, canvas.width, canvas.height);
      updateSlipData(cropIndex, canvas.toDataURL('image/png'));
      setSel(null); setCropIndex(null);
    };
    img.src = cur.data;
  };
  const selectedSlips = slips.filter((s) => s.included && s.data);

  const send = async () => {
    if (!f.recipient_email) { toast('Enter a recipient email', 'info'); return; }
    setSending(true);
    try {
      await sendDepositReceipt(txn.id, f.recipient_email, f.cc);
      // Auto-attach the selected deposit slip(s) to the Legal & Documentation "Deposit Receipt" doc.
      let attached = 0;
      if (selectedSlips.length) {
        try {
          const docs = await getDocuments(txn.id);
          const dr = (docs.documents || []).find((d) => /deposit receipt|deposit slip/i.test(d.title || ''));
          if (dr?.id) {
            for (let i = 0; i < selectedSlips.length; i += 1) {
              // eslint-disable-next-line no-await-in-loop
              await uploadDocClientFile(txn.id, dr.id, dataUriToFile(selectedSlips[i].data, selectedSlips[i].name || `Deposit Slip ${i + 1} - ${tradeNo}.png`));
              attached += 1;
            }
          }
        } catch { /* non-fatal */ }
      }
      toast(`Deposit Receipt sent to ${f.recipient_email}${attached ? ` • ${attached} slip(s) added to Legal & Documentation` : ''}`, 'ok');
    } catch (e) { toast(e.response?.data?.message || 'Could not send', 'bad'); }
    finally { setSending(false); }
  };

  const printHtml = () => {
    // Cap each slip so the whole receipt fits on one page (less room when 2+ slips).
    const slipMaxH = selectedSlips.length > 1 ? Math.floor(330 / selectedSlips.length) : 330;
    return `
    <style>
      @page { size: A4 portrait; margin: 10mm; }
      @media print { body { margin: 0 !important; } }
      .dr { font-size: 12px; line-height: 1.3; }
      .dr p { margin: 6px 0; }
      .dr ul { margin: 4px 0; padding-left: 20px; line-height: 1.45; }
    </style>
    <div class="dr">
    <div style="text-align:center">
      <div style="font-size:22px;font-weight:800;color:${BRAND}">GET&#9730;HOME REALTY</div>
      <div style="font-size:10px;font-style:italic;color:#64748b">"A Tradition of Trust" — Brokerage</div>
      <div style="font-size:10px;color:#475569">Unit-101, 218 Export Blvd, Mississauga, L5S 0A7, Ontario, Canada</div>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin:10px 0">
      <div style="background:${BRAND};color:#fff;font-weight:800;padding:5px 14px;border-radius:4px;font-size:16px">Deposit Receipt</div>
      <div style="font-weight:700">Date: ${f.date || ''}</div>
    </div>
    <p style="font-weight:700">Trade No: ${tradeNo}</p>
    <p style="font-weight:700;text-decoration:underline">Property Details:</p>
    <ul>
      <li>Address: ${f.address || ''}</li>
      <li>Co-op Brokerage: ${f.coop_brokerage || ''}</li>
      <li>Co-op Agent: ${f.coop_agent || ''}</li>
      <li>Contact of Sales Person: ${f.contact_sales || ''}</li>
    </ul>
    <p style="font-weight:700;text-decoration:underline">Deposit Information:</p>
    <ul>
      <li>Name of the Bank: ${f.bank_name || ''}</li>
      <li>Received From: ${f.received_from || ''}</li>
      <li>Deposit Amount: ${f.deposit_amount !== '' ? formatCurrency(f.deposit_amount) : '$'}</li>
      <li>Date of Transfer: ${f.date_transfer || ''}</li>
      <li>Balance due: ${f.balance_due !== '' ? formatCurrency(f.balance_due) : '$'}</li>
      <li>Name of the Listing Agent: ${f.listing_agent || ''}</li>
    </ul>
    <p style="font-weight:700">Copy of Deposit slip:</p>
    ${selectedSlips.length
      ? selectedSlips.map((s) => `<div style="margin:4px 0;text-align:center"><img src="${s.data}" style="max-width:100%;max-height:${slipMaxH}px;display:inline-block"/></div>`).join('')
      : '<div style="height:120px;border:1px dashed #cbd5e1;border-radius:6px;margin:4px 0"></div>'}
    <div style="margin-top:18px">
      <div>Name: ${f.signatory_name || ''}</div>
      <div style="margin-top:4px">Signature: ${f.signature ? `<img src="${f.signature}" style="max-height:40px;vertical-align:middle"/>` : '______________________________'}</div>
    </div>
    </div>
  `;
  };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal lg" style={{ maxHeight: '92vh', overflowY: 'auto' }}>
        <button className="close" onClick={onClose}>✕</button>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div className="modal-h" style={{ margin: 0, border: 0, padding: 0 }}>Deposit Receipt</div>
          <button className="btn primary sm" onClick={() => printDoc(`Deposit Receipt - ${tradeNo}`, printHtml())}>🖨 Print / Save PDF</button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
          <span style={{ ...lbl, minWidth: 60 }}>Send to</span>
          <input type="email" value={f.recipient_email} onChange={(e) => set('recipient_email', e.target.value)} placeholder="Co-op Brokerage Agent Email" style={{ ...inp, width: 'auto', flex: 1, minWidth: 220 }} />
          <button className="btn ghost sm" onClick={send} disabled={sending}>{sending ? 'Sending…' : '✉ Send Email'}</button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <span style={{ ...lbl, minWidth: 60 }}>Cc</span>
          <input type="text" value={f.cc} onChange={(e) => set('cc', e.target.value)} placeholder="Listing agent email(s), comma separated" style={{ ...inp, width: 'auto', flex: 1, minWidth: 220 }} />
        </div>

        {/* Deposit slip selection (from Agent FAQ Center uploads) */}
        <div style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 12, marginBottom: 14, background: '#fcfcfd' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <strong style={{ fontSize: 13 }}>Deposit Slips <span style={{ fontWeight: 400, color: 'var(--muted)', fontSize: 12 }}>({selectedSlips.length} selected)</span></strong>
            <label className="btn ghost sm" style={{ cursor: 'pointer' }}>+ Attach Slip
              <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { addSlip(e.target.files[0]); e.target.value = ''; }} />
            </label>
          </div>
          <div className="help" style={{ marginBottom: 8 }}>Tick the slip(s) to include on the receipt. Click a slip name to view it.</div>
          {slips.length === 0 ? (
            <div className="help">No deposit slips. Upload them in the Agent FAQ Center, or attach one here.</div>
          ) : slips.map((s, i) => (
            <div key={i} style={{ border: `1px solid ${s.included ? 'var(--brand)' : 'var(--line)'}`, borderRadius: 6, marginBottom: 6, background: '#fff' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px' }}>
                <input type="checkbox" checked={s.included} onChange={() => toggleSlip(i)} />
                <button type="button" className="prop-link" style={{ flex: 1, textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer' }}
                  onClick={() => setViewIndex(viewIndex === i ? null : i)}>{viewIndex === i ? '▼ ' : '▶ '}{s.name || `Slip ${i + 1}`}</button>
                <button className="btn ghost sm" onClick={() => rotateSlip(i, -90)} title="Rotate left">↺</button>
                <button className="btn ghost sm" onClick={() => rotateSlip(i, 90)} title="Rotate right">↻</button>
                <button className="btn ghost sm" onClick={() => { setViewIndex(i); startCrop(i); }}>✂ Crop</button>
                <button className="row-rm" onClick={() => removeSlip(i)}>🗑️</button>
              </div>
              {viewIndex === i && cropIndex !== i && (
                <div style={{ borderTop: '1px solid var(--line)', padding: 10, textAlign: 'center', background: '#f8fafc' }}>
                  <img src={s.data} alt={s.name} style={{ maxWidth: '100%', maxHeight: 360, display: 'inline-block' }} />
                </div>
              )}
              {cropIndex === i && (
                <div style={{ borderTop: '1px solid var(--line)', padding: 10 }}>
                  <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    <button className="btn ghost sm" onClick={applyCrop} disabled={!sel || sel.w < 5}>✂ Apply Crop</button>
                    <button className="btn ghost sm" onClick={cancelCrop}>Cancel</button>
                    <span className="help">Drag on the slip to select a crop area.</span>
                  </div>
                  <div style={{ display: 'inline-block', maxWidth: '100%' }}>
                    <div style={{ position: 'relative', display: 'inline-block', maxWidth: '100%', cursor: 'crosshair' }}
                      onMouseDown={onSlipDown} onMouseMove={onSlipMove} onMouseUp={onSlipUp} onMouseLeave={onSlipUp}>
                      <img ref={slipImgRef} src={s.data} alt="crop" draggable={false} style={{ maxWidth: '100%', maxHeight: 360, display: 'block', userSelect: 'none' }} />
                      {sel && sel.w > 0 && (
                        <div style={{ position: 'absolute', left: sel.x, top: sel.y, width: sel.w, height: sel.h, border: '2px dashed #2563eb', background: 'rgba(37,99,235,0.12)', pointerEvents: 'none' }} />
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
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
        <Row label="Address" k="address" value={f.address} onChange={set} />
        <Row label="Co-op Brokerage" k="coop_brokerage" value={f.coop_brokerage} onChange={set} />
        <Row label="Co-op Agent" k="coop_agent" value={f.coop_agent} onChange={set} />
        <Row label="Contact of Sales Person" k="contact_sales" value={f.contact_sales} onChange={set} />

        <div className="modal-sub">Deposit Information</div>
        <Row label="Name of the Bank" k="bank_name" value={f.bank_name} onChange={set} />
        <Row label="Received From" k="received_from" value={f.received_from} onChange={set} />
        <Row label="Deposit Amount ($)" k="deposit_amount" value={f.deposit_amount} onChange={set} />
        <Row label="Date of Transfer" k="date_transfer" type="date" value={f.date_transfer} onChange={set} />
        <Row label="Balance due ($)" k="balance_due" value={f.balance_due} onChange={set} />
        <Row label="Name of the Listing Agent" k="listing_agent" value={f.listing_agent} onChange={set} />

        {/* Final look — exactly what appears on the printed/sent receipt */}
        <div style={{ fontWeight: 700, marginTop: 10, marginBottom: 6 }}>Copy of Deposit slip</div>
        {selectedSlips.length === 0 ? (
          <div style={{ height: 120, border: '1px dashed #cbd5e1', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 12 }}>
            No slip selected — tick a slip above to show it here.
          </div>
        ) : selectedSlips.map((s, i) => (
          <div key={i} style={{ border: '1px solid #eef0f5', borderRadius: 6, padding: 6, marginBottom: 8 }}>
            <img src={s.data} alt={s.name} style={{ maxWidth: '100%', display: 'block' }} />
          </div>
        ))}

        <div className="modal-sub">Authorized By</div>
        <Row label="Name" k="signatory_name" value={f.signatory_name} onChange={set} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
          <span style={{ ...lbl, minWidth: 190 }}>Signature</span>
          <label className="btn ghost sm" style={{ cursor: 'pointer' }}>{f.signature ? 'Replace Signature' : 'Upload Signature'}
            <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { onFile('signature', e.target.files[0]); e.target.value = ''; }} />
          </label>
          {f.signature && <img src={f.signature} alt="signature" style={{ height: 40, border: '1px solid #e6e8ef', borderRadius: 6, background: '#fff' }} />}
          {f.signature && <button className="row-rm" onClick={() => set('signature', '')}>🗑️</button>}
        </div>

        <div className="actions"><button className="btn ghost" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
