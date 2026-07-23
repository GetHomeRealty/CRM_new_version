import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PDFDocument, StandardFonts, rgb, type PDFDocument as PDFDoc } from 'pdf-lib';
import { getClientIdentification, saveClientIdentification } from '../lib/api';
import { useToast } from './toast';
import { useAuth } from '../context/AuthContext';
import type { Transaction } from '../types';

// yyyy-mm-dd (date input) → dd-mm-yyyy (the format printed on the form).
const toDMY = (s: string | null | undefined) => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') ? `${(s || '').slice(8, 10)}-${(s || '').slice(5, 7)}-${(s || '').slice(0, 4)}` : (s || ''));

// Positions of each blank on OREA Form 630 page 1, as fractions of page width/height.
const COORDS: Record<string, [number, number]> = {
  property: [0.205, 0.207],
  agent: [0.225, 0.245],
  date_verified: [0.315, 0.263],
  individual_name: [0.195, 0.354],
  address: [0.095, 0.375],
  dob: [0.125, 0.408],
  occupation: [0.315, 0.427],
  driver_x: [0.163, 0.476],
  passport_x: [0.268, 0.476],
  other_x: [0.345, 0.476],
  id_number: [0.195, 0.492],
  issuing_jurisdiction: [0.115, 0.510],
  country: [0.470, 0.510],
  expiry_date: [0.150, 0.527],
};

// Width of each text field, as a fraction of page width.
const WIDTHS: Record<string, number> = {
  property: 0.72, agent: 0.60, date_verified: 0.42, individual_name: 0.70, address: 0.80,
  dob: 0.42, occupation: 0.50, id_number: 0.60, issuing_jurisdiction: 0.30, country: 0.26, expiry_date: 0.42,
};

interface Form630Values { [key: string]: unknown }

// Add editable AcroForm fields onto the (flattened) form over each blank, prefilled
// with the data — so the PDF is editable in the viewer just like the Trade Sheet.
async function makeFillable630(pdf: PDFDoc, v: Form630Values) {
  const page = pdf.getPages()[0];
  const { width, height } = page.getSize();
  const form = pdf.getForm();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  let n = 0;

  const addText = (key: string, value: unknown) => {
    if (!COORDS[key]) return;
    const [fx, fy] = COORDS[key];
    const tf = form.createTextField(`f630_${key}_${n++}`);
    if (value) tf.setText(String(value));
    tf.setFontSize(9);
    tf.addToPage(page, {
      x: fx * width,
      y: height - fy * height - 11,
      width: (WIDTHS[key] || 0.5) * width,
      height: 14,
      borderWidth: 0,
      textColor: rgb(0.05, 0.06, 0.12),
    });
  };
  ['property', 'agent', 'date_verified', 'individual_name', 'address', 'dob', 'occupation',
    'id_number', 'issuing_jurisdiction', 'country', 'expiry_date'].forEach((k) => addText(k, v[k]));

  const addCheck = (key: string, checked: boolean) => {
    if (!COORDS[key]) return;
    const [fx, fy] = COORDS[key];
    const cb = form.createCheckBox(`f630_${key}_${n++}`);
    cb.addToPage(page, { x: fx * width, y: height - fy * height - 9, width: 10, height: 10, borderWidth: 0 });
    if (checked) cb.check();
  };
  addCheck('driver_x', v.id_type === "Driver's Licence");
  addCheck('passport_x', v.id_type === 'Passport');
  addCheck('other_x', v.id_type === 'Other');

  try { form.updateFieldAppearances(font); } catch { /* noop */ }
}

// Fills the official OREA Form 630 PDF (the user's own file) by its AcroForm fields.
const PDF_URL = '/forms/individual-identification-630.pdf';
const ID_TYPES = ["Driver's Licence", 'Passport', 'Other'];

interface FillResult { bytes: Uint8Array; fieldCount: number; error?: string; stamped?: boolean; }

