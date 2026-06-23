import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listTransactions, deleteTransaction } from '../lib/api';
import { formatCurrency, formatPrice, typeClass, TRANSACTION_TYPES } from './format';
import { useToast } from './toast';
import { useAuth } from '../context/AuthContext';
import AddTransactionModal from './AddTransactionModal';

const EMPTY_FILTERS = { q: '', type: '', validation: '', agent: '', commission: '', status: '' };

export default function TransactionsPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const canEdit = can('transactions', 'edit');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [filters, setFilters] = useState(EMPTY_FILTERS);

  const load = () => {
    setLoading(true);
    listTransactions()
      .then(setRows)
      .catch(() => toast('Could not load transactions', 'bad'))
      .finally(() => setLoading(false));
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const stats = useMemo(() => {
    let paidAmount = 0, pendingAmount = 0, paidCount = 0, pendingCount = 0;
    rows.forEach((t) => {
      const amt = t.commission?.amount || 0;
      if (t.commission?.paid) { paidAmount += amt; paidCount++; }
      else { pendingAmount += amt; pendingCount++; }
    });
    const total = paidAmount + pendingAmount;
    const paidPct = total > 0 ? Math.round((paidAmount / total) * 100) : 0;
    return { paidAmount, pendingAmount, paidCount, pendingCount, total, paidPct };
  }, [rows]);

  const filtered = useMemo(() => {
    const f = filters;
    const q = f.q.toLowerCase().trim();
    return rows.filter((t) => {
      if (q && !`${t.property} ${t.trade_no} ${t.agent || ''}`.toLowerCase().includes(q)) return false;
      if (f.type && t.type !== f.type) return false;
      if (f.validation && t.valid_status !== f.validation) return false;
      if (f.agent && !(t.agent || '').toLowerCase().includes(f.agent.toLowerCase())) return false;
      if (f.commission === 'Received' && t.comm_status !== 'Received') return false;
      if (f.commission === 'Not received' && t.comm_status === 'Received') return false;
      if (f.status && !(t.statuses || []).includes(f.status)) return false;
      return true;
    });
  }, [rows, filters]);

  const setF = (k, v) => setFilters((p) => ({ ...p, [k]: v }));

  const onDelete = async (t) => {
    if (!window.confirm(`Delete transaction #${t.trade_no}?`)) return;
    try {
      await deleteTransaction(t.id);
      setRows((r) => r.filter((x) => x.id !== t.id));
      toast('Transaction deleted', 'ok');
    } catch { toast('Could not delete', 'bad'); }
  };

  const stPill = (s) => s === 'Open' ? 'info' : (s === 'Closed' ? 'ok' : (s === 'Void' ? 'bad' : 'warn'));

  return (
    <>
      {/* Analytics dashboard */}
      <div className="analytics-dash" style={{ background: 'linear-gradient(135deg,#fff 0%,#f9fafb 100%)', border: '1px solid var(--line)', borderRadius: 'var(--r-lg)', padding: '14px 16px', marginBottom: 14, boxShadow: 'var(--shadow-sm)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 10 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em' }}>Analytics Dashboard</div>
            <div style={{ fontSize: 14, color: 'var(--text-2)', marginTop: 2 }}>Pending vs Paid commissions across all transactions</div>
          </div>
          <span className="pill ok" style={{ fontSize: 11 }}>{rows.length} deals tracked</span>
        </div>
        <div className="tiles" style={{ marginBottom: 0 }}>
          <Tile bg="#f0fdf4" bd="#bbf7d0" fg="#166534" label="Paid" value={formatCurrency(stats.paidAmount)} sub={`${stats.paidCount} deal${stats.paidCount === 1 ? '' : 's'}`} />
          <Tile bg="#fef3c7" bd="#fde68a" fg="#92400e" label="Pending" value={formatCurrency(stats.pendingAmount)} sub={`${stats.pendingCount} deal${stats.pendingCount === 1 ? '' : 's'}`} />
          <Tile bg="#eff6ff" bd="#bfdbfe" fg="#1e3a8a" label="Total Pipeline" value={formatCurrency(stats.total)} sub="All commissions" />
          <div className="dash-tile" style={{ background: '#faf5ff', border: '1px solid #e9d5ff', borderRadius: 'var(--r-md)', padding: 12 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#5b21b6', textTransform: 'uppercase', letterSpacing: '.05em' }}>Paid %</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#5b21b6', marginTop: 4 }}>{stats.paidPct}%</div>
            <div style={{ background: '#f3e8ff', height: 6, borderRadius: 4, marginTop: 8, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${stats.paidPct}%`, background: 'linear-gradient(90deg,#a855f7,#7c3aed)' }} />
            </div>
          </div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="toolbar"><div className="toolbar-row">
        <input className="inp" placeholder="🔍 Search property, trade #, agent" value={filters.q} onChange={(e) => setF('q', e.target.value)} />
        <select value={filters.type} onChange={(e) => setF('type', e.target.value)}>
          <option value="">All types</option>
          {TRANSACTION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={filters.validation} onChange={(e) => setF('validation', e.target.value)}>
          <option value="">All validation</option><option>Pending</option><option>Valid</option><option>Invalid</option>
        </select>
        <input style={{ width: 'auto', flex: '0 1 auto', minWidth: 120 }} placeholder="All agents" value={filters.agent} onChange={(e) => setF('agent', e.target.value)} />
        <select value={filters.commission} onChange={(e) => setF('commission', e.target.value)}>
          <option value="">Commission: any</option><option>Received</option><option>Not received</option>
        </select>
        <select value={filters.status} onChange={(e) => setF('status', e.target.value)}>
          <option value="">All statuses</option><option>Open</option><option>Hold</option><option>Closed</option><option>Void</option>
        </select>
        {canEdit && <button className="btn primary sm" onClick={() => setAddOpen(true)}>+ Add Transaction</button>}
      </div></div>

      <div className="legend">
        <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600, marginRight: 4 }}>Legend:</span>
        <span className="pill type-res-buy">Residential Buying / Lease</span>
        <span className="pill type-res-sell">Residential Sale / Lease Listing</span>
        <span className="pill type-commercial">Commercial &amp; Business</span>
        <span className="pill type-pre">Preconstruction</span>
        <span className="pill type-referral">Referral</span>
      </div>

      <table className="list-table">
        <thead><tr>
          <th>Type</th><th>Trade #</th><th>Offer</th><th>Closing</th><th>Property</th><th>Agent</th>
          <th>Price</th><th>Commission status</th><th>Validation</th><th>Status</th><th>Actions</th>
        </tr></thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={11} className="centered">Loading…</td></tr>
          ) : filtered.length === 0 ? (
            <tr><td colSpan={11} style={{ textAlign: 'center', color: 'var(--muted)', padding: 20 }}>No transactions found. Click "+ Add Transaction" to create one.</td></tr>
          ) : filtered.map((t) => {
            const primary = (t.statuses && t.statuses[0]) || 'Open';
            return (
              <tr key={t.id}>
                <td><span className={`pill ${typeClass(t.type)}`}>{t.type}</span></td>
                <td>#{t.trade_no}</td>
                <td>{t.offer_date || ''}</td>
                <td>{t.closing_date || ''}</td>
                <td><a className="prop-link" onClick={() => navigate(`/app/transactions/${t.id}?mode=view`)}>{t.property}</a></td>
                <td>{t.agent || 'Unassigned'}</td>
                <td>{formatPrice(t.price)}</td>
                <td><span className={`pill ${t.comm_status === 'Received' ? 'ok' : 'warn'}`}>{t.comm_status}</span></td>
                <td><span className={`pill ${t.valid_status === 'Valid' ? 'ok' : (t.valid_status === 'Invalid' ? 'bad' : 'warn')}`}>{t.valid_status}</span></td>
                <td><span className={`pill ${stPill(primary)}`}>{primary}</span></td>
                <td>
                  <button className="btn ghost sm" onClick={() => navigate(`/app/transactions/${t.id}?mode=${canEdit ? 'edit' : 'view'}`)}>{canEdit ? 'Edit' : 'View'}</button>
                  {canEdit && <button className="btn ghost sm" onClick={() => onDelete(t)} style={{ marginLeft: 4 }}>🗑️</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <AddTransactionModal open={addOpen} onClose={() => setAddOpen(false)} onCreated={(t) => { load(); navigate(`/app/transactions/${t.id}?mode=edit`); }} />
    </>
  );
}

function Tile({ bg, bd, fg, label, value, sub }) {
  return (
    <div className="dash-tile" style={{ background: bg, border: `1px solid ${bd}`, borderRadius: 'var(--r-md)', padding: 12 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: fg, textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: fg, marginTop: 4 }}>{value}</div>
      <div style={{ fontSize: 11, color: fg, marginTop: 2 }}>{sub}</div>
    </div>
  );
}
