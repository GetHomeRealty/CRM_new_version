import { deskPath } from './area';
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getTrashedTransactions, restoreTransaction, forceDeleteTransaction,
  getTrashedDocuments, restoreTrashedDocument, forceDeleteTrashedDocument,
  getTrashedInvoices, restoreTrashedInvoice, forceDeleteTrashedInvoice,
  getTrashedPayments, restoreTrashedPayment, forceDeleteTrashedPayment,
  getTrashedRowItems, restoreTrashedRowItem, forceDeleteTrashedRowItem,
  getDeletionLog,
} from '../lib/api';
import { formatCurrency, typeLabel } from './format';
import { useToast } from './toast';
import { apiErrorMessage } from '../lib/apiError';
import { useAuth } from '../context/AuthContext';
import ConfirmDialog, { useConfirm } from './ConfirmDialog';
import type {
  DeletionLogEntry, TrashedDocument, TrashedInvoice, TrashedPayment, TrashedRowItem, TrashedTransaction,
} from '../types';

type TrashType = 'transactions' | 'documents' | 'invoices' | 'payments' | 'rows';
type TrashAction = (id: number | string) => Promise<unknown>;

const RESTORE: Record<TrashType, TrashAction> = { transactions: restoreTransaction, documents: restoreTrashedDocument, invoices: restoreTrashedInvoice, payments: restoreTrashedPayment, rows: restoreTrashedRowItem };
const FORCE: Record<TrashType, TrashAction> = { transactions: forceDeleteTransaction, documents: forceDeleteTrashedDocument, invoices: forceDeleteTrashedInvoice, payments: forceDeleteTrashedPayment, rows: forceDeleteTrashedRowItem };

interface RecycleData {
  transactions: TrashedTransaction[];
  documents: TrashedDocument[];
  invoices: TrashedInvoice[];
  payments: TrashedPayment[];
  rows: TrashedRowItem[];
  log: DeletionLogEntry[];
}

