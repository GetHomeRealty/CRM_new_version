import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listTransactions } from '../lib/api';
import { formatCurrency, formatPrice, typeClass } from './format';
import { useToast } from './toast';

export default function DashboardPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listTransactions()
      .then(setRows)
      .catch(() => toast('Could not load dashboard data', 'bad'))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const kpi = useMemo(() => {
    let paid = 0, pending = 0, paidN = 0, pendingN = 0;
    const byStatus = {}, byType = {};
    rows.forEach((t) => {
      const amt = t.commission?.amount || 0;
      if (t.commission?.paid) { paid += amt; paidN++; } else { pending += amt; pendingN++; }
      const s = (t.statuses && t.statuses[0]) || 'Open';
      byStatus[s] = (byStatus[s] || 0) + 1;
      byType[t.type] = (byType[t.type] || 0) + 1;
    });
    return { paid, pending, paidN, pendingN, total: paid + pending, byStatus, byType };
  }, [rows]);

  const recent = rows.slice(0, 6);
  const stPill = (s) => s === 'Open' ? 'info' : (s === 'Closed' ? 'ok' : (s === 'Void' ? 'bad' : 'warn'));

  if (loading) return <div className="centered">Loading dashboard…</div>;

  return (
    <>
      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(4,1fr)' }}>
        <Tile label="Total Deals" value={rows.length} sub="all transactions" />
        <Tile label="Pipeline Commission" value={formatCurrency(kpi.total)} sub="incl. paid + pending" />
        <Tile label="Paid" value={formatCurrency(kpi.paid)} sub={`${kpi.paidN} deal${kpi.paidN === 1 ? '' : 's'}`} color="#166534" />
        <Tile label="Pending" value={formatCurrency(kpi.pending)} sub={`${kpi.pendingN} deal${kpi.pendingN === 1 ? '' : 's'}`} color="#92400e" />
      </div>

      <div className="g2">
        <div className="card">
          <div className="modal-h" style={{ fontSize: 14 }}>Deals by Status</div>
          {Object.keys(kpi.byStatus).length === 0 && <div className="help">No data yet.</div>}
          {Object.entries(kpi.byStatus).map(([s, n]) => (
            <div key={s} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderTop: '1px dashed var(--line)' }}>
              <span className={`pill ${stPill(s)}`}>{s}</span>
              <strong>{n}</strong>
            </div>
          ))}
        </div>
        <div className="card">
          <div className="modal-h" style={{ fontSize: 14 }}>Deals by Type</div>
          {Object.keys(kpi.byType).length === 0 && <div className="help">No data yet.</div>}
          {Object.entries(kpi.byType).map(([t, n]) => (
            <div key={t} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderTop: '1px dashed var(--line)' }}>
              <span className={`pill ${typeClass(t)}`}>{t}</span>
              <strong>{n}</strong>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div className="modal-h" style={{ fontSize: 14, margin: 0 }}>Recent Transactions</div>
          <button className="btn ghost sm" onClick={() => navigate('/app/transactions')}>View all →</button>
        </div>
        <table className="list-table">
          <thead><tr><th>Type</th><th>Trade #</th><th>Property</th><th>Agent</th><th>Price</th><th>Commission</th><th>Status</th></tr></thead>
          <tbody>
            {recent.length === 0 && <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--muted)', padding: 16 }}>No transactions yet.</td></tr>}
            {recent.map((t) => {
              const s = (t.statuses && t.statuses[0]) || 'Open';
              return (
                <tr key={t.id}>
                  <td><span className={`pill ${typeClass(t.type)}`}>{t.type}</span></td>
                  <td>#{t.trade_no}</td>
                  <td><a className="prop-link" onClick={() => navigate(`/app/transactions/${t.id}?mode=view`)}>{t.property}</a></td>
                  <td>{t.agent || 'Unassigned'}</td>
                  <td>{formatPrice(t.price)}</td>
                  <td>{formatCurrency(t.commission?.total || 0)}</td>
                  <td><span className={`pill ${stPill(s)}`}>{s}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Tile({ label, value, sub, color }) {
  return (
    <div className="stat-card">
      <div className="lbl">{label}</div>
      <div className="val" style={color ? { color } : undefined}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{sub}</div>
    </div>
  );
}
