import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getInvoices, getInvoice, getCustomers, getCompanySettings, listAgents, deleteInvoice } from '../lib/api';
import { formatCurrency, typeLabel } from './format';
import { useToast } from './toast';
import { apiErrorMessage } from '../lib/apiError';
import { useAuth } from '../context/AuthContext';
import InvoiceEditorModal from './InvoiceEditorModal';
import InvoicePreviewModal from './InvoicePreviewModal';
import CommissionAnalytics from './CommissionAnalytics';
import type { CompanySettings, Invoice } from '../types';

const STATUS_PILL: Record<string, string> = {
  Paid: 'ok', 'Partially Paid': 'warn', Unpaid: 'info', Overdue: 'bad', Void: 'bad', Draft: 'info', Due: 'info',
};

// Due/overdue warning from the transaction closing date.
function dueWarning(closing: string | null | undefined, status: string | undefined): { label: string; cls: string } | null {
  if (!closing || status === 'Paid' || status === 'Void') return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(closing + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return null;
  const days = Math.round((d.getTime() - today.getTime()) / 86400000);
  const s = (n: number) => (Math.abs(n) === 1 ? '' : 's');
  if (days < 0) return { label: `Overdue by ${-days} day${s(days)}`, cls: 'bad' };
  if (days === 0) return { label: 'Due today', cls: 'bad' };
  if (days <= 10) return { label: `Due in ${days} day${s(days)}`, cls: 'warn' };
  return { label: `Due in ${days} days`, cls: 'info' };
}

export default function InvoicePage() {
  const toast = useToast();
  const { can } = useAuth();
  const canEdit = can('invoice', 'edit');

  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [customers, setCustomers] = useState<unknown[]>([]);
  const [settings, setSettings] = useState<CompanySettings | null>(null);
  const [agents, setAgents] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [editorId, setEditorId] = useState<number | null | undefined>(undefined); // undefined=closed, null=new, number=edit
  const [preview, setPreview] = useState<Invoice | null>(null);
  const [filter, setFilter] = useState('');
  const [params, setParams] = useSearchParams();
  const [delTarget, setDelTarget] = useState<Invoice | null>(null); // invoice pending deletion (reason prompt)
  const [delReason, setDelReason] = useState('');
  const [deleting, setDeleting] = useState(false);

  // Open a specific invoice when arrived via ?open=<id> (e.g. "View Invoice" from a transaction).
  useEffect(() => {
    const openId = params.get('open');
    if (openId) { setEditorId(Number(openId)); params.delete('open'); setParams(params, { replace: true }); }
  }, [params, setParams]);

  const loadInvoices = () => getInvoices().then(setInvoices).catch(() => toast('Could not load invoices', 'bad'));

  useEffect(() => {
    Promise.all([getInvoices(), getCustomers().catch(() => []), getCompanySettings(), listAgents().catch(() => [])])
      .then(([inv, cust, set, ag]) => { setInvoices(inv); setCustomers(cust); setSettings(set); setAgents(ag); })
      .catch(() => toast('Could not load invoice module', 'bad'))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const openPdf = async (inv: Invoice) => {
    try { setPreview(await getInvoice(inv.id)); } catch { toast('Could not load invoice', 'bad'); }
  };

  const afterSave = () => { loadInvoices(); getCustomers().then(setCustomers).catch(() => {}); };

  const doDelete = async () => {
    if (!delTarget) return;
    setDeleting(true);
    try {
      await deleteInvoice(delTarget.id, delReason.trim());
      toast('Invoice deleted — recoverable from the Recycle Bin', 'ok');
      setDelTarget(null); setDelReason('');
      loadInvoices();
    } catch (e) { toast(apiErrorMessage(e, 'Could not delete invoice'), 'bad'); }
    finally { setDeleting(false); }
  };

  const list = invoices.filter((i) => !filter || i.display_status === filter);
  const totalOutstanding = invoices.reduce((s, i) => s + Number(i.balance_due || 0), 0);

  if (loading) return <div className="centered">Loading invoices…</div>;

  return (
    <>
      <CommissionAnalytics />
      <div className="tiles">
        <div className="stat-card"><div className="lbl">Invoices</div><div className="val">{invoices.length}</div></div>
        <div className="stat-card"><div className="lbl">Outstanding Balance</div><div className="val" style={{ color: 'var(--brand)' }}>{formatCurrency(totalOutstanding)}</div></div>
        <div className="stat-card"><div className="lbl">Paid</div><div className="val" style={{ color: '#166534' }}>{invoices.filter((i) => i.status === 'Paid').length}</div></div>
      </div>

      <div className="toolbar"><div className="toolbar-row">
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">All statuses</option>
          <option>Draft</option><option>Unpaid</option><option>Partially Paid</option><option>Paid</option><option>Overdue</option><option>Void</option>
        </select>
        <div style={{ flex: 1 }} />
        {canEdit && <button className="btn primary sm" onClick={() => setEditorId(null)}>+ New Invoice</button>}
      </div></div>

      <table className="list-table">
        <thead><tr><th>Invoice #</th><th>Customer</th><th>Property</th><th>Type</th><th>Agent</th><th>Date</th><th>Due / Overdue</th><th>Total</th><th>Balance</th><th>Status</th><th>Source</th><th>Actions</th></tr></thead>
        <tbody>
          {list.length === 0 ? (
            <tr><td colSpan={12} style={{ textAlign: 'center', color: 'var(--muted)', padding: 20 }}>No invoices. {canEdit && 'Click "+ New Invoice" to create one.'}</td></tr>
          ) : list.map((i) => (
            <tr key={i.id}>
              <td><strong>{i.invoice_no}</strong></td>
              <td>{i.customer_name || '—'}</td>
              <td>{i.property_reference || '—'}</td>
              <td>{i.transaction_type ? typeLabel(i.transaction_type) : '—'}</td>
              <td>{i.listing_agent || '—'}</td>
              <td>{i.closing_date || i.invoice_date || '—'}</td>
              <td>{(() => { const w = dueWarning(i.closing_date, i.status); return w ? <span className={`pill ${w.cls}`} style={{ fontSize: 10 }}>{w.label}</span> : '—'; })()}</td>
              <td>{formatCurrency(i.total)}</td>
              <td>{formatCurrency(i.balance_due)}</td>
              <td><span className={`pill ${STATUS_PILL[i.display_status || ''] || 'info'}`}>{i.display_status}</span></td>
              <td><span className={`pill ${i.source === 'transaction' ? 'warn' : 'info'}`} style={{ fontSize: 10 }}>{i.source === 'transaction' ? 'Transaction' : 'Manual'}</span></td>
              {/*
                Icons rather than labels, so four actions fit on one line and the column stops
                wrapping onto a second row.

                Every one carries a `title` and an `aria-label`. Dropping the words leaves the icon as
                the only clue, and a row of unlabelled glyphs beside a Delete is exactly where someone
                clicks the wrong thing — the tooltip and the screen-reader name are what keep it
                usable. Delete stays red, and still opens the confirmation it always did.
              */}
              <td>
                <div className="row-actions">
                  <button className="icon-btn" title="View invoice" aria-label="View invoice"
                    onClick={() => setEditorId(i.id)}>👁</button>
                  {canEdit && (
                    <button className="icon-btn" title="Edit invoice" aria-label="Edit invoice"
                      onClick={() => setEditorId(i.id)}>✎</button>
                  )}
                  <button className="icon-btn" title="Open the printable PDF" aria-label="Open the printable PDF"
                    onClick={() => openPdf(i)}>🖨</button>
                  {canEdit && (
                    <button className="icon-btn danger" title="Delete invoice" aria-label="Delete invoice"
                      onClick={() => { setDelTarget(i); setDelReason(''); }}>🗑</button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {editorId !== undefined && (
        <InvoiceEditorModal
          open
          invoiceId={editorId}
          settings={settings}
          customers={customers}
          agents={agents}
          onClose={() => setEditorId(undefined)}
          onSaved={afterSave}
        />
      )}
      {preview && <InvoicePreviewModal open onClose={() => setPreview(null)} invoice={preview} />}

      {delTarget && (
        <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) setDelTarget(null); }}
          style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 4000 }}>
          <div className="modal" style={{ maxWidth: 480, margin: 0 }}>
            <button className="close" onClick={() => setDelTarget(null)}>✕</button>
            <div className="modal-h" style={{ color: 'var(--bad)' }}>Delete invoice {delTarget.invoice_no}?</div>
            <p style={{ fontSize: 13, marginTop: 4 }}>Please give a reason for deleting this invoice. It's recoverable from the Recycle Bin, where the reason is shown.</p>
            <div className="field" style={{ marginTop: 8 }}>
              <label>Reason for deletion <span className="req">*</span></label>
              <textarea rows={3} value={delReason} onChange={(e) => setDelReason(e.target.value)} placeholder="e.g. Duplicate invoice created in error" autoFocus />
            </div>
            <div className="actions">
              <button className="btn ghost" onClick={() => setDelTarget(null)} disabled={deleting}>Cancel</button>
              <button className="btn primary" style={{ background: 'var(--bad)', borderColor: 'var(--bad)' }}
                onClick={doDelete} disabled={deleting || !delReason.trim()}>{deleting ? 'Deleting…' : 'Delete invoice'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
