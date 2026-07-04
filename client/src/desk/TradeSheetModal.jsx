import { useEffect, useState } from 'react';
import { PDFDocument } from 'pdf-lib';
import { formatCurrency, commissionSummary, isListingFinancialType } from './format';

// Original OREA Form 640 (editable / AcroForm) lives here:
//   client/public/forms/trade-record-sheet-640.pdf
const PDF_URL = '/forms/trade-record-sheet-640.pdf';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Fill OREA Form 640 by its exact AcroForm field names.
async function fillPdf(buf, txn) {
  const pdf = await PDFDocument.load(buf, { ignoreEncryption: true });
  let form;
  try { form = pdf.getForm(); } catch { return pdf.save(); }
  const fields = form.getFields();
  if (!fields.length) return pdf.save();

  const c = commissionSummary(txn.financial);
  const agents = (txn.financial && txn.financial.agents) || [];
  const team = (txn.team && txn.team.length) ? txn.team : (txn.agent ? [{ name: txn.agent }] : []);
  const brokerage = txn.brokerage || {};
  const clients = txn.clients || [];
  const listing = isListingFinancialType(txn.type); // GHR is listing side; clients = sellers
  const num = (v) => ((v || v === 0) ? formatCurrency(v).replace('$', '') : '');
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  const sellerC = listing ? clients : [];
  const buyerC = listing ? [] : clients;
  const lawyerSide = listing
    ? { txts_lawyername: txn.lawyer_name || '', txts_lawyerphone: txn.lawyer_phone || '', txts_lawyeraddr: txn.lawyer_address || '' }
    : { txtb_lawyername: txn.lawyer_name || '', txtb_lawyerphone: txn.lawyer_phone || '', txtb_lawyeraddr: txn.lawyer_address || '' };

  const map = {
    // Header / brokerage / salesperson
    txtCurrentUserOfficeName: 'GET HOME REALTY',
    txtCurrentUserFullName: txn.agent || '',
    txtdatedat1_d: pad(d.getDate()),
    txtdatedat1_m: pad(d.getMonth() + 1),
    txtdatedat1_y: yy,
    // Property
    txtp_street: txn.property || '',
    // Sale No / MLS No (shared page 1 + 2)
    txtsale_no: txn.trade_no || '',
    txtmlsnumber: txn.mls_num || '',
    // Seller/Landlord
    txtseller1: sellerC[0]?.name || '',
    txtseller2: sellerC[1]?.name || '',
    txts_phone1: sellerC[0]?.phone || '',
    txtS_email: sellerC[0]?.email || '',
    // Buyer/Tenant
    txtbuyer1: buyerC[0]?.name || '',
    txtbuyer2: buyerC[1]?.name || '',
    txtb_phone1: buyerC[0]?.phone || '',
    txtb_email: buyerC[0]?.email || '',
    ...lawyerSide,
    // Co-operating/Listing brokerage (the OTHER brokerage on the deal)
    txtBroker: brokerage.name || '',
    txtBrkAdd: brokerage.address || '',
    txtBrkPhone: brokerage.phone || '',
    txtc_brkgst: brokerage.hst_number || '',
    // Consideration / completion / deposit
    txtTotalConFee: num(txn.price),
    txtp_closedate: txn.closing_date || '',
    txtp_deposit: num(txn.deposit),
    // Totals (page 1) + Total Receivable Commission row (page 2)
    txtp_commission: num(c.commission),
    txtp_commission_gst: num(c.hst),
    txtp_commission_rec: num(c.total),
    txtp_commission_rec1: num(c.commission),
    txtp_commission_gst1: num(c.hst),
    txtp_commission_tot1: num(c.total),
    // Page 2 — DATED at … this … day of …, 20…
    txtdatedat2_d: pad(d.getDate()),
    txtdatedat2_m: MONTHS[d.getMonth()],
    txtdatedat2_y: yy,
  };

  // Page-2 commission table: Listing vs Co-op brokerage + our salespersons.
  if (listing) {
    map.txtl_broker = 'GET HOME REALTY';
    map.txts_broker = brokerage.name || '';
    map.txtl_brkagent = team[0]?.name || '';
    map.txtl2_brkagent = team[1]?.name || '';
    if (agents[0]) { map.txtp_commission_rec3 = num(agents[0].agent?.commission); map.txtp_commission_gst3 = num(agents[0].agent?.hst); map.txtp_commission_tot3 = num(agents[0].agent?.total); }
    if (agents[1]) { map.txtp_commission_rec4 = num(agents[1].agent?.commission); map.txtp_commission_gst4 = num(agents[1].agent?.hst); map.txtp_commission_tot4 = num(agents[1].agent?.total); }
  } else {
    map.txtl_broker = brokerage.name || '';
    map.txts_broker = 'GET HOME REALTY';
    map.txts_brkagent = team[0]?.name || '';
    map.txts2_brkagent = team[1]?.name || '';
    if (agents[0]) { map.txtp_commission_rec6 = num(agents[0].agent?.commission); map.txtp_commission_gst6 = num(agents[0].agent?.hst); map.txtp_commission_tot6 = num(agents[0].agent?.total); }
    if (agents[1]) { map.txtp_commission_rec7 = num(agents[1].agent?.commission); map.txtp_commission_gst7 = num(agents[1].agent?.hst); map.txtp_commission_tot7 = num(agents[1].agent?.total); }
  }

  fields.forEach((f) => {
    const value = map[f.getName()];
    if (value && typeof f.setText === 'function') {
      try { f.setText(String(value)); } catch { /* skip non-text */ }
    }
  });

  // Listing vs Co-operating Brokerage option (best-effort; ignored if not a radio).
  try {
    const opt = form.getField('chkOpt_l_coop');
    if (opt && typeof opt.select === 'function') opt.select(listing ? 'coop' : 'l');
  } catch { /* noop */ }

  try { form.updateFieldAppearances(); } catch { /* noop */ }
  return pdf.save();
}

