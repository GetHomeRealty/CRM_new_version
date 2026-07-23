import { useEffect, useMemo, useState } from 'react';
import { listTransactions } from '../lib/api';
import { formatCurrency, typeClass } from './format';
import { useToast } from './toast';
import type { Transaction } from '../types';

interface Bucket { count: number; total: number; }

export default function AnalyticsPage() {
  const toast = useToast();
  const [rows, setRows] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listTransactions().then(setRows).catch(() => toast('Could not load analytics', 'bad')).finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const data = useMemo(() => {
    const byAgent: Record<string, Bucket> = {}, byType: Record<string, Bucket> = {}, byMonth: Record<string, number> = {};
    let paid = 0, pending = 0;
    rows.forEach((t) => {
      const total = t.commission?.total || 0;
      const amt = t.commission?.amount || 0;
      if (t.commission?.paid) paid += amt; else pending += amt;
      const ag = t.agent || 'Unassigned';
      byAgent[ag] = byAgent[ag] || { count: 0, total: 0 };
      byAgent[ag].count++; byAgent[ag].total += total;
      byType[t.type] = byType[t.type] || { count: 0, total: 0 };
      byType[t.type].count++; byType[t.type].total += total;
      const m = (t.closing_date || t.offer_date || '').slice(0, 7) || '—';
      byMonth[m] = (byMonth[m] || 0) + total;
    });
    return { byAgent, byType, byMonth, paid, pending, total: paid + pending };
  }, [rows]);

  if (loading) return <div className="centered">Loading analytics…</div>;

  const agents = Object.entries(data.byAgent).sort((a, b) => b[1].total - a[1].total);
  const types = Object.entries(data.byType).sort((a, b) => b[1].total - a[1].total);
  const months = Object.entries(data.byMonth).filter(([m]) => m !== '—').sort();
  const maxMonth = Math.max(1, ...months.map(([, v]) => v));

  return (
    <>
      <div className="stat-grid">
        <div className="stat-card"><div className="lbl">Total Commission (incl. HST)</div><div className="val">{formatCurrency(data.total)}</div></div>
        <div className="stat-card"><div className="lbl">Paid</div><div className="val" style={{ color: '#166534' }}>{formatCurrency(data.paid)}</div></div>
        <div className="stat-card"><div className="lbl">Pending</div><div className="val" style={{ color: '#92400e' }}>{formatCurrency(data.pending)}</div></div>
      </div>

      <div className="card">
        <div className="modal-h" style={{ fontSize: 14 }}>Commission by Closing Month</div>
        {months.length === 0 ? <div className="help">No dated transactions yet.</div> : months.map(([m, v]) => (
          <div key={m} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0' }}>
            <span style={{ width: 70, fontSize: 12, color: 'var(--muted)' }}>{m}</span>
            <div style={{ flex: 1, background: '#f3f4f6', height: 16, borderRadius: 6, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${(v / maxMonth) * 100}%`, background: 'linear-gradient(90deg,#c8102e,#9c0c24)' }} />
            </div>
            <strong style={{ width: 110, textAlign: 'right', fontSize: 12 }}>{formatCurrency(v)}</strong>
          </div>
        ))}
      </div>

      <div className="g2">
        <div className="card">
          <div className="modal-h" style={{ fontSize: 14 }}>Top Agents by Commission</div>
          <table className="list-table"><thead><tr><th>Agent</th><th>Deals</th><th>Commission</th></tr></thead>
            <tbody>
              {agents.length === 0 && <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--muted)', padding: 14 }}>No data.</td></tr>}
              {agents.map(([a, v]) => <tr key={a}><td>{a}</td><td>{v.count}</td><td>{formatCurrency(v.total)}</td></tr>)}
            </tbody>
          </table>
        </div>
        <div className="card">
          <div className="modal-h" style={{ fontSize: 14 }}>By Transaction Type</div>
          <table className="list-table"><thead><tr><th>Type</th><th>Deals</th><th>Commission</th></tr></thead>
            <tbody>
              {types.length === 0 && <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--muted)', padding: 14 }}>No data.</td></tr>}
              {types.map(([t, v]) => <tr key={t}><td><span className={`pill ${typeClass(t)}`}>{t}</span></td><td>{v.count}</td><td>{formatCurrency(v.total)}</td></tr>)}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
