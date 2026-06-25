import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getInvoices, getInvoice, deleteInvoice, getCustomers, getCompanySettings, listAgents } from '../lib/api';
import { formatCurrency, typeLabel } from './format';
import { useToast } from './toast';
import { useAuth } from '../context/AuthContext';
import InvoiceEditorModal from './InvoiceEditorModal';
import InvoicePreviewModal from './InvoicePreviewModal';

const STATUS_PILL = {
  Paid: 'ok', 'Partially Paid': 'warn', Unpaid: 'info', Overdue: 'bad', Void: 'bad', Draft: 'info',
};

export default function InvoicePage() {
  const toast = useToast();
  const { can } = useAuth();
  const canEdit = can('invoice', 'edit');

  const [invoices, setInvoices] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [settings, setSettings] = useState(null);
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editorId, setEditorId] = useState(undefined); // undefined=closed, null=new, number=edit
  const [preview, setPreview] = useState(null);
  const [filter, setFilter] = useState('');
  const [params, setParams] = useSearchParams();

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

  const onDelete = async (inv) => {
    if (!window.confirm(`Delete invoice ${inv.invoice_no}?`)) return;
    try { await deleteInvoice(inv.id); setInvoices((x) => x.filter((i) => i.id !== inv.id)); toast('Invoice deleted', 'ok'); }
    catch { toast('Could not delete', 'bad'); }
  };

  const openPdf = async (inv) => {
    try { setPreview(await getInvoice(inv.id)); } catch { toast('Could not load invoice', 'bad'); }
  };

  const afterSave = () => { loadInvoices(); getCustomers().then(setCustomers).catch(() => {}); };

  const list = invoices.filter((i) => !filter || i.display_status === filter);
  const totalOutstanding = invoices.reduce((s, i) => s + (i.balance_due || 0), 0);

  if (loading) return <div className="centered">Loading invoices…</div>;

  return (
    <>
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
        <thead><tr><th>Invoice #</th><th>Customer</th><th>Property</th><th>Type</th><th>Agent</th><th>Date</th><th>Total</th><th>Balance</th><th>Status</th><th>Source</th><th>Actions</th></tr></thead>
        <tbody>
          {list.length === 0 ? (
            <tr><td colSpan={11} style={{ textAlign: 'center', color: 'var(--muted)', padding: 20 }}>No invoices. {canEdit && 'Click "+ New Invoice" to create one.'}</td></tr>
          ) : list.map((i) => (
            <tr key={i.id}>
              <td><strong>{i.invoice_no}</strong></td>
              <td>{i.customer_name || '—'}</td>
              <td>{i.property_reference || '—'}</td>
              <td>{i.transaction_type ? typeLabel(i.transaction_type) : '—'}</td>
              <td>{i.listing_agent || '—'}</td>
              <td>{i.invoice_date}</td>
              <td>{formatCurrency(i.total)}</td>
              <td>{formatCurrency(i.balance_due)}</td>
              <td><span className={`pill ${STATUS_PILL[i.display_status] || 'info'}`}>{i.display_status}</span></td>
              <td><span className={`pill ${i.source === 'transaction' ? 'warn' : 'info'}`} style={{ fontSize: 10 }}>{i.source === 'transaction' ? 'Transaction' : 'Manual'}</span></td>
              <td>
                <button className="btn ghost sm" onClick={() => setEditorId(i.id)}>👁 View</button>
                {canEdit && <button className="btn ghost sm" style={{ marginLeft: 4 }} onClick={() => setEditorId(i.id)}>Edit</button>}
                <button className="btn ghost sm" style={{ marginLeft: 4 }} onClick={() => openPdf(i)}>🖨 PDF</button>
                {canEdit && <button className="btn ghost sm" style={{ marginLeft: 4 }} onClick={() => onDelete(i)}>🗑️</button>}
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
    </>
  );
}
