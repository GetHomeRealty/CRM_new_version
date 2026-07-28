import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { getInvoice, createInvoice, updateInvoice, recordInvoiceReminder, recordInvoicePayment, sendInvoice } from '../lib/api';
import InvoiceDoc from './InvoiceDoc';
import BrandMark from './BrandMark';
import { reactToPdfBase64 } from './pdf';
import { formatCurrency, parseNumber, typeLabel } from './format';
import { useToast } from './toast';
import { apiErrorMessage } from '../lib/apiError';
import InvoicePreviewModal from './InvoicePreviewModal';
import MiniCalendar from './MiniCalendar';
import SavedBadge from './SavedBadge';
import type { CompanySettings, Invoice } from '../types';

const BRAND = '#c8102e';
const TERM_DAYS: Record<string, number> = { 'Due on Receipt': 0, 'Net 7': 7, 'Net 15': 15, 'Net 30': 30 };
const STATUSES = ['Paid', 'Overdue', 'Void', 'Due']; // §12.2
// Status colours: Due=blue, Overdue=red, Paid=green, Void=black.
const STATUS_COLOR: Record<string, string> = { Due: '#2563eb', Overdue: '#dc2626', Paid: '#16a34a', Void: '#111827', Unpaid: '#2563eb', 'Partially Paid': '#d97706', Draft: '#64748b' };
const COMM_VIA = ['Bank Transfer', 'Cash', 'EFT', 'Interac e-Transfer', 'Cheque'];
const AUTO_REMINDERS = [
  { mode: '2', label: 'Every 2 days (until Paid, excl. weekends/holidays)' },
  { mode: '3', label: 'Every 3 days (until Paid, excl. weekends/holidays)' },
  { mode: '5', label: 'Every 5 days (until Paid, excl. weekends/holidays)' },
  { mode: 'custom', label: 'Custom — pick dates' },
  { mode: 'off', label: 'Disable auto reminders' },
];
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (dateStr: string, n: number) => { const d = new Date(dateStr); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const blankItem = (): LineItem => ({ description: '', qty: 1, rate: 0, is_taxable: true });
const r2c = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

interface LineItem { description: string; qty: number | string; rate: number | string; is_taxable: boolean; }
interface AutoReminder { mode?: string; dates?: string[]; }
interface InvoiceForm {
  property_reference: string;
  customer_id: number | string | null;
  customer_name: string;
  customer_phone: string;
  emails: string[];
  customer_address: string;
  customer_city: string;
  customer_province: string;
  customer_postal_code: string;
  customer_country: string;
  invoice_date: string;
  terms: string;
  due_date: string;
  trade_number: string;
  listing_agent: string;
  coop_salesperson: string;
  subject: string;
  status: string;
  transaction_id: number | null;
  transaction_type: string;
  purchase_price: number | string | null;
  discount: number | string;
  customer_notes: string;
  terms_conditions: string;
  signature_path: string;
  commission_received_date: string;
  commission_received_via: string;
  auto_reminder: AutoReminder | null;
  broker_name: string;
  tax_rate: number | string;
  line_items: LineItem[];
  sent_at?: string | null;
}

interface InvoiceEditorModalProps {
  open: boolean;
  invoiceId?: number | null;
  settings?: CompanySettings | null;
  customers?: unknown;   // wired for a future customer picker; not currently read
  agents?: string[];     // wired for a future agent picker; not currently read
  onClose: () => void;
  onSaved?: (updated?: Invoice | null) => void;
  onBack?: () => void;
}

export default function InvoiceEditorModal({ open, invoiceId, settings, onClose, onSaved, onBack }: InvoiceEditorModalProps) {
  const toast = useToast();
  const navigate = useNavigate();
  const sigInputRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState<InvoiceForm | null>(null);
  const [saved, setSaved] = useState<Invoice | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false); // centered "Saved" badge
  const [sending, setSending] = useState(false); // Send Email in progress
  const [preview, setPreview] = useState(false);
  const [menu, setMenu] = useState(''); // '', 'status', 'reminder'
  const [edited, setEdited] = useState(false); // changed since the last send → shows "Resend"
  const [hstLocked, setHstLocked] = useState(true); // HST % locked at default until unlocked

  useEffect(() => {
    if (!open) return;
    if (invoiceId) {
      getInvoice(invoiceId).then((d) => { setForm(toForm(d)); setSaved(d); });
    } else {
      setForm({
        property_reference: '', customer_id: '', customer_name: '', customer_phone: '', emails: [''],
        customer_address: '', customer_city: '', customer_province: '', customer_postal_code: '', customer_country: 'Canada',
        invoice_date: today(), terms: settings?.default_terms || 'Due on Receipt', due_date: today(),
        trade_number: '', listing_agent: '', coop_salesperson: '', subject: '', status: 'Draft',
        transaction_id: null, transaction_type: '', purchase_price: null,
        discount: 0, customer_notes: settings?.thank_you_note || '', terms_conditions: '', signature_path: '',
        commission_received_date: '', commission_received_via: '', auto_reminder: null,
        broker_name: settings?.broker_name || 'Sai Venkata Ramesh Gollu',
        tax_rate: settings?.default_tax_rate ?? 13,
        line_items: [blankItem()],
      });
      setSaved(null);
    }
  }, [open, invoiceId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open || !form) return null;

  function set<K extends keyof InvoiceForm>(k: K, v: InvoiceForm[K]) {
    setEdited(true);
    setForm((f) => {
      if (!f) return f;
      const next: InvoiceForm = { ...f, [k]: v };
      if (k === 'terms' && v !== 'Custom') next.due_date = addDays(next.invoice_date, TERM_DAYS[String(v)] ?? 0);
      if (k === 'invoice_date' && next.terms !== 'Custom') next.due_date = addDays(String(v), TERM_DAYS[next.terms] ?? 0);
      return next;
    });
  }
  const setItem = (i: number, k: 'description', v: string) => { setEdited(true); setForm((f) => (f ? { ...f, line_items: f.line_items.map((it, idx) => idx === i ? { ...it, [k]: v } : it) } : f)); };
  const addItem = () => { setEdited(true); setForm((f) => (f ? { ...f, line_items: [...f.line_items, blankItem()] } : f)); };
  const rmItem = (i: number) => { setEdited(true); setForm((f) => (f ? { ...f, line_items: f.line_items.filter((_, idx) => idx !== i) } : f)); };
  // Single "Amount (CAD)" column → store as rate with qty 1.
  const setAmount = (i: number, v: string) => { setEdited(true); setForm((f) => (f ? { ...f, line_items: f.line_items.map((it, idx) => idx === i ? { ...it, rate: v, qty: 1 } : it) } : f)); };
  const amountOf = (it: LineItem) => (parseNumber(it.qty) === 1 ? it.rate : r2c(parseNumber(it.qty) * parseNumber(it.rate)));

  // Invoice email(s): first is the primary Invoice Email; user can add more.
  const setEmail = (i: number, v: string) => { setEdited(true); setForm((f) => (f ? { ...f, emails: f.emails.map((e, idx) => idx === i ? v : e) } : f)); };
  const addEmail = () => { setEdited(true); setForm((f) => (f ? { ...f, emails: [...f.emails, ''] } : f)); };
  const rmEmail = (i: number) => { setEdited(true); setForm((f) => (f ? { ...f, emails: f.emails.filter((_, idx) => idx !== i) } : f)); };

  const subTotal = form.line_items.reduce((s, it) => s + parseNumber(it.qty) * parseNumber(it.rate), 0);
  const taxable = form.line_items.reduce((s, it) => s + (it.is_taxable ? parseNumber(it.qty) * parseNumber(it.rate) : 0), 0);
  const tax = Math.round(taxable * parseNumber(form.tax_rate)) / 100;
  const discount = parseNumber(form.discount);
  const displaySubTotal = Math.round((subTotal + tax) * 100) / 100; // image "Sub Total" = items + HST
  const grandTotal = Math.round((displaySubTotal - discount) * 100) / 100;
  // Balance Due tracks the live grand total minus payments already recorded.
  const amountPaid = saved ? Number(saved.amount_paid) || 0 : 0;
  const balanceDue = Math.round((grandTotal - amountPaid) * 100) / 100;

  const buildPayload = (): Record<string, unknown> => ({
    ...form,
    customer_id: form.customer_id || null,
    customer_email: (form.emails || []).map((e) => e.trim()).filter(Boolean).join(', ') || null,
    discount: parseNumber(form.discount),
    line_items: form.line_items.map((it) => ({ description: it.description, qty: parseNumber(it.qty), rate: parseNumber(it.rate), is_taxable: !!it.is_taxable })),
  });

  const save = async (statusOverride?: string, extra: Record<string, unknown> = {}): Promise<Invoice | undefined> => {
    const payload = { ...buildPayload(), ...extra };
    if (statusOverride) payload.status = statusOverride;
    // §12.2 — Paid captures a Commission Received date if none given yet.
    if (payload.status === 'Paid' && !payload.commission_received_date) payload.commission_received_date = today();
    setSaving(true);
    try {
      const targetId = invoiceId || saved?.id;
      const d = targetId ? await updateInvoice(targetId, payload) : await createInvoice(payload);
      setForm(toForm(d)); setSaved(d);
      onSaved?.(d);
      return d;
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not save invoice'), 'bad');
      return undefined;
    } finally { setSaving(false); }
  };

  // Explicit Save button → show the centered "Saved" badge like the other modals.
  const saveClick = async () => {
    const d = await save();
    if (d) { setSavedOk(true); setTimeout(() => setSavedOk(false), 1600); }
  };

  const onStatus = async (v: string) => {
    setMenu('');
    set('status', v);
    // §12.3 — once settled (Paid or Void), auto-reminders are no longer needed → disable them.
    if (v === 'Paid' || v === 'Void') {
      setForm((f) => (f ? { ...f, auto_reminder: { mode: 'off' } } : f));
      await save(v, { auto_reminder: { mode: 'off' } });
    } else {
      await save(v);
    }
  };

  // Persist pending edits (e.g. a just-uploaded signature) so the preview/PDF reflects them.
  const openPdf = async () => { const d = (edited || !saved) ? await save() : saved; if (d) setPreview(true); };
  const backToTransaction = () => {
    if (onBack) { onBack(); return; } // opened in-context on the transaction page → just close
    const tid = saved?.transaction_id || form.transaction_id;
    if (tid) navigate(`/app/transactions/${tid}`); else onClose();
  };
  // Render the invoice document to a PDF (base64) so it can be attached to the email.
  const buildInvoicePdf = async (id: number, known: Invoice | null = null): Promise<{ pdf?: string; filename?: string }> => {
    try {
      const full = known && known.id === id ? known : await getInvoice(id);
      const pdf = await reactToPdfBase64(<InvoiceDoc invoice={full} />);
      return { pdf, filename: `${full.invoice_no || 'invoice'}.pdf` };
    } catch { return {}; } // attachment is best-effort — never block the send
  };
  const sendMail = async () => {
    if (sending) return;
    setMenu('');
    setSending(true);
    try {
      const d = (edited || !saved) ? await save() : saved;
      if (!d?.id) return;
      const wasSent = !!(saved?.sent_at || form.sent_at);
      const payload = await buildInvoicePdf(d.id, d); // reuse detail — no extra round-trip
      const upd = await sendInvoice(d.id, payload);
      setSaved(upd); setForm(toForm(upd)); setEdited(false);
      onSaved?.(upd);
      toast(wasSent ? 'Invoice resent (PDF attached) to the customer.' : 'Invoice sent (PDF attached) to the customer.', 'ok');
    } catch (e) { toast(apiErrorMessage(e, 'Could not send invoice'), 'bad'); }
    finally { setSending(false); }
  };
  // §12.3 — record a reminder (history of count + dates).
  const sendReminder = async () => {
    setMenu('');
    if (form.status === 'Paid' || form.status === 'Void') { toast(`Invoice is ${form.status} — no reminders needed`, 'info'); return; }
    if (!saved?.id) { toast('Save the invoice first', 'info'); return; }
    try {
      const payload = await buildInvoicePdf(saved.id);
      const d = await recordInvoiceReminder(saved.id, payload);
      setSaved(d); setForm(toForm(d));
      toast(`Reminder sent — ${(d.reminders || []).length} total`, 'ok'); onSaved?.(d);
    } catch { toast('Could not send reminder', 'bad'); }
  };
  const setAuto = async (mode: string) => {
    setMenu('');
    const auto: AutoReminder = mode === 'custom' ? { mode: 'custom', dates: form.auto_reminder?.dates || [] } : { mode };
    setForm((f) => (f ? { ...f, auto_reminder: auto } : f));
    await save(undefined, { auto_reminder: auto });
    if (mode === 'off') toast('Auto-reminders disabled', 'ok');
    else if (mode !== 'custom') toast(`Auto-reminders set: every ${mode} days until Paid`, 'ok');
  };
  const addCustomDate = (d: string) => setForm((f) => (f ? { ...f, auto_reminder: { mode: 'custom', dates: [...new Set([...(f.auto_reminder?.dates || []), d])].sort() } } : f));
  const rmCustomDate = (d: string) => setForm((f) => (f ? { ...f, auto_reminder: { mode: 'custom', dates: (f.auto_reminder?.dates || []).filter((x) => x !== d) } } : f));
  const toggleCustomDate = (d: string) => ((form.auto_reminder?.dates || []).includes(d) ? rmCustomDate(d) : addCustomDate(d));
  // Signature: read the chosen image, downscale it to a compact PNG data URL.
  const uploadSignature = () => sigInputRef.current?.click();
  const onSignatureFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast('Please choose an image file (PNG/JPG).', 'bad'); return; }
    if (file.size > 5 * 1024 * 1024) { toast('Signature image is too large (max 5 MB).', 'bad'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const MAX_W = 600, MAX_H = 240;
        const scale = Math.min(1, MAX_W / img.width, MAX_H / img.height);
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, w, h);
        set('signature_path', canvas.toDataURL('image/png'));
        toast('Signature added — remember to Save.', 'ok');
      };
      img.onerror = () => toast('Could not read the image file.', 'bad');
      img.src = reader.result as string;
    };
    reader.onerror = () => toast('Could not read the image file.', 'bad');
    reader.readAsDataURL(file);
  };

  // §12.2 — a recorded payment row, or the saved Commission Received date + method, count as recorded.
  const paymentRecorded = !!(saved?.status === 'Paid' && ((saved?.payments || []).length > 0 || (saved?.commission_received_date && saved?.commission_received_via)));
  const recordCommissionPayment = async () => {
    if (!form.commission_received_date || !form.commission_received_via) {
      toast('Enter the Commission Received date and "Received via" method before recording payment.', 'bad');
      return;
    }
    setSaving(true);
    try {
      let d = await save('Paid'); // persist commission fields + mark Paid
      if (!d?.id) return;
      // Record the actual payment for the outstanding balance (once) so Balance Due settles.
      if (Number(d.balance_due) > 0 && !(d.payments || []).length) {
        d = await recordInvoicePayment(d.id, {
          paid_on: form.commission_received_date,
          amount: Number(d.balance_due),
          method: form.commission_received_via,
        });
        setForm(toForm(d)); setSaved(d); onSaved?.(d);
      }
      toast('Payment recorded.', 'ok');
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not record payment'), 'bad');
    } finally { setSaving(false); }
  };

  // Reminders apply only until the invoice is settled — disabled once Paid or Void.
  const noReminders = form.status === 'Paid' || form.status === 'Void';

  // ---- styles ----
  const sideBtn: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '10px 12px', borderRadius: 8, border: '1px solid transparent', background: 'transparent', cursor: 'pointer', fontSize: 13.5, color: 'var(--text)' };
  const dLabel: CSSProperties = { background: '#fafbfd', color: '#64748b', textAlign: 'right', whiteSpace: 'nowrap', padding: '6px 10px', fontSize: 12, fontWeight: 600 };
  const cellInput: CSSProperties = { width: 160, textAlign: 'right' };
  const docInput = (extra: CSSProperties): CSSProperties => ({ border: '1px solid #e6e8ef', borderRadius: 6, padding: '6px 8px', ...extra });
  const sectionLbl: CSSProperties = { fontSize: 11, fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8, marginTop: 4 };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ width: '96vw', maxWidth: 1200, height: '92vh', padding: 0, display: 'flex', overflow: 'hidden' }}>
        {/* LEFT ACTION SIDEBAR */}
        <div style={{ width: 232, flexShrink: 0, borderRight: '1px solid var(--line)', background: '#fff', padding: 14, display: 'flex', flexDirection: 'column', gap: 4, overflowY: 'auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <strong style={{ fontSize: 15 }}>Invoice</strong>
            <button className="close" style={{ position: 'static' }} onClick={onClose}>✕</button>
          </div>
          <button style={sideBtn} onClick={backToTransaction} onMouseEnter={(e) => e.currentTarget.style.background = '#f3f4f6'} onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>← Back to transaction</button>

          <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', letterSpacing: '.05em', margin: '10px 0 2px 4px' }}>ACTIONS</div>

          {/* 1. Send → Sent → (on edit) Resend → (on resend) Sent. */}
          {paymentRecorded ? (
            <div style={{ ...sideBtn, justifyContent: 'center', background: '#16a34a', color: '#fff', fontWeight: 700, margin: '2px 0', cursor: 'default' }}>
              ✓ Paid
            </div>
          ) : (() => {
            const isSent = !!(saved?.sent_at || form.sent_at);
            const sentIdle = isSent && !edited; // sent with no changes since
            const label = sending ? '✉ Sending…' : (!isSent ? '✉ Send Email' : (edited ? '✉ Resend Email' : '✓ Sent'));
            return (
              <button
                style={{ ...sideBtn, justifyContent: 'center', background: sentIdle ? '#16a34a' : BRAND, color: '#fff', fontWeight: 700, margin: '2px 0', cursor: (sentIdle || sending) ? 'default' : 'pointer', opacity: (sentIdle || sending) ? 0.8 : 1 }}
                disabled={sentIdle || sending}
                onClick={sendMail}
              >{label}</button>
            );
          })()}

          {/* 2. Save Invoice */}
          <button style={sideBtn} onClick={saveClick} disabled={saving} onMouseEnter={(e) => e.currentTarget.style.background = '#f3f4f6'} onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>💾 {saving ? 'Saving…' : 'Save Invoice'}</button>

          {/* 3. Invoice Status */}
          <div style={{ position: 'relative' }}>
            <button style={{ ...sideBtn, justifyContent: 'space-between' }} onClick={() => setMenu(menu === 'status' ? '' : 'status')}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>🏷️ Status</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {form.status && <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: STATUS_COLOR[form.status] || '#64748b', borderRadius: 999, padding: '2px 8px' }}>{form.status}</span>}
                <span>▾</span>
              </span>
            </button>
            {menu === 'status' && (
              <div style={{ border: '1px solid var(--line)', borderRadius: 8, margin: '2px 0 6px', background: '#fff', boxShadow: '0 6px 18px rgba(0,0,0,.08)' }}>
                {STATUSES.map((s) => (
                  <button key={s} style={{ ...sideBtn, padding: '8px 12px' }} onClick={() => onStatus(s)}>{s}</button>
                ))}
              </div>
            )}
          </div>

          {/* §12.2 — when Paid, capture Commission Received date + via right here */}
          {form.status === 'Paid' && (
            <div style={{ border: '1px solid #bbf7d0', background: '#f0fdf4', borderRadius: 8, padding: 10, margin: '2px 0 6px' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#166534', marginBottom: 6 }}>Commission Received</div>
              <label style={{ fontSize: 11, color: '#475569', display: 'block', marginBottom: 2 }}>Date</label>
              <input type="date" value={form.commission_received_date} onChange={(e) => set('commission_received_date', e.target.value)} style={{ width: '100%', marginBottom: 8, border: '1px solid #e6e8ef', borderRadius: 6, padding: '6px 8px' }} />
              <label style={{ fontSize: 11, color: '#475569', display: 'block', marginBottom: 2 }}>Received via</label>
              <select value={form.commission_received_via} onChange={(e) => set('commission_received_via', e.target.value)} style={{ width: '100%', border: '1px solid #e6e8ef', borderRadius: 6, padding: '6px 8px' }}>
                <option value="">Select</option>{COMM_VIA.map((v) => <option key={v}>{v}</option>)}
              </select>
              {paymentRecorded ? (
                <button className="btn sm" style={{ marginTop: 8, width: '100%', background: '#16a34a', borderColor: '#16a34a', color: '#fff', fontWeight: 700, cursor: 'default' }} disabled>✓ Payment Recorded</button>
              ) : (
                <button className="btn primary sm" style={{ marginTop: 8, width: '100%' }} onClick={recordCommissionPayment} disabled={saving}>Record Payment</button>
              )}
            </div>
          )}

          {/* 4. Reminders — only until settled; disabled once the invoice is Paid or Void */}
          <div style={{ position: 'relative' }}>
            <button
              style={{ ...sideBtn, justifyContent: 'space-between', opacity: noReminders ? 0.5 : 1, cursor: noReminders ? 'not-allowed' : 'pointer' }}
              disabled={noReminders}
              title={noReminders ? `Invoice is ${form.status} — no reminders needed` : undefined}
              onClick={() => setMenu(menu === 'reminder' ? '' : 'reminder')}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>🔔 Reminders{noReminders ? ` (${form.status})` : ''}</span><span>▾</span>
            </button>
            {menu === 'reminder' && !noReminders && (
              <div style={{ border: '1px solid var(--line)', borderRadius: 8, margin: '2px 0 6px', background: '#fff', boxShadow: '0 6px 18px rgba(0,0,0,.08)' }}>
                <button style={{ ...sideBtn, padding: '8px 12px' }} onClick={sendReminder}>Send Reminder</button>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', padding: '6px 12px 2px' }}>SET UP AUTO REMINDERS</div>
                {AUTO_REMINDERS.map((o) => {
                  const active = (form.auto_reminder?.mode || '') === o.mode;
                  return (
                    <button key={o.mode} style={{ ...sideBtn, padding: '7px 12px', fontSize: 12, background: active ? '#eef2ff' : 'transparent', color: active ? '#3730a3' : 'var(--text)', fontWeight: active ? 700 : 400 }} onClick={() => setAuto(o.mode)}>
                      {active ? '✓ ' : ''}{o.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Custom reminder calendar — shown when "Custom" is chosen and not yet settled */}
          {form.auto_reminder?.mode === 'custom' && !noReminders && (
            <div style={{ border: '1px solid #c7d2fe', background: '#eef2ff', borderRadius: 8, padding: 10, margin: '2px 0 6px' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#3730a3', marginBottom: 6 }}>Custom reminder dates</div>
              <MiniCalendar selected={form.auto_reminder.dates || []} onToggle={toggleCustomDate} />
              {(form.auto_reminder.dates || []).length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
                  {(form.auto_reminder.dates || []).map((d) => <span key={d} className="pill info" style={{ fontSize: 10 }}>{d} <button className="row-rm" style={{ marginLeft: 2 }} onClick={() => rmCustomDate(d)}>×</button></span>)}
                </div>
              )}
              <button className="btn primary sm" style={{ marginTop: 8, width: '100%' }} onClick={saveClick} disabled={saving}>Save dates</button>
            </div>
          )}

          {/* 5. Print Invoice — always last */}
          <button style={sideBtn} onClick={openPdf} onMouseEnter={(e) => e.currentTarget.style.background = '#f3f4f6'} onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>🖨 Print Invoice</button>
        </div>

        {/* RIGHT: INVOICE DOCUMENT */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '28px 34px', background: '#fff' }}>
          {/* Letterhead */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18 }}>
            <BrandMark color={BRAND} height={96} version={settings?.updated_at} style={{ fontSize: 26 }} />
            <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: '1px' }}>INVOICE</div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 18 }}>
            <div style={{ fontSize: 12.5, lineHeight: 1.8 }}>
              <div style={{ fontWeight: 700 }}>{settings?.name || 'GetHomeRealty Inc'}</div>
              <div style={{ color: '#475569' }}>{settings?.address}</div>
              <div style={{ color: '#475569' }}>Phone: {settings?.phone}</div>
              <div style={{ color: '#475569' }}>Email: {settings?.email}</div>
              <div style={{ display: 'inline-block', marginTop: 12, border: `1px solid ${BRAND}`, color: BRAND, fontWeight: 700, padding: '8px 14px', borderRadius: 8 }}>
                Balance Due : {formatCurrency(balanceDue)}
              </div>
            </div>
            <table style={{ borderCollapse: 'separate', borderSpacing: '0 6px', width: '100%' }}><tbody>
              <tr><td style={dLabel}>Invoice Number:</td><td><input value={saved?.invoice_no || '(on save)'} readOnly style={docInput({ ...cellInput, background: '#f9fafb' })} /></td></tr>
              <tr><td style={dLabel}>Invoice Date:</td><td><input type="date" value={form.invoice_date} onChange={(e) => set('invoice_date', e.target.value)} style={docInput(cellInput)} /></td></tr>
              <tr><td style={dLabel}>Due Date:</td><td><input type="date" value={form.due_date || ''} disabled={form.terms !== 'Custom'} onChange={(e) => set('due_date', e.target.value)} style={docInput({ ...cellInput, background: form.terms !== 'Custom' ? '#f9fafb' : '#fff' })} /></td></tr>
              <tr><td style={dLabel}>Trade No.:</td><td><input value={form.trade_number} onChange={(e) => set('trade_number', e.target.value)} style={docInput(cellInput)} /></td></tr>
              <tr><td style={dLabel}>Deal Name:</td><td><input value={form.property_reference} onChange={(e) => set('property_reference', e.target.value)} style={docInput(cellInput)} /></td></tr>
              {form.purchase_price != null && <tr><td style={dLabel}>Purchase Price:</td><td><input value={form.purchase_price} readOnly style={docInput({ ...cellInput, background: '#f9fafb' })} /></td></tr>}
              {form.transaction_type && <tr><td style={dLabel}>Transaction Type:</td><td><input value={typeLabel(form.transaction_type)} readOnly style={docInput({ ...cellInput, background: '#f9fafb' })} /></td></tr>}
            </tbody></table>
          </div>

          <div style={{ borderTop: '1px solid #eef0f5', paddingTop: 12, marginBottom: 14 }}>
            <strong>Subject: </strong>
            <input value={form.subject} onChange={(e) => set('subject', e.target.value)} placeholder={`Co-op Commission for ${form.property_reference || ''}`} style={docInput({ width: '70%', marginLeft: 6 })} />
          </div>

          {/* CUSTOMER */}
          <div style={{ ...sectionLbl }}><span>CUSTOMER:</span></div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 460 }}>
            <input value={form.customer_name} onChange={(e) => set('customer_name', e.target.value)} placeholder="Listing Brokerage Name" style={docInput({})} />
            <input value={form.customer_address} onChange={(e) => set('customer_address', e.target.value)} placeholder="Address" style={docInput({})} />
            <input value={form.customer_phone} onChange={(e) => set('customer_phone', e.target.value)} placeholder="Phone Number" style={docInput({})} />
            {form.emails.map((em, i) => (
              <div key={i} style={{ display: 'flex', gap: 6 }}>
                <input type="email" value={em} onChange={(e) => setEmail(i, e.target.value)} placeholder={i === 0 ? 'Invoice Email' : `Additional Email ${i}`} style={docInput({ flex: 1 })} />
                {form.emails.length > 1 && <button className="row-rm" onClick={() => rmEmail(i)}>🗑️</button>}
              </div>
            ))}
            <div><button className="btn" style={{ border: `1px solid ${BRAND}`, color: BRAND, background: '#fff', borderRadius: 8, padding: '6px 12px', fontSize: 13 }} onClick={addEmail}>+ Add Email</button></div>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 10, color: '#334155' }}>
            <input type="checkbox" defaultChecked /> Billing Address = Shipping Address
          </label>

          {/* AGENT DETAILS — read-only, auto-fetched from the transaction */}
          <div style={{ ...sectionLbl, marginTop: 18 }}>AGENT DETAILS</div>
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 12.5, color: '#475569', marginBottom: 4 }}>Sales Person (Co-op Agent):</div>
            <input value={form.coop_salesperson} readOnly style={docInput({ width: '100%', background: '#f9fafb' })} />
          </div>
          <div>
            <div style={{ fontSize: 12.5, color: '#475569', marginBottom: 4 }}>Listing Agent / Sales Person:</div>
            <input value={form.listing_agent} readOnly placeholder="From Listing Brokerage Information → Listing Agent Name(s)" style={docInput({ width: '100%', background: '#f9fafb' })} />
          </div>

          {/* Description / Amount table */}
          <table style={{ borderCollapse: 'collapse', width: '100%', marginTop: 18 }}>
            <thead><tr>
              <th style={{ border: '1px solid #e6e8ef', background: '#f3f5f9', padding: '10px 12px', textAlign: 'left' }}>DESCRIPTION</th>
              <th style={{ border: '1px solid #e6e8ef', background: '#f3f5f9', padding: '10px 12px', textAlign: 'left', width: 260 }}>AMOUNT (CAD)</th>
              <th style={{ width: 36, border: '1px solid #e6e8ef', background: '#f3f5f9' }}></th>
            </tr></thead>
            <tbody>
              {form.line_items.map((it, i) => (
                <tr key={i}>
                  <td style={{ border: '1px solid #e6e8ef', padding: '8px 12px' }}><input value={it.description} onChange={(e) => setItem(i, 'description', e.target.value)} style={docInput({ width: '100%', fontWeight: 600 })} /></td>
                  <td style={{ border: '1px solid #e6e8ef', padding: '8px 12px' }}><input value={amountOf(it)} onChange={(e) => setAmount(i, e.target.value)} style={docInput({ width: '100%' })} /></td>
                  <td style={{ border: '1px solid #e6e8ef', textAlign: 'center' }}>{form.line_items.length > 1 && <button className="row-rm" onClick={() => rmItem(i)}>🗑️</button>}</td>
                </tr>
              ))}
              <tr>
                <td style={{ border: '1px solid #e6e8ef', padding: '8px 12px', fontWeight: 700 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    HST
                    {settings?.hst_number && <span style={{ fontWeight: 400, color: '#64748b', fontSize: 12 }}>(Number : {settings.hst_number})</span>}
                    <input value={form.tax_rate} readOnly={hstLocked} onChange={(e) => set('tax_rate', e.target.value)}
                      style={{ width: 52, textAlign: 'right', padding: '3px 6px', border: '1px solid #e6e8ef', borderRadius: 6, background: hstLocked ? '#f3f4f6' : '#fff', cursor: hstLocked ? 'not-allowed' : 'text' }} />
                    <span>%</span>
                    <button type="button" className="row-rm" title={hstLocked ? 'Unlock to edit HST %' : 'Lock HST % at default'} style={{ color: BRAND }} onClick={() => setHstLocked((v) => !v)}>{hstLocked ? '🔒' : '🔓'}</button>
                  </span>
                </td>
                <td style={{ border: '1px solid #e6e8ef', padding: '8px 12px' }}>{formatCurrency(tax)}</td>
                <td style={{ border: '1px solid #e6e8ef' }}></td>
              </tr>
            </tbody>
          </table>
          <button className="btn" style={{ border: `1px solid ${BRAND}`, color: BRAND, background: '#fff', borderRadius: 8, padding: '6px 14px', fontSize: 13, marginTop: 10 }} onClick={addItem}>+ Add Item</button>

          {/* Totals */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
            <table style={{ minWidth: 340 }}><tbody>
              <tr><td style={{ padding: '6px 14px', color: '#475569' }}>Sub Total</td><td style={{ padding: '6px 14px', textAlign: 'right', fontWeight: 700 }}>{formatCurrency(displaySubTotal)}</td></tr>
              <tr><td style={{ padding: '6px 14px', color: '#475569' }}>Discount</td><td style={{ padding: '6px 14px', textAlign: 'right' }}><input value={form.discount} onChange={(e) => set('discount', e.target.value)} style={docInput({ width: 120, textAlign: 'right' })} /></td></tr>
              <tr><td style={{ padding: '8px 14px', fontWeight: 800, borderTop: '2px solid #0f172a', fontSize: 15 }}>GRAND TOTAL</td><td style={{ padding: '8px 14px', textAlign: 'right', fontWeight: 800, borderTop: '2px solid #0f172a', fontSize: 15 }}>{formatCurrency(grandTotal)}</td></tr>
              {amountPaid > 0 && <tr><td style={{ padding: '4px 14px', color: '#166534' }}>Paid</td><td style={{ padding: '4px 14px', textAlign: 'right', color: '#166534' }}>{formatCurrency(amountPaid)}</td></tr>}
              <tr><td style={{ padding: '4px 14px', fontWeight: 700, color: BRAND }}>Balance Due</td><td style={{ padding: '4px 14px', textAlign: 'right', fontWeight: 700, color: BRAND }}>{formatCurrency(balanceDue)}</td></tr>
            </tbody></table>
          </div>

          {/* Notes & Terms */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginTop: 18, borderTop: '1px solid #eef0f5', paddingTop: 16 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>Customer Notes:</div>
              <textarea rows={3} value={form.customer_notes} onChange={(e) => set('customer_notes', e.target.value)} style={docInput({ width: '100%', resize: 'vertical' })} />
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>Terms &amp; Conditions:</div>
              <textarea rows={3} value={form.terms_conditions} onChange={(e) => set('terms_conditions', e.target.value)} placeholder="Terms and conditions..." style={docInput({ width: '100%', resize: 'vertical' })} />
            </div>
          </div>

          {/* Deposit Instructions + Signature */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginTop: 18 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>Deposit Instructions:</div>
              <div style={{ background: '#f8fafc', border: '1px solid #e6e8ef', borderRadius: 8, padding: 14, fontSize: 12.5, color: '#334155', lineHeight: 1.7 }}>
                <div style={{ fontWeight: 700 }}>Beneficiary Bank Account Detail:</div>
                <div>Beneficiary Name : {settings?.bank_beneficiary || '—'}</div>
                <div>Bank Name: {settings?.bank_name || '—'}</div>
                <div>Bank Transit Number: {settings?.transit_no || '—'}</div>
                <div>Account Number: {settings?.account_no || '—'}</div>
                <div>Institution Number: {settings?.institution_no || '—'}</div>
                <div style={{ fontWeight: 700 }}>HST Number : {settings?.hst_number || '—'}</div>
              </div>
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>Acknowledged by:</div>
              <input ref={sigInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onSignatureFile} />
              <button className="btn" style={{ border: `1px solid ${BRAND}`, color: BRAND, background: '#fff', borderRadius: 8, padding: '6px 14px', fontSize: 13 }} onClick={uploadSignature}>
                {form.signature_path ? 'Replace Signature Image' : 'Upload Signature Image'}
              </button>
              {form.signature_path && (
                <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
                  <img src={form.signature_path} alt="signature" style={{ maxHeight: 70, border: '1px solid #e6e8ef', borderRadius: 6, padding: 4 }} />
                  <button className="row-rm" title="Remove signature" onClick={() => set('signature_path', '')}>🗑️</button>
                </div>
              )}
              <div style={{ marginTop: 28, borderTop: '1px dashed #94a3b8', paddingTop: 6, fontSize: 11, fontStyle: 'italic', color: '#94a3b8', textAlign: 'center' }}>Signature</div>
              <div style={{ marginTop: 10, fontSize: 12.5 }}>
                <div style={{ fontStyle: 'italic', color: '#475569', marginBottom: 4 }}>(Broker Manager / Broker of Record):</div>
                <input value={form.broker_name} onChange={(e) => set('broker_name', e.target.value)} style={docInput({ width: '100%', fontWeight: 700 })} />
              </div>
            </div>
          </div>

          <div style={{ marginTop: 18, textAlign: 'center', fontStyle: 'italic', fontSize: 11.5, color: '#94a3b8', borderTop: '1px solid #eef0f5', paddingTop: 12 }}>
            This is a system-generated invoice from {settings?.name || 'GetHomeRealty Inc'}.
          </div>

        </div>
      </div>

      {preview && saved && <InvoicePreviewModal open onClose={() => setPreview(false)} invoice={saved} />}
      <SavedBadge show={savedOk} />
    </div>
  );
}

function toForm(d: Invoice): InvoiceForm {
  const emails = (d.customer_email || '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    property_reference: d.property_reference || '', customer_id: d.customer_id || '', customer_name: d.customer_name || '',
    customer_phone: d.customer_phone || '', emails: emails.length ? emails : [''],
    customer_address: d.customer_address || '', customer_city: d.customer_city || '', customer_province: d.customer_province || '',
    customer_postal_code: d.customer_postal_code || '', customer_country: d.customer_country || 'Canada',
    // Due Date follows the transaction closing date when present.
    invoice_date: d.invoice_date || '', terms: d.terms || 'Due on Receipt', due_date: d.closing_date || d.due_date || '',
    trade_number: String(d.trade_number || ''), listing_agent: d.listing_agent || '', coop_salesperson: d.coop_salesperson || '',
    subject: d.subject || '', status: d.status || 'Draft',
    transaction_id: d.transaction_id || null, transaction_type: d.transaction_type || '', purchase_price: d.purchase_price ?? null,
    discount: d.discount ?? 0, customer_notes: d.customer_notes || '', terms_conditions: d.terms_conditions || '', signature_path: d.signature_path || '',
    commission_received_date: d.commission_received_date || '', commission_received_via: d.commission_received_via || '', auto_reminder: d.auto_reminder || null,
    broker_name: d.broker_name || 'Sai Venkata Ramesh Gollu',
    tax_rate: d.tax_rate ?? 13,
    line_items: (d.line_items && d.line_items.length) ? d.line_items.map((it) => ({ description: it.description || '', qty: it.qty ?? 1, rate: it.rate ?? 0, is_taxable: it.is_taxable ?? true })) : [blankItem()],
  };
}
