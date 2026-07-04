import { useEffect, useMemo, useState } from 'react';
import { listTransactions } from '../lib/api';
import { formatCurrency } from './format';

function Tile({ bg, bd, fg, label, value, sub }) {
  return (
    <div className="dash-tile" style={{ background: bg, border: `1px solid ${bd}`, borderRadius: 'var(--r-md)', padding: 12 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: fg, textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: fg, marginTop: 4 }}>{value}</div>
      <div style={{ fontSize: 11, color: fg, marginTop: 2 }}>{sub}</div>
    </div>
  );
}

// Pending vs Paid commissions across all transactions.
export default function CommissionAnalytics() {
  const [rows, setRows] = useState([]);
  useEffect(() => { listTransactions().then(setRows).catch(() => {}); }, []);

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

  return (
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
  );
}