// Map our values onto the PDF's form fields by keyword. NEVER throws — always
// returns bytes to display (the original if it can't be parsed/filled).
async function fillForm630(buf: Uint8Array, v: Form630Values): Promise<FillResult> {
  let pdf: PDFDoc;
  try {
    pdf = await PDFDocument.load(buf, { ignoreEncryption: true });
  } catch {
    // XFA / secured / malformed — pdf-lib can't read it. Show the original as-is.
    return { bytes: buf, fieldCount: 0, error: 'load' };
  }

  const form = (() => { try { return pdf.getForm(); } catch { return null; } })();
  if (!form) return { bytes: buf, fieldCount: 0, error: 'form' };
  let fields: ReturnType<typeof form.getFields> = [];
  try { fields = form.getFields(); } catch { fields = []; }
  if (!fields.length) {
    // No form fields → add editable fields over the blanks so it fills like the Trade Sheet.
    try {
      await makeFillable630(pdf, v);
      return { bytes: await pdf.save(), fieldCount: 0, stamped: true };
    } catch {
      return { bytes: buf, fieldCount: 0, error: 'stamp' };
    }
  }

  try { console.info('[Form 630] AcroForm fields:', fields.map((x) => x.getName())); } catch { /* noop */ }

  // Fill OREA Form 630 by its exact AcroForm field names (decrypted template).
  const map: Record<string, unknown> = {
    txtIndividual: v.individual_name,           // Full legal name
    txtstreet: v.address,                       // Individual's address (street line)
    txtBirthDate: v.dob,
    txtOccupation: v.occupation,                // Principal business / occupation
    txtDocumentIDNum: v.id_number,              // Document number
    txtIssuingJurisdiction: v.issuing_jurisdiction,
    txtFedCountry: v.country,
    txtDocExpDate: v.expiry_date,               // Expiry date
    txtp_street: v.property,                     // Property / transaction address
    txtbroker: v.agent,                          // Sales representative / broker
    txtInfoVerDate: v.date_verified,             // Date the info was verified
  };

  fields.forEach((fl) => {
    // pdf-lib's dynamic field API: only PDFTextField exposes setText.
    const textField = fl as { setText?: (t: string) => void };
    if (typeof textField.setText !== 'function') return;
    const value = map[fl.getName()];
    if (value) { try { textField.setText(String(value)); } catch { /* skip non-text */ } }
  });

  try { form.updateFieldAppearances(); } catch { /* noop */ }

  let bytes: Uint8Array;
  try { bytes = await pdf.save(); } catch { bytes = buf; } // fall back to original if save fails
  return { bytes, fieldCount: fields.length };
}

interface Form630Form {
  individual_name: string;
  address: string;
  dob: string;
  occupation: string;
  id_type: string;
  id_number: string;
  issuing_jurisdiction: string;
  country: string;
  issue_date: string;
  expiry_date: string;
  property: string;
  agent: string;
  date_verified: string;
}
interface IdMeta { source?: string | null; verified: boolean; }

interface Form630ModalProps {
  open: boolean;
  onClose: () => void;
  txn?: Transaction | null;
  clientName?: string | null;
}

