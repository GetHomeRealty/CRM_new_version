import { useEffect, useState } from 'react';
import { getInvoice, createInvoice, updateInvoice, recordInvoicePayment, deleteInvoicePayment, createCustomer } from '../lib/api';
import { formatCurrency, parseNumber } from './format';
import { useToast } from './toast';
import InvoicePreviewModal from './InvoicePreviewModal';

const TERMS = ['Due on Receipt', 'Net 7', 'Net 15', 'Net 30', 'Custom'];
const TERM_DAYS = { 'Due on Receipt': 0, 'Net 7': 7, 'Net 15': 15, 'Net 30': 30 };
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (dateStr, n) => { const d = new Date(dateStr); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

const blankItem = () => ({ description: 'Co-op Commission', qty: 1, rate: 0, is_taxable: true });

export default function InvoiceEditorModal({ open, invoiceId, settings, customers, agents, onClose, onSaved }) {
  const toast = useToast();
  const taxRate = settings?.default_tax_rate ?? 13;
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState(null); // last persisted detail (for PDF/payments)
  const [saving, setSaving] = useState(false);
  const [pay, setPay] = useState({ paid_on: today(), amount: '', method: 'EFT', reference: '' });
  const [preview, setPreview] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (invoiceId) {
      getInvoice(invoiceId).then((d) => { setForm(toForm(d)); setSaved(d); });
    } else {
      setForm({
        property_reference: '', customer_id: '', customer_name: '', customer_address: '', customer_city: '',
        customer_province: '', customer_postal_code: '', customer_country: 'Canada',
        invoice_date: today(), terms: settings?.default_terms || 'Due on Receipt', due_date: today(),
        trade_number: '', listing_agent: '', coop_salesperson: '', subject: '', status: 'Draft',
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
    if (k === 'property_reference' && (!f.subject || f.subject === `CO-OP COMMISSION FOR ${f.property_reference}`)) {
      next.subject = `CO-OP COMMISSION FOR ${v}`;
    }
    return next;
  });
  const setItem = (i, k, v) => setForm((f) => ({ ...f, line_items: f.line_items.map((it, idx) => idx === i ? { ...it, [k]: v } : it) }));
  const addItem = () => setForm((f) => ({ ...f, line_items: [...f.line_items, blankItem()] }));
  const rmItem = (i) => setForm((f) => ({ ...f, line_items: f.line_items.filter((_, idx) => idx !== i) }));

  const pickCustomer = (id) => {
    set('customer_id', id);
    const c = customers.find((x) => String(x.id) === String(id));
    if (c) setForm((f) => ({ ...f, customer_id: id, customer_name: c.name, customer_address: c.address || '', customer_city: c.city || '', customer_province: c.province || '', customer_postal_code: c.postal_code || '', customer_country: c.country || 'Canada' }));
  };

  // live totals preview
  const subTotal = form.line_items.reduce((s, it) => s + parseNumber(it.qty) * parseNumber(it.rate), 0);
  const taxable = form.line_items.reduce((s, it) => s + (it.is_taxable ? parseNumber(it.qty) * parseNumber(it.rate) : 0), 0);
  const tax = Math.round(taxable * taxRate) / 100;
  const total = Math.round((subTotal + tax) * 100) / 100;

  const buildPayload = () => ({
    ...form,
    customer_id: form.customer_id || null,
    line_items: form.line_items.map((it) => ({ description: it.description, qty: parseNumber(it.qty), rate: parseNumber(it.rate), is_taxable: !!it.is_taxable })),
  });

  const save = async (issue) => {
    const payload = buildPayload();
    if (issue && payload.status === 'Draft') payload.status = 'Unpaid';
    setSaving(true);
    try {
      const d = invoiceId || saved?.id
        ? await updateInvoice(invoiceId || saved.id, payload)
        : await createInvoice(payload);
      setForm(toForm(d)); setSaved(d);
      toast('Invoice saved', 'ok');
      onSaved?.(d);
    } catch (e) {
      toast(e.response?.data?.message || 'Could not save invoice', 'bad');
    } finally { setSaving(false); }
  };

  const saveCustomer = async () => {
    if (!form.customer_name?.trim()) { toast('Enter a customer name first', 'bad'); return; }
    try {
      await createCustomer({ name: form.customer_name, address: form.customer_address, city: form.customer_city, province: form.customer_province, postal_code: form.customer_postal_code, country: form.customer_country });
      toast('Customer saved to master list', 'ok');
      onSaved?.(saved); // triggers parent reload of customers
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

  const rmPayment = async (pid) => {
    const d = await deleteInvoicePayment(saved.id, pid);
    setForm(toForm(d)); setSaved(d); onSaved?.(d);
  };

  const lbl = { fontSize: 11.5, color: 'var(--text-2)', fontWeight: 600, marginBottom: 5, display: 'block' };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal xl">
        <button className="close" onClick={onClose}>✕</button>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div className="modal-h" style={{ margin: 0, border: 0, padding: 0 }}>{saved ? saved.invoice_no : 'New Invoice'}{saved && <span className="pill info" style={{ marginLeft: 8, fontSize: 10 }}>{saved.display_status}</span>}</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {saved && <button className="btn ghost sm" onClick={() => setPreview(true)}>🖨 PDF</button>}
            <button className="btn ghost sm" onClick={() => save(false)} disabled={saving}>{saving ? 'Saving…' : 'Save Draft'}</button>
            <button className="btn primary sm" onClick={() => save(true)} disabled={saving}>Save &amp; Issue</button>
          </div>
        </div>

        {/* Meta */}
        <div className="modal-sub">Invoice Details</div>
        <div className="g3">
          <div className="field"><label style={lbl}>Property Reference</label><input value={form.property_reference} onChange={(e) => set('property_reference', e.target.value)} placeholder="e.g. 17 Knightsbridge Rd, #506" /></div>
          <div className="field"><label style={lbl}>Trade Number</label><input value={form.trade_number} onChange={(e) => set('trade_number', e.target.value)} /></div>
          <div className="field"><label style={lbl}>Status</label>
            <select value={form.status} onChange={(e) => set('status', e.target.value)}>
              <option>Draft</option><option>Unpaid</option><option>Partially Paid</option><option>Paid</option><option>Void</option>
            </select></div>
        </div>
        <div className="g3">
          <div className="field"><label style={lbl}>Invoice Date</label><input type="date" value={form.invoice_date} onChange={(e) => set('invoice_date', e.target.value)} /></div>
          <div className="field"><label style={lbl}>Terms</label>
            <select value={form.terms} onChange={(e) => set('terms', e.target.value)}>{TERMS.map((t) => <option key={t}>{t}</option>)}</select></div>
          <div className="field"><label style={lbl}>Due Date</label><input type="date" value={form.due_date || ''} disabled={form.terms !== 'Custom'} onChange={(e) => set('due_date', e.target.value)} style={form.terms !== 'Custom' ? { background: '#f9fafb' } : undefined} /></div>
        </div>
        <div className="g2">
          <div className="field"><label style={lbl}>Listing Agent / Sales Person</label><input list="agentList" value={form.listing_agent} onChange={(e) => set('listing_agent', e.target.value)} /><datalist id="agentList">{(agents || []).map((a) => <option key={a} value={a} />)}</datalist></div>
          <div className="field"><label style={lbl}>Co-op Salesperson</label><input list="agentList" value={form.coop_salesperson} onChange={(e) => set('coop_salesperson', e.target.value)} /></div>
        </div>
        <div className="field"><label style={lbl}>Subject</label><input value={form.subject} onChange={(e) => set('subject', e.target.value)} /></div>

        {/* Customer */}
        <div className="modal-sub" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Bill To (Customer)</span>
          <button className="btn ghost sm" onClick={saveCustomer}>💾 Save as customer</button>
        </div>
        <div className="g2">
          <div className="field"><label style={lbl}>Pick from master</label>
            <select value={form.customer_id || ''} onChange={(e) => pickCustomer(e.target.value)}>
              <option value="">— New / one-off —</option>
              {(customers || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select></div>
          <div className="field"><label style={lbl}>Customer Name</label><input value={form.customer_name} onChange={(e) => set('customer_name', e.target.value)} /></div>
        </div>
        <div className="g2">
          <div className="field"><label style={lbl}>Address</label><input value={form.customer_address} onChange={(e) => set('customer_address', e.target.value)} /></div>
          <div className="field"><label style={lbl}>City</label><input value={form.customer_city} onChange={(e) => set('customer_city', e.target.value)} /></div>
        </div>
        <div className="g3">
          <div className="field"><label style={lbl}>Postal Code</label><input value={form.customer_postal_code} onChange={(e) => set('customer_postal_code', e.target.value)} /></div>
          <div className="field"><label style={lbl}>Province</label><input value={form.customer_province} onChange={(e) => set('customer_province', e.target.value)} /></div>
          <div className="field"><label style={lbl}>Country</label><input value={form.customer_country} onChange={(e) => set('customer_country', e.target.value)} /></div>
        </div>

        {/* Line items */}
        <div className="modal-sub">Line Items</div>
        <table className="doc-table">
          <thead><tr><th style={{ width: 30 }}>#</th><th>Item &amp; Description</th><th style={{ width: 90 }}>Qty</th><th style={{ width: 120 }}>Rate</th><th style={{ width: 120 }}>Amount</th><th style={{ width: 70 }}>Taxable</th><th style={{ width: 40 }}></th></tr></thead>
          <tbody>
            {form.line_items.map((it, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td><input value={it.description} onChange={(e) => setItem(i, 'description', e.target.value)} /></td>
                <td><input value={it.qty} onChange={(e) => setItem(i, 'qty', e.target.value)} /></td>
                <td><input value={it.rate} onChange={(e) => setItem(i, 'rate', e.target.value)} /></td>
                <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatCurrency(parseNumber(it.qty) * parseNumber(it.rate))}</td>
                <td style={{ textAlign: 'center' }}><input type="checkbox" checked={!!it.is_taxable} onChange={(e) => setItem(i, 'is_taxable', e.target.checked)} /></td>
                <td>{form.line_items.length > 1 && <button className="row-rm" onClick={() => rmItem(i)}>🗑️</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="btn primary sm" style={{ marginTop: 8 }} onClick={addItem}>+ Add Line</button>

        {/* Totals */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
          <table style={{ minWidth: 300 }}><tbody>
            <tr><td style={{ padding: '4px 10px', color: 'var(--muted)' }}>Sub Total</td><td style={{ padding: '4px 10px', textAlign: 'right' }}>{formatCurrency(subTotal)}</td></tr>
            <tr><td style={{ padding: '4px 10px', color: 'var(--muted)' }}>HST ({taxRate}%)</td><td style={{ padding: '4px 10px', textAlign: 'right' }}>{formatCurrency(tax)}</td></tr>
            <tr><td style={{ padding: '6px 10px', fontWeight: 800, borderTop: '2px solid var(--text)' }}>Total</td><td style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 800, borderTop: '2px solid var(--text)' }}>{formatCurrency(total)}</td></tr>
            {saved && <tr><td style={{ padding: '4px 10px', color: '#166534' }}>Paid</td><td style={{ padding: '4px 10px', textAlign: 'right', color: '#166534' }}>{formatCurrency(saved.amount_paid)}</td></tr>}
            {saved && <tr><td style={{ padding: '4px 10px', fontWeight: 700, color: 'var(--brand)' }}>Balance Due</td><td style={{ padding: '4px 10px', textAlign: 'right', fontWeight: 700, color: 'var(--brand)' }}>{formatCurrency(saved.balance_due)}</td></tr>}
          </tbody></table>
        </div>

        {/* Payments (existing invoices only) */}
        {saved && (
          <>
            <div className="modal-sub">Payments &amp; History</div>
            <div className="g4" style={{ alignItems: 'end' }}>
              <div className="field"><label style={lbl}>Date</label><input type="date" value={pay.paid_on} onChange={(e) => setPay({ ...pay, paid_on: e.target.value })} /></div>
              <div className="field"><label style={lbl}>Amount</label><input value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} placeholder="0.00" /></div>
              <div className="field"><label style={lbl}>Method</label>
                <select value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}><option>EFT</option><option>Cheque</option><option>Wire</option><option>Cash</option><option>Bank Transfer</option></select></div>
              <div className="field"><label style={lbl}>Reference</label><input value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} /></div>
            </div>
            <button className="btn ok-btn sm" onClick={addPayment}>+ Record Payment</button>
            {saved.payments?.length > 0 && (
              <table className="doc-table" style={{ marginTop: 10 }}>
                <thead><tr><th>Date</th><th>Method</th><th>Reference</th><th style={{ textAlign: 'right' }}>Amount</th><th style={{ width: 40 }}></th></tr></thead>
                <tbody>
                  {saved.payments.map((p) => (
                    <tr key={p.id}>
                      <td>{p.paid_on}</td><td>{p.method || '—'}</td><td>{p.reference || '—'}</td>
                      <td style={{ textAlign: 'right' }}>{formatCurrency(p.amount)}</td>
                      <td><button className="row-rm" onClick={() => rmPayment(p.id)}>🗑️</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}

        <div className="actions"><button className="btn ghost" onClick={onClose}>Close</button></div>
      </div>

      {preview && saved && <InvoicePreviewModal open onClose={() => setPreview(false)} invoice={saved} />}
    </div>
  );
}

function toForm(d) {
  return {
    property_reference: d.property_reference || '', customer_id: d.customer_id || '', customer_name: d.customer_name || '',
    customer_address: d.customer_address || '', customer_city: d.customer_city || '', customer_province: d.customer_province || '',
    customer_postal_code: d.customer_postal_code || '', customer_country: d.customer_country || 'Canada',
    invoice_date: d.invoice_date || '', terms: d.terms || 'Due on Receipt', due_date: d.due_date || '',
    trade_number: d.trade_number || '', listing_agent: d.listing_agent || '', coop_salesperson: d.coop_salesperson || '',
    subject: d.subject || '', status: d.status || 'Draft',
    line_items: (d.line_items && d.line_items.length) ? d.line_items.map((it) => ({ description: it.description, qty: it.qty, rate: it.rate, is_taxable: it.is_taxable })) : [blankItem()],
  };
}
