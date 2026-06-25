import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getInvoice, createInvoice, updateInvoice, recordInvoicePayment, deleteInvoicePayment, createCustomer } from '../lib/api';
import { formatCurrency, parseNumber, typeLabel } from './format';
import { useToast } from './toast';
import InvoicePreviewModal from './InvoicePreviewModal';

const BRAND = '#c8102e';
const TERMS = ['Due on Receipt', 'Net 7', 'Net 15', 'Net 30', 'Custom'];
const TERM_DAYS = { 'Due on Receipt': 0, 'Net 7': 7, 'Net 15': 15, 'Net 30': 30 };
const STATUSES = ['Draft', 'Unpaid', 'Partially Paid', 'Paid', 'Void'];
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (dateStr, n) => { const d = new Date(dateStr); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const blankItem = () => ({ description: 'Co-op Commission', qty: 1, rate: 0, is_taxable: true });
const r2c = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export default function InvoiceEditorModal({ open, invoiceId, settings, customers, agents, onClose, onSaved, onBack }) {
  const toast = useToast();
  const navigate = useNavigate();
  const taxRate = settings?.default_tax_rate ?? 13;
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState(null);
  const [saving, setSaving] = useState(false);
  const [pay, setPay] = useState({ paid_on: today(), amount: '', method: 'EFT', reference: '' });
  const [preview, setPreview] = useState(false);
  const [menu, setMenu] = useState(''); // '', 'status', 'reminder'

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
        line_items: [blankItem()],
      });
      setSaved(null);
    }
  }, [open, invoiceId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open || !form) return null;

  const set = (k, v) => setForm((f) => {
    const next = { ...f, [k]: v };
    if (k === 'terms' && v !== 'Custom') next.due_date = addDays(next.invoice_date, TERM_DAYS[v] ?? 0);
    if (k === 'invoice_date' && next.terms !== 'Custom') next.due_date = addDays(v, TERM_DAYS[next.terms] ?? 0);
    return next;
  });
  const setItem = (i, k, v) => setForm((f) => ({ ...f, line_items: f.line_items.map((it, idx) => idx === i ? { ...it, [k]: v } : it) }));
  const addItem = () => setForm((f) => ({ ...f, line_items: [...f.line_items, blankItem()] }));
  const rmItem = (i) => setForm((f) => ({ ...f, line_items: f.line_items.filter((_, idx) => idx !== i) }));
  // Single "Amount (CAD)" column → store as rate with qty 1.
  const setAmount = (i, v) => setForm((f) => ({ ...f, line_items: f.line_items.map((it, idx) => idx === i ? { ...it, rate: v, qty: 1 } : it) }));
  const amountOf = (it) => (parseNumber(it.qty) === 1 ? it.rate : r2c(parseNumber(it.qty) * parseNumber(it.rate)));

  const pickCustomer = (id) => {
    const c = customers.find((x) => String(x.id) === String(id));
    setForm((f) => ({ ...f, customer_id: id, ...(c ? { customer_name: c.name, customer_address: c.address || '', customer_city: c.city || '', customer_province: c.province || '', customer_postal_code: c.postal_code || '', customer_country: c.country || 'Canada' } : {}) }));
  };

  // Email list helpers (Listing Brokerage Email 1, 2, … → stored comma-separated)
  const setEmail = (i, v) => setForm((f) => ({ ...f, emails: f.emails.map((e, idx) => idx === i ? v : e) }));
  const addEmail = () => setForm((f) => ({ ...f, emails: [...f.emails, ''] }));
  const rmEmail = (i) => setForm((f) => ({ ...f, emails: f.emails.filter((_, idx) => idx !== i) }));

  const subTotal = form.line_items.reduce((s, it) => s + parseNumber(it.qty) * parseNumber(it.rate), 0);
  const taxable = form.line_items.reduce((s, it) => s + (it.is_taxable ? parseNumber(it.qty) * parseNumber(it.rate) : 0), 0);
  const tax = Math.round(taxable * taxRate) / 100;
  const discount = parseNumber(form.discount);
  const displaySubTotal = Math.round((subTotal + tax) * 100) / 100; // image "Sub Total" = items + HST
  const grandTotal = Math.round((displaySubTotal - discount) * 100) / 100;
  const balanceDue = saved ? saved.balance_due : grandTotal;

  const buildPayload = () => ({
    ...form,
    customer_id: form.customer_id || null,
    customer_email: (form.emails || []).map((e) => e.trim()).filter(Boolean).join(', '),
    discount: parseNumber(form.discount),
    line_items: form.line_items.map((it) => ({ description: it.description, qty: parseNumber(it.qty), rate: parseNumber(it.rate), is_taxable: !!it.is_taxable })),
  });

  const save = async (statusOverride) => {
    const payload = buildPayload();
    if (statusOverride) payload.status = statusOverride;
    setSaving(true);
    try {
      const d = (invoiceId || saved?.id)
        ? await updateInvoice(invoiceId || saved.id, payload)
        : await createInvoice(payload);
      setForm(toForm(d)); setSaved(d);
      toast('Saved', 'ok');
      onSaved?.(d);
      return d;
    } catch (e) {
      toast(e.response?.data?.message || 'Could not save invoice', 'bad');
    } finally { setSaving(false); }
  };

  const onStatus = async (v) => { setMenu(''); set('status', v); await save(v); };

  const saveCustomer = async () => {
    if (!form.customer_name?.trim()) { toast('Enter a customer name first', 'bad'); return; }
    try {
      await createCustomer({ name: form.customer_name, address: form.customer_address, city: form.customer_city, province: form.customer_province, postal_code: form.customer_postal_code, country: form.customer_country });
      toast('Customer saved to master list', 'ok'); onSaved?.(saved);
    } catch { toast('Could not save customer', 'bad'); }
  };

  const addPayment = async () => {
    if (!saved?.id) { toast('Save the invoice first', 'info'); return; }
    if (!pay.amount || parseNumber(pay.amount) <= 0) { toast('Enter a payment amount', 'bad'); return; }
    try {
      const d = await recordInvoicePayment(saved.id, { ...pay, amount: parseNumber(pay.amount) });
      setForm(toForm(d)); setSaved(d); setPay({ paid_on: today(), amount: '', method: 'EFT', reference: '' });
      toast('Payment recorded', 'ok'); onSaved?.(d);
    } catch (e) { toast(e.response?.data?.message || 'Could not record payment', 'bad'); }
  };
  const rmPayment = async (pid) => { const d = await deleteInvoicePayment(saved.id, pid); setForm(toForm(d)); setSaved(d); onSaved?.(d); };

  const openPdf = async () => { const d = saved || (await save()); if (d) setPreview(true); };
  const backToTransaction = () => {
    if (onBack) { onBack(); return; } // opened in-context on the transaction page → just close
    const tid = saved?.transaction_id || form.transaction_id;
    if (tid) navigate(`/app/transactions/${tid}`); else onClose();
  };
  const sendMail = () => { setMenu(''); toast('Email delivery is set up in the Reminders/Email module (next phase).', 'info'); };
  const sendReminder = () => { setMenu(''); toast('Reminder sending is part of the Reminders module (next phase).', 'info'); };
  const autoReminder = () => { setMenu(''); toast('Auto-reminder scheduling is part of the Reminders module (next phase).', 'info'); };
  const uploadSignature = () => toast('Signature image upload will be enabled with file storage (next phase).', 'info');

  // ---- styles ----
  const sideBtn = { display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '10px 12px', borderRadius: 8, border: '1px solid transparent', background: 'transparent', cursor: 'pointer', fontSize: 13.5, color: 'var(--text)' };
  const dLabel = { background: '#fafbfd', color: '#64748b', textAlign: 'right', whiteSpace: 'nowrap', padding: '6px 10px', fontSize: 12, fontWeight: 600 };
  const cellInput = { width: 160, textAlign: 'right' };
  const docInput = (extra) => ({ border: '1px solid #e6e8ef', borderRadius: 6, padding: '6px 8px', ...extra });
  const sectionLbl = { fontSize: 11, fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8, marginTop: 4 };

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

          {/* Status */}
          <div style={{ position: 'relative' }}>
            <button style={{ ...sideBtn, justifyContent: 'space-between' }} onClick={() => setMenu(menu === 'status' ? '' : 'status')}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>⊘ {form.status}</span><span>▾</span>
            </button>
            {menu === 'status' && (
              <div style={{ border: '1px solid var(--line)', borderRadius: 8, margin: '2px 0 6px', background: '#fff', boxShadow: '0 6px 18px rgba(0,0,0,.08)' }}>
                {STATUSES.map((s) => (
                  <button key={s} style={{ ...sideBtn, padding: '8px 12px' }} onClick={() => onStatus(s)}>{s}</button>
                ))}
              </div>
            )}
          </div>

          {/* Reminder */}
          <div style={{ position: 'relative' }}>
            <button style={{ ...sideBtn, justifyContent: 'space-between' }} onClick={() => setMenu(menu === 'reminder' ? '' : 'reminder')}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>🔔 Reminder</span><span>▾</span>
            </button>
            {menu === 'reminder' && (
              <div style={{ border: '1px solid var(--line)', borderRadius: 8, margin: '2px 0 6px', background: '#fff', boxShadow: '0 6px 18px rgba(0,0,0,.08)' }}>
                <button style={{ ...sideBtn, padding: '8px 12px' }} onClick={sendReminder}>Send Reminder</button>
                <button style={{ ...sideBtn, padding: '8px 12px' }} onClick={autoReminder}>Set up Auto Reminders</button>
              </div>
            )}
          </div>

          <button style={{ ...sideBtn, justifyContent: 'center', background: BRAND, color: '#fff', fontWeight: 700, margin: '4px 0' }} onClick={sendMail}>✉ Send Mail</button>
          <button style={sideBtn} onClick={() => save()} disabled={saving} onMouseEnter={(e) => e.currentTarget.style.background = '#f3f4f6'} onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>💾 {saving ? 'Saving…' : 'Save Invoice'}</button>
          <button style={sideBtn} onClick={openPdf} onMouseEnter={(e) => e.currentTarget.style.background = '#f3f4f6'} onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>🖨 Print</button>
          <button style={sideBtn} onClick={openPdf} onMouseEnter={(e) => e.currentTarget.style.background = '#f3f4f6'} onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>⬇ Download PDF</button>
        </div>

        {/* RIGHT: INVOICE DOCUMENT */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '28px 34px', background: '#fff' }}>
          {/* Letterhead */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18 }}>
            <div style={{ fontSize: 26, fontWeight: 800, color: BRAND, letterSpacing: '-0.5px' }}>
              GET<span style={{ color: '#0f172a' }}>&#9730;</span>HOME REALTY
              <div style={{ fontSize: 11, color: '#64748b', fontStyle: 'italic', fontWeight: 400 }}>"A Tradition of Trust" — Brokerage</div>
            </div>
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
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', ...sectionLbl }}>
            <span>CUSTOMER:</span>
            <button className="btn ghost sm" onClick={saveCustomer}>💾 Save as customer</button>
          </div>
          {(customers || []).length > 0 && (
            <select value={form.customer_id || ''} onChange={(e) => pickCustomer(e.target.value)} style={docInput({ width: '100%', marginBottom: 8 })}>
              <option value="">— New / one-off —</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 460 }}>
            <input value={form.customer_name} onChange={(e) => set('customer_name', e.target.value)} placeholder="Listing Brokerage Name" style={docInput({})} />
            <input value={form.customer_address} onChange={(e) => set('customer_address', e.target.value)} placeholder="Address" style={docInput({})} />
            <input value={form.customer_phone} onChange={(e) => set('customer_phone', e.target.value)} placeholder="Phone Number" style={docInput({})} />
            {form.emails.map((em, i) => (
              <div key={i} style={{ display: 'flex', gap: 6 }}>
                <input value={em} onChange={(e) => setEmail(i, e.target.value)} placeholder={`Listing Brokerage Email ${i + 1}`} style={docInput({ flex: 1 })} />
                {form.emails.length > 1 && <button className="row-rm" onClick={() => rmEmail(i)}>🗑️</button>}
              </div>
            ))}
            <div><button className="btn" style={{ border: `1px solid ${BRAND}`, color: BRAND, background: '#fff', borderRadius: 8, padding: '6px 12px', fontSize: 13 }} onClick={addEmail}>+ Add New</button></div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, maxWidth: 460, marginTop: 8 }}>
            <input value={form.customer_city} onChange={(e) => set('customer_city', e.target.value)} placeholder="City" style={docInput({})} />
            <input value={form.customer_province} onChange={(e) => set('customer_province', e.target.value)} placeholder="Province" style={docInput({})} />
            <input value={form.customer_postal_code} onChange={(e) => set('customer_postal_code', e.target.value)} placeholder="Postal Code" style={docInput({})} />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 10, color: '#334155' }}>
            <input type="checkbox" defaultChecked /> Billing Address = Shipping Address
          </label>

          {/* AGENT DETAILS */}
          <div style={{ ...sectionLbl, marginTop: 18 }}>AGENT DETAILS</div>
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 12.5, color: '#475569', marginBottom: 4 }}>Sales Person (Co-op Agent):</div>
            <input list="agentList" value={form.coop_salesperson} onChange={(e) => set('coop_salesperson', e.target.value)} style={docInput({ width: '100%' })} />
          </div>
          <div>
            <div style={{ fontSize: 12.5, color: '#475569', marginBottom: 4 }}>Listing Agent / Sales Person:</div>
            <input list="agentList" value={form.listing_agent} onChange={(e) => set('listing_agent', e.target.value)} placeholder="Enter agent names separated by commas" style={docInput({ width: '100%' })} />
          </div>
          <datalist id="agentList">{(agents || []).map((a) => <option key={a} value={a} />)}</datalist>

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
                <td style={{ border: '1px solid #e6e8ef', padding: '8px 12px', fontWeight: 700 }}>HST({taxRate})</td>
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
              {saved && <tr><td style={{ padding: '4px 14px', color: '#166534' }}>Paid</td><td style={{ padding: '4px 14px', textAlign: 'right', color: '#166534' }}>{formatCurrency(saved.amount_paid)}</td></tr>}
              {saved && <tr><td style={{ padding: '4px 14px', fontWeight: 700, color: BRAND }}>Balance Due</td><td style={{ padding: '4px 14px', textAlign: 'right', fontWeight: 700, color: BRAND }}>{formatCurrency(saved.balance_due)}</td></tr>}
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
                <div style={{ marginTop: 10, fontWeight: 700 }}>HST Number : {settings?.hst_number || '—'}</div>
              </div>
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>Acknowledged by:</div>
              <button className="btn" style={{ border: `1px solid ${BRAND}`, color: BRAND, background: '#fff', borderRadius: 8, padding: '6px 14px', fontSize: 13 }} onClick={uploadSignature}>Upload Signature Image</button>
              {form.signature_path && <div style={{ marginTop: 10 }}><img src={form.signature_path} alt="signature" style={{ maxHeight: 70 }} /></div>}
              <div style={{ marginTop: 28, borderTop: '1px dashed #94a3b8', paddingTop: 6, fontSize: 11, fontStyle: 'italic', color: '#94a3b8', textAlign: 'center' }}>Signature</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, fontSize: 12.5 }}>
                <span style={{ fontStyle: 'italic', color: '#475569' }}>(Broker Manager / Broker of Record):</span>
                <strong>{settings?.broker_name || 'Sai Venkata Ramesh Gollu'}</strong>
              </div>
            </div>
          </div>

          <div style={{ marginTop: 18, textAlign: 'center', fontStyle: 'italic', fontSize: 11.5, color: '#94a3b8', borderTop: '1px solid #eef0f5', paddingTop: 12 }}>
            This is a system-generated invoice from {settings?.name || 'GetHomeRealty Inc'}.
          </div>

          {/* Payments */}
          {saved && (
            <>
              <div className="modal-sub">Payments &amp; History</div>
              <div className="g4" style={{ alignItems: 'end' }}>
                <div className="field"><label style={{ fontSize: 11.5 }}>Date</label><input type="date" value={pay.paid_on} onChange={(e) => setPay({ ...pay, paid_on: e.target.value })} /></div>
                <div className="field"><label style={{ fontSize: 11.5 }}>Amount</label><input value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} placeholder="0.00" /></div>
                <div className="field"><label style={{ fontSize: 11.5 }}>Method</label>
                  <select value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}><option>EFT</option><option>Cheque</option><option>Wire</option><option>Cash</option><option>Bank Transfer</option><option>Interac e-Transfer</option></select></div>
                <div className="field"><label style={{ fontSize: 11.5 }}>Reference</label><input value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} /></div>
              </div>
              <button className="btn ok-btn sm" onClick={addPayment}>+ Record Payment</button>
              {saved.payments?.length > 0 && (
                <table className="doc-table" style={{ marginTop: 10 }}>
                  <thead><tr><th>Date</th><th>Method</th><th>Reference</th><th style={{ textAlign: 'right' }}>Amount</th><th style={{ width: 36 }}></th></tr></thead>
                  <tbody>
                    {saved.payments.map((p) => (
                      <tr key={p.id}><td>{p.paid_on}</td><td>{p.method || '—'}</td><td>{p.reference || '—'}</td><td style={{ textAlign: 'right' }}>{formatCurrency(p.amount)}</td><td><button className="row-rm" onClick={() => rmPayment(p.id)}>🗑️</button></td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      </div>

      {preview && saved && <InvoicePreviewModal open onClose={() => setPreview(false)} invoice={saved} />}
    </div>
  );
}

function toForm(d) {
  const emails = (d.customer_email || '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    property_reference: d.property_reference || '', customer_id: d.customer_id || '', customer_name: d.customer_name || '',
    customer_phone: d.customer_phone || '', emails: emails.length ? emails : [''],
    customer_address: d.customer_address || '', customer_city: d.customer_city || '', customer_province: d.customer_province || '',
    customer_postal_code: d.customer_postal_code || '', customer_country: d.customer_country || 'Canada',
    invoice_date: d.invoice_date || '', terms: d.terms || 'Due on Receipt', due_date: d.due_date || '',
    trade_number: d.trade_number || '', listing_agent: d.listing_agent || '', coop_salesperson: d.coop_salesperson || '',
    subject: d.subject || '', status: d.status || 'Draft',
    transaction_id: d.transaction_id || null, transaction_type: d.transaction_type || '', purchase_price: d.purchase_price ?? null,
    discount: d.discount ?? 0, customer_notes: d.customer_notes || '', terms_conditions: d.terms_conditions || '', signature_path: d.signature_path || '',
    line_items: (d.line_items && d.line_items.length) ? d.line_items.map((it) => ({ description: it.description, qty: it.qty, rate: it.rate, is_taxable: it.is_taxable })) : [blankItem()],
  };
}
