import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getInvoices, getInvoice, getCustomers, getCompanySettings, listAgents, deleteInvoice } from '../lib/api';
import { formatCurrency, typeLabel } from './format';
import { useToast } from './toast';
import { apiErrorMessage } from '../lib/apiError';
import { useAuth } from '../context/AuthContext';
import InvoiceEditorModal, { STATUSES } from './InvoiceEditorModal';
import InvoicePreviewModal from './InvoicePreviewModal';
import CommissionAnalytics from './CommissionAnalytics';
import type { CompanySettings, Invoice } from '../types';

/** Rows per page. The server caps this at 200. */
const PER_PAGE = 25;

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
  /** Ledger-wide figures for the tiles — every invoice, not this page and not the filter. */
  const [totals, setTotals] = useState({ count: 0, outstanding: 0, paid_count: 0 });
  const [page, setPage] = useState(1);
  const [lastPage, setLastPage] = useState(1);
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

  /**
   * Fetch one page. `seq` guards against out-of-order responses — changing the status filter
   * quickly leaves several requests in flight, and a slow early reply must not repaint the table
   * over a fast later one.
   */
  const seq = useRef(0);
  const loadInvoices = (toPage = page, status = filter) => {
    const mine = ++seq.current;
    return getInvoices({ page: toPage, per_page: PER_PAGE, status })
      .then((res) => {
        if (mine !== seq.current) return;
        setInvoices(res.data);
        setTotals(res.totals);
        setLastPage(res.meta.last_page);
        // A filter can shrink the set past the page you were on.
        if (toPage > res.meta.last_page) setPage(res.meta.last_page);
      })
      .catch(() => { if (mine === seq.current) toast('Could not load invoices', 'bad'); });
  };

  useEffect(() => {
    Promise.all([loadInvoices(1, ''), getCustomers().catch(() => []), getCompanySettings(), listAgents().catch(() => [])])
      .then(([, cust, set, ag]) => { setCustomers(cust); setSettings(set); setAgents(ag); })
      .catch(() => toast('Could not load invoice module', 'bad'))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The status filter and the page are applied by the database now, so each change refetches.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    loadInvoices(page, filter);
  }, [page, filter]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // The rows ARE the page: filtering moved to the database, where it can see every invoice rather
  // than the twenty-five in front of it.
  const list = invoices;

  if (loading) return <div className="centered">Loading invoices…</div>;

  return (
    <>
      <CommissionAnalytics />
      <div className="tiles">
        <div className="stat-card"><div className="lbl">Invoices</div><div className="val">{totals.count}</div></div>
        <div className="stat-card"><div className="lbl">Outstanding Balance</div><div className="val" style={{ color: 'var(--brand)' }}>{formatCurrency(totals.outstanding)}</div></div>
        <div className="stat-card"><div className="lbl">Paid</div><div className="val" style={{ color: 'var(--ok-ink)' }}>{totals.paid_count}</div></div>
      </div>

      <div className="toolbar"><div className="toolbar-row">
        <select value={filter} onChange={(e) => { setPage(1); setFilter(e.target.value); }}>
          <option value="">All statuses</option>
          {/* TD-063 - the filter must offer every status an invoice can HOLD: everything the editor can SET, plus Draft and Partially Paid which the server derives. A second hard-coded list is what let 'Due' fall out of it. */}
          {[...new Set(['Draft', 'Unpaid', 'Partially Paid', ...STATUSES])].map((s) => <option key={s}>{s}</option>)}
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

      {/* Pager. Hidden when everything fits on one page, so a short ledger looks exactly as before. */}
      {lastPage > 1 && (
        <div className="toolbar" style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'flex-end', marginTop: 10 }}>
          <button className="btn ghost sm" disabled={page <= 1} onClick={() => setPage(1)}>« First</button>
          <button className="btn ghost sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹ Prev</button>
          <span style={{ fontSize: 12 }}>Page {page} of {lastPage}</span>
          <button className="btn ghost sm" disabled={page >= lastPage} onClick={() => setPage(page + 1)}>Next ›</button>
          <button className="btn ghost sm" disabled={page >= lastPage} onClick={() => setPage(lastPage)}>Last »</button>
        </div>
      )}

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