export default function TradeSheetModal({ open, onClose, txn }) {
  const [src, setSrc] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | ready | missing | error

  useEffect(() => {
    if (!open) return undefined;
    let url;
    let cancelled = false;
    setStatus('loading'); setSrc(null);
    (async () => {
      try {
        const res = await fetch(PDF_URL, { cache: 'no-store' });
        const buf = await res.arrayBuffer();
        const sig = String.fromCharCode(...new Uint8Array(buf.slice(0, 5)));
        if (!res.ok || !sig.startsWith('%PDF')) { if (!cancelled) setStatus('missing'); return; }
        let bytes;
        try { bytes = await fillPdf(buf, txn); } catch { bytes = new Uint8Array(buf); } // show original if fill fails
        const blob = new Blob([bytes], { type: 'application/pdf' });
        url = URL.createObjectURL(blob);
        if (!cancelled) { setSrc(url); setStatus('ready'); }
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [open, txn]);

  if (!open) return null;

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal xl" style={{ maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <button className="close" onClick={onClose}>✕</button>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 8, flexWrap: 'wrap' }}>
          <div className="modal-h" style={{ margin: 0, border: 0, padding: 0 }}>Trade Record Sheet — OREA Form 640</div>
          {status === 'ready' && (
            <div style={{ display: 'flex', gap: 6 }}>
              <a className="btn ghost sm" href={src} target="_blank" rel="noreferrer">↗ Open in new tab</a>
              <a className="btn primary sm" href={src} download={`Trade Record Sheet ${txn?.trade_no || ''}.pdf`}>📄 Download PDF</a>
            </div>
          )}
        </div>

        {status === 'loading' && <div className="centered" style={{ padding: 30 }}>Preparing the Trade Record Sheet…</div>}

        {status === 'missing' && (
          <div style={{ padding: 18, border: '1px solid var(--line)', borderRadius: 8, background: '#fff7ed', color: '#9a3412', fontSize: 13, lineHeight: 1.6 }}>
            <strong>The Trade Record Sheet PDF isn’t in place yet.</strong>
            <div style={{ marginTop: 6 }}>Save the original OREA Form 640 (editable) file to:</div>
            <div style={{ marginTop: 4, fontFamily: 'monospace', background: '#fff', border: '1px solid var(--line)', borderRadius: 6, padding: '6px 8px', color: '#0f172a' }}>client/public/forms/trade-record-sheet-640.pdf</div>
            <div style={{ marginTop: 6 }}>Then reopen this dialog — it will display the exact document with the transaction values filled in.</div>
          </div>
        )}

        {status === 'error' && <div className="centered" style={{ padding: 30, color: 'var(--bad)' }}>Could not load the Trade Record Sheet.</div>}

        {status === 'ready' && (
          <iframe title="Trade Record Sheet — OREA Form 640" src={src}
            style={{ flex: 1, width: '100%', minHeight: '70vh', border: '1px solid var(--line)', borderRadius: 8 }} />
        )}

        <div className="actions"><button className="btn ghost" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