export default function RecycleBinPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const { isSuperAdmin } = useAuth();
  const { confirm, askDelete, closeConfirm } = useConfirm();

  const [data, setData] = useState<RecycleData>({ transactions: [], documents: [], invoices: [], payments: [], rows: [], log: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('transactions');

  const load = () => {
    setLoading(true);
    Promise.all([
      getTrashedTransactions().catch(() => ({ items: [] })),
      getTrashedDocuments().catch(() => ({ items: [] })),
      getTrashedInvoices().catch(() => ({ items: [] })),
      getTrashedPayments().catch(() => ({ items: [] })),
      getTrashedRowItems().catch(() => ({ items: [] })),
      getDeletionLog().catch(() => ({ items: [] })),
    ])
      .then(([t, d, i, p, rw, l]) => setData({ transactions: t.items || [], documents: d.items || [], invoices: i.items || [], payments: p.items || [], rows: rw.items || [], log: l.items || [] }))
      .catch(() => toast('Could not load the Recycle Bin', 'bad'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { if (isSuperAdmin) load(); }, [isSuperAdmin]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isSuperAdmin) {
    return <div className="card stub"><h2>🔒 Super Admin only</h2><p>The Recycle Bin is available to Super Admins.</p></div>;
  }

  const doRestore = async (type: TrashType, id: number | string, label: string) => {
    setBusy(true);
    try { await RESTORE[type](id); toast(`${label} restored`, 'ok'); load(); }
    catch (e) { toast(apiErrorMessage(e, 'Could not restore'), 'bad'); }
    finally { setBusy(false); }
  };
  const doForce = (type: TrashType, id: number | string, label: string, linked?: string[]) => askDelete({
    title: `Permanently delete ${label}?`,
    message: 'This removes it for good and cannot be undone.',
    linked: linked || [],
    onConfirm: async () => {
      setBusy(true);
      try { await FORCE[type](id); toast(`${label} permanently deleted`, 'ok'); load(); }
      catch (e) { toast(apiErrorMessage(e, 'Could not delete'), 'bad'); }
      finally { setBusy(false); }
    },
  });

  const actions = (type: TrashType, id: number | string, label: string, linked?: string[]) => (
    <span style={{ whiteSpace: 'nowrap' }}>
      <button className="btn primary sm" onClick={() => doRestore(type, id, label)} disabled={busy}>↺ Restore</button>
      <button className="btn sm" style={{ marginLeft: 6, background: '#dc2626', color: '#fff' }} onClick={() => doForce(type, id, label, linked)} disabled={busy}>🗑 Delete forever</button>
    </span>
  );
  const txnCell = (id: number | string | null | undefined, tradeNo: number | string | undefined, trashed: boolean | undefined): ReactNode => (id
    ? (trashed
      ? <span className="pill warn" style={{ fontSize: 10 }} title="Transaction is also in the bin — restore it to recover this too">Trade #{tradeNo} (deleted)</span>
      : <button className="btn ghost sm" onClick={() => navigate(deskPath(`transactions/${id}`))}>Trade #{tradeNo} ↗</button>)
    : '—');

  const TABS: [string, string, number][] = [
    ['transactions', '🗑 Transactions', data.transactions.length],
    ['documents', '📄 Documents', data.documents.length],
    ['invoices', '🧾 Invoices', data.invoices.length],
    ['payments', '💵 Payments', data.payments.length + data.rows.length],
    ['log', '📜 Deletion Log', 0],
  ];

  return (
    <>
      <div className="tiles">
        <div className="stat-card"><div className="lbl">Transactions</div><div className="val" style={{ color: 'var(--brand)' }}>{data.transactions.length}</div></div>
        <div className="stat-card"><div className="lbl">Documents</div><div className="val">{data.documents.length}</div></div>
        <div className="stat-card"><div className="lbl">Invoices</div><div className="val">{data.invoices.length}</div></div>
        <div className="stat-card"><div className="lbl">Payments &amp; Commission</div><div className="val">{data.payments.length + data.rows.length}</div></div>
      </div>

      <div className="toolbar"><div className="toolbar-row" style={{ gap: 8 }}>
        {TABS.map(([key, label, n]) => (
          <button key={key} className={`btn ${tab === key ? 'primary' : 'ghost'} sm`} onClick={() => setTab(key)}>{label}{n > 0 ? ` (${n})` : ''}</button>
        ))}
        <div style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={load} disabled={loading}>↻ Refresh</button>
      </div></div>

      {loading ? <div className="centered">Loading…</div> : (
        <>
          {tab === 'transactions' && (
            <table className="list-table">
              <thead><tr><th>Trade #</th><th>Type</th><th>Property</th><th>Agent</th><th>Price</th><th>Deleted</th><th>Requested by</th><th>Actions</th></tr></thead>
              <tbody>
                {data.transactions.length === 0 ? <tr><td colSpan={8} className="empty-cell">No deleted transactions. 🎉</td></tr>
                  : data.transactions.map((t) => (
                    <tr key={t.id}>
                      <td><strong>{t.trade_no}</strong></td>
                      <td>{t.type ? typeLabel(t.type) : '—'}</td>
                      <td>{t.property || '—'}</td>
                      <td>{t.agent || '—'}</td>
                      <td>{formatCurrency(t.price)}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{t.deleted_at || '—'}</td>
                      <td>{t.requested_by || '—'}{t.reason ? <div style={{ fontSize: 11, color: 'var(--muted)' }} title={t.reason}>{t.reason.length > 40 ? `${t.reason.slice(0, 40)}…` : t.reason}</div> : null}</td>
                      <td>{actions('transactions', t.id, `Trade #${t.trade_no}`, ['Documents, invoices, adjustments, admin activities and history for this transaction'])}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}

          {tab === 'documents' && (
            <table className="list-table">
              <thead><tr><th>Document</th><th>Status</th><th>Validation</th><th>File</th><th>Deleted</th><th>Transaction</th><th>Actions</th></tr></thead>
              <tbody>
                {data.documents.length === 0 ? <tr><td colSpan={7} className="empty-cell">No deleted documents.</td></tr>
                  : data.documents.map((d) => (
                    <tr key={d.id}>
                      <td><strong>{d.title}</strong></td>
                      <td>{d.status || '—'}</td>
                      <td>{d.validation || '—'}</td>
                      <td>{d.has_file ? '📎 1' : ((d.file_count ?? 0) > 0 ? `📎 ${d.file_count}` : '—')}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{d.deleted_at || '—'}</td>
                      <td>{txnCell(d.transaction_id, d.trade_no, d.transaction_trashed)}</td>
                      <td>{actions('documents', d.id, d.title, ['The uploaded file(s) for this document'])}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}

          {tab === 'invoices' && (
            <table className="list-table">
              <thead><tr><th>Invoice #</th><th>Customer</th><th>Total</th><th>Status</th><th>Reason for deletion</th><th>Deleted</th><th>Transaction</th><th>Actions</th></tr></thead>
              <tbody>
                {data.invoices.length === 0 ? <tr><td colSpan={8} className="empty-cell">No deleted invoices.</td></tr>
                  : data.invoices.map((i) => (
                    <tr key={i.id}>
                      <td><strong>{i.invoice_no}</strong></td>
                      <td>{i.customer_name || '—'}</td>
                      <td>{formatCurrency(i.total)}</td>
                      <td>{i.status || '—'}</td>
                      <td style={{ maxWidth: 240, fontSize: 12, color: i.reason ? 'var(--text)' : 'var(--muted-2)' }}>{i.reason || '— (no reason given)'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{i.deleted_at || '—'}</td>
                      <td>{txnCell(i.transaction_id, i.trade_no, i.transaction_trashed)}</td>
                      <td>{actions('invoices', i.id, `Invoice ${i.invoice_no}`, ['Line items and recorded payments on this invoice'])}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}

          {tab === 'payments' && (
            <>
              <strong style={{ display: 'block', margin: '2px 0 8px' }}>Invoice Payments</strong>
              <table className="list-table" style={{ marginBottom: 18 }}>
                <thead><tr><th>Amount</th><th>Method</th><th>Reference</th><th>Paid on</th><th>Deleted</th><th>Invoice</th><th>Actions</th></tr></thead>
                <tbody>
                  {data.payments.length === 0 ? <tr><td colSpan={7} className="empty-cell">No deleted invoice payments.</td></tr>
                    : data.payments.map((p) => (
                      <tr key={p.id}>
                        <td><strong>{formatCurrency(p.amount)}</strong></td>
                        <td>{p.method || '—'}</td>
                        <td>{p.reference || '—'}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{p.paid_on || '—'}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{p.deleted_at || '—'}</td>
                        <td>{p.invoice_id ? (p.invoice_trashed ? <span className="pill warn" style={{ fontSize: 10 }}>{p.invoice_no} (deleted)</span> : p.invoice_no) : '—'}</td>
                        <td>{actions('payments', p.id, `Payment ${formatCurrency(p.amount)}`)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>

              <strong style={{ display: 'block', margin: '2px 0 8px' }}>Commission &amp; Adjustment deletions</strong>
              <div className="help" style={{ margin: '0 0 8px 2px' }}>Rows deleted from Admin Activities (Agent Commission Paid, CTA to BA) and Adjustment &amp; Advance Payment (Adjustment, Advance, Client Referral, External Referral).</div>
              <table className="list-table">
                <thead><tr><th>Type</th><th>Agent / Client</th><th>Details</th><th>Deleted by</th><th>Deleted</th><th>Transaction</th><th>Actions</th></tr></thead>
                <tbody>
                  {data.rows.length === 0 ? <tr><td colSpan={7} className="empty-cell">No deleted commission / adjustment rows.</td></tr>
                    : data.rows.map((r) => (
                      <tr key={r.id}>
                        <td><span className="pill info" style={{ fontSize: 10 }}>{r.kind_label}</span></td>
                        <td>{r.agent || '—'}</td>
                        <td style={{ maxWidth: 260, fontSize: 12, color: 'var(--muted)' }}>{r.summary || '—'}</td>
                        <td>{r.who || '—'}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{r.deleted_at || '—'}</td>
                        <td>{txnCell(r.transaction_id, r.trade_no, r.transaction_trashed)}</td>
                        <td>{actions('rows', r.id, r.label || r.kind_label || 'row')}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </>
          )}

          {tab === 'log' && (
            <>
              <div className="help" style={{ margin: '0 0 10px 2px' }}>A read-only history of everything admins or agents deleted across the app. Recover items from their tab: <strong>Transactions</strong>, <strong>Documents</strong>, <strong>Invoices</strong>, and <strong>Payments</strong> (which also holds deleted commission &amp; adjustment rows).</div>
              <table className="list-table">
                <thead><tr><th>When</th><th>Who</th><th>What</th><th>Item</th><th>Detail</th><th>Transaction</th></tr></thead>
                <tbody>
                  {data.log.length === 0 ? <tr><td colSpan={6} className="empty-cell">No deletions logged.</td></tr>
                    : data.log.map((e) => (
                      <tr key={e.id}>
                        <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{e.stamp || '—'}</td>
                        <td>{e.who || '—'}</td>
                        <td><span className="pill bad" style={{ fontSize: 10 }}>{e.action}</span>{e.section ? <div style={{ fontSize: 11, color: 'var(--muted)' }}>{e.section}</div> : null}</td>
                        <td>{e.field || '—'}</td>
                        <td style={{ maxWidth: 220, fontSize: 12, color: 'var(--muted)' }}>{e.details || e.old_value || '—'}</td>
                        <td>{txnCell(e.transaction_id, e.trade_no, e.transaction_trashed)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}

      <ConfirmDialog confirm={confirm} onClose={closeConfirm} />
    </>
  );
}
