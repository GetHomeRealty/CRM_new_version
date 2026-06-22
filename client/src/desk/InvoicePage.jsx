import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listTransactions } from '../lib/api';
import { formatCurrency, typeClass } from './format';
import { useToast } from './toast';

export default function InvoicePage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    listTransactions().then(setRows).catch(() => toast('Could not load invoices', 'bad')).finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const list = useMemo(() => rows.filter((t) => !filter || t.comm_status === filter), [rows, filter]);
  const totalCommission = useMemo(() => list.reduce((s, t) => s + (t.commission?.total || 0), 0), [list]);

  if (loading) return <div className="centered">Loading invoices…</div>;

  return (
    <>
      <div className="stat-grid">
        <div className="stat-card"><div className="lbl">Invoices</div><div className="val">{list.length}</div></div>
        <div className="stat-card"><div className="lbl">Received</div><div className="val" style={{ color: '#166534' }}>{rows.filter((t) => t.comm_status === 'Received').length}</div></div>
        <div className="stat-card"><div className="lbl">Total Commission (incl. HST)</div><div className="val">{formatCurrency(totalCommission)}</div></div>
      </div>
      <div className="toolbar"><div className="toolbar-row">
        <select value={filter} onChange={(e) => setFilter(e.target.value)}><option value="">All commission status</option><option>Pending</option><option>Received</option></select>
      </div></div>
      <table className="list-table">
        <thead><tr><th>Trade #</th><th>Type</th><th>Property</th><th>Agent</th><th>Commission</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {list.length === 0 && <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--muted)', padding: 16 }}>No invoices.</td></tr>}
          {list.map((t) => (
            <tr key={t.id}>
              <td>#{t.trade_no}</td>
              <td><span className={`pill ${typeClass(t.type)}`}>{t.type}</span></td>
              <td>{t.property}</td>
              <td>{t.agent || 'Unassigned'}</td>
              <td>{formatCurrency(t.commission?.total || 0)}</td>
              <td><span className={`pill ${t.comm_status === 'Received' ? 'ok' : 'warn'}`}>{t.comm_status}</span></td>
              <td><button className="btn ghost sm" onClick={() => navigate(`/app/transactions/${t.id}?mode=view`)}>Open</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