export default function Form630Modal({ open, onClose, txn, clientName = null }: Form630ModalProps) {
  const toast = useToast();
  const { can } = useAuth();
  // Anyone with transactions:edit may edit; others get view + download only.
  const canEdit = can('transactions', 'edit');
  const readOnly = !canEdit;
  const clients = useMemo(() => (txn?.clients || []).filter((c) => c?.name), [txn]);
  const today = new Date().toISOString().slice(0, 10);
  const residential = /residential/i.test(txn?.type || '') || !/commercial|business/i.test(txn?.type || '');

  const [f, setF] = useState<Form630Form>({
    individual_name: clientName || clients[0]?.name || '',
    address: '', dob: '', occupation: '',
    id_type: "Driver's Licence", id_number: '', issuing_jurisdiction: 'Ontario', country: 'Canada',
    issue_date: '', expiry_date: '',
    // "Date Information Verified / Credit File Consulted" reflects the deal's offer date.
    property: txn?.property || '', agent: txn?.agent || '', date_verified: txn?.offer_date || today,
  });
  const set = (k: keyof Form630Form, v: string) => setF((s) => ({ ...s, [k]: v }));

  const bufRef = useRef<Uint8Array | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [tick, setTick] = useState(0);              // bumps when a template is (re)loaded
  // The parsed field count is only used to trigger a re-render; the value is unread.
  const [, setFieldCount] = useState<number | null>(null);
  const [fillError, setFillError] = useState<string | null>(null); // null | 'load' | 'stamp'
  const [stamped, setStamped] = useState(false);

  // Stored per-client identity (extracted from the uploaded ID / previously saved).
  // Only the setter is used (drives a re-render); the value was read by dead code.
  const [, setIdMeta] = useState<IdMeta>({ source: null, verified: false });
  const [idLoading, setIdLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Load the client's saved/extracted identity and prefill empty fields (never clobber).
  useEffect(() => {
    if (!open || !txn?.id || !clientName) return undefined;
    let cancelled = false;
    setIdLoading(true);
    getClientIdentification(txn.id, clientName)
      .then((d) => {
        if (cancelled || !d) return;
        setIdMeta({ source: d.source, verified: !!d.verified });
        setF((s) => ({
          ...s,
          individual_name: s.individual_name || d.full_legal_name || clientName,
          address: s.address || d.address || '',
          dob: s.dob || d.dob || '',
          occupation: s.occupation || d.occupation || '',
          id_type: d.id_type || s.id_type,
          id_number: s.id_number || d.id_number || '',
          issuing_jurisdiction: d.issuing_jurisdiction || s.issuing_jurisdiction,
          country: d.country || s.country,
          expiry_date: s.expiry_date || d.expiry_date || '',
        }));
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setIdLoading(false); });
    return () => { cancelled = true; };
  }, [open, txn?.id, clientName]);

  const confirmIdentity = async () => {
    if (!txn?.id || !clientName) return;
    setSaving(true);
    try {
      const d = await saveClientIdentification(txn.id, {
        client_name: clientName,
        full_legal_name: f.individual_name, address: f.address, dob: f.dob, occupation: f.occupation,
        id_type: f.id_type, id_number: f.id_number, issuing_jurisdiction: f.issuing_jurisdiction,
        country: f.country, expiry_date: f.expiry_date, verified: true,
      });
      setIdMeta({ source: d.source, verified: !!d.verified });
      toast('Identity confirmed & saved', 'ok');
    } catch { toast('Could not save identity', 'bad'); } finally { setSaving(false); }
  };

  // Try the bundled template once on open (falls back to the picker if absent).
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setStatus('loading'); setSrc(null); setFieldCount(null); setFillError(null); setStamped(false); bufRef.current = null;
    (async () => {
      try {
        const res = await fetch(PDF_URL, { cache: 'no-store' });
        const buf = await res.arrayBuffer();
        const sig = String.fromCharCode(...new Uint8Array(buf.slice(0, 5)));
        if (!res.ok || !sig.startsWith('%PDF')) { if (!cancelled) setStatus('missing'); return; }
        bufRef.current = new Uint8Array(buf);
        if (!cancelled) { setStatus('ready'); setTick((n) => n + 1); }
      } catch { if (!cancelled) setStatus('error'); }
    })();
    return () => { cancelled = true; };
  }, [open]);

  // Re-fill whenever values or the loaded template change (debounced).
  useEffect(() => {
    if (status !== 'ready' || !bufRef.current) return undefined;
    let url: string | undefined;
    let cancelled = false;
    const t = setTimeout(async () => {
      const cur = bufRef.current;
      if (!cur) return;
      // Dates print on the form as dd-mm-yyyy (the inputs are ISO date pickers).
      const values: Form630Values = { ...f, dob: toDMY(f.dob), expiry_date: toDMY(f.expiry_date), date_verified: toDMY(f.date_verified), residential };
      // fillForm630 never throws — it always returns bytes to display.
      const { bytes, fieldCount: fc, error, stamped: st } = await fillForm630(cur, values);
      if (cancelled) return;
      setFieldCount(fc);
      setFillError(error || null);
      setStamped(!!st);
      url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }));
      setSrc(url);
    }, 300);
    return () => { cancelled = true; clearTimeout(t); if (url) URL.revokeObjectURL(url); };
  }, [f, status, residential, tick]);

  if (!open) return null;

  const onPickTemplate = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const sig = String.fromCharCode(...new Uint8Array(buf.slice(0, 5)));
      if (!sig.startsWith('%PDF')) { setStatus('error'); return; }
      bufRef.current = new Uint8Array(buf);
      setStatus('ready'); setTick((n) => n + 1);
    } catch { setStatus('error'); }
  };

  const filename = `FINTRACK Form 630 - ${f.individual_name || 'client'} ${txn?.trade_no || ''}.pdf`.replace(/\s+/g, ' ').trim();

  const pickBtn = (
    <label className="btn ghost sm" style={{ cursor: 'pointer' }}>📎 Choose Form 630 PDF
      <input type="file" accept="application/pdf" style={{ display: 'none' }} onChange={onPickTemplate} />
    </label>
  );

  const field = (label: ReactNode, key: keyof Form630Form, type = 'text', opts?: string[]) => (
    <div className="field" style={{ marginBottom: 8 }}>
      <label style={{ fontSize: 11 }}>{label}</label>
      {opts
        ? <select value={f[key]} disabled={readOnly} onChange={(e) => set(key, e.target.value)}>{opts.map((o) => <option key={o}>{o}</option>)}</select>
        : <input type={type} value={f[key]} disabled={readOnly} onChange={(e) => set(key, e.target.value)} />}
    </div>
  );

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal xl" style={{ maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <button className="close" onClick={onClose}>✕</button>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8, flexWrap: 'wrap' }}>
          <div className="modal-h" style={{ margin: 0, border: 0, padding: 0 }}>FINTRACK — Individual Identification (Form 630){clientName ? ` · ${clientName}` : ''}</div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {idLoading && <span style={{ fontSize: 11, color: '#2563eb' }}>⏳ Loading…</span>}
            {clientName && canEdit && <button className="btn primary sm" onClick={confirmIdentity} disabled={saving}>{saving ? 'Saving…' : '💾 Save'}</button>}
            {pickBtn}
            {status === 'ready' && src && (
              <>
                <a className="btn ghost sm" href={src} target="_blank" rel="noreferrer">↗ Open</a>
                <a className="btn primary sm" href={src} download={filename}>📄 Download PDF</a>
              </>
            )}
          </div>
        </div>

        {readOnly && (
          <div style={{ padding: '8px 12px', borderRadius: 8, background: '#eff6ff', border: '1px solid #bfdbfe', color: '#1e3a8a', fontSize: 12.5, marginBottom: 8 }}>
            🔒 View &amp; download only — you don't have edit access to this record.
          </div>
        )}

        <div className="help" style={{ marginBottom: 10 }}>
          {readOnly
            ? 'This Form 630 is read-only for your role. You can open, download and print it.'
            : "Enter the client's identity details in the panel on the right — they fill into the Form 630 on the left. Click Save to keep them for this client (they reload next time); then download the completed PDF."}
        </div>

        {status === 'loading' && <div className="centered" style={{ padding: 30 }}>Preparing Form 630…</div>}
        {status === 'error' && <div className="centered" style={{ padding: 30, color: 'var(--bad)' }}>That file isn't a valid PDF. Choose the Form 630 PDF again.</div>}
        {status === 'missing' && (
          <div style={{ padding: 18, border: '1px solid var(--line)', borderRadius: 8, background: '#fff7ed', color: '#9a3412', fontSize: 13, lineHeight: 1.6 }}>
            <strong>No Form 630 template loaded.</strong>
            <div style={{ marginTop: 6 }}>Click <strong>“📎 Choose Form 630 PDF”</strong> above and select your OREA Form 630 file — or save it permanently to <span style={{ fontFamily: 'monospace' }}>client/public/forms/individual-identification-630.pdf</span>.</div>
            <div style={{ marginTop: 6 }}>Use the <strong>fillable</strong> version (with clickable blanks) so the data can be written in.</div>
          </div>
        )}

        {status === 'ready' && (
          <>
            {fillError && (
              <div style={{ padding: '8px 12px', borderRadius: 8, background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', fontSize: 12.5, marginBottom: 8 }}>
                ⚠ This PDF couldn't be edited (it looks like a secured or XFA/WEBForms form). It's shown as-is below.
              </div>
            )}
            {stamped && (
              <div style={{ padding: '8px 12px', borderRadius: 8, background: '#eff6ff', border: '1px solid #bfdbfe', color: '#1e3a8a', fontSize: 12.5, marginBottom: 8 }}>
                ✍ Editable fields were added over the blanks (this PDF had none) — edit here or directly in the form, then Download. If a field sits slightly off its line, tell me which and I'll nudge its position.
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 14, overflow: 'hidden', flex: 1, minHeight: 0 }}>
              <div style={{ minHeight: 0 }}>
                {src
                  ? <iframe title="FINTRACK Form 630" src={src} style={{ width: '100%', height: '100%', minHeight: '66vh', border: '1px solid var(--line)', borderRadius: 8 }} />
                  : <div className="centered" style={{ padding: 30 }}>Filling…</div>}
              </div>
              <div style={{ overflow: 'auto', paddingRight: 4 }}>
                <div className="help" style={{ marginTop: 0, marginBottom: 8 }}>Enter details here — they fill into the form on the left. Type here (not in the PDF) so <strong>Save</strong> can keep them.</div>
                <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--brand)', margin: '2px 0 6px' }}>Individual</div>
                {field('Full Legal Name', 'individual_name')}
                {field('Address', 'address')}
                {field('Date of Birth', 'dob', 'date')}
                {field('Principal Business / Occupation', 'occupation')}
                <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--brand)', margin: '10px 0 6px' }}>Photo ID</div>
                {field('Type of Identification', 'id_type', 'text', ID_TYPES)}
                {field('Document Number', 'id_number')}
                {field('Issuing Jurisdiction', 'issuing_jurisdiction')}
                {field('Country', 'country')}
                {field('Expiry Date', 'expiry_date', 'date')}
                <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--brand)', margin: '10px 0 6px' }}>Transaction</div>
                {field('Property Address', 'property')}
                {field('Sales Representative / Broker', 'agent')}
                {field('Date Information Verified', 'date_verified', 'date')}
                {!readOnly && <button className="btn primary" style={{ width: '100%', marginTop: 10 }} onClick={confirmIdentity} disabled={saving}>{saving ? 'Saving…' : '💾 Save Details'}</button>}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
