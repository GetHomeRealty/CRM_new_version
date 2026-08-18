import { useEffect, useState, type ReactNode } from 'react';
import { getDeskAnalytics } from '../lib/api';
import { formatCurrency } from './format';

interface TileProps {
  bg: string;
  bd: string;
  fg: string;
  label: ReactNode;
  value: ReactNode;
  sub: ReactNode;
}

function Tile({ bg, bd, fg, label, value, sub }: TileProps) {
  return (
    <div className="dash-tile" style={{ background: bg, border: `1px solid ${bd}`, borderRadius: 'var(--r-md)', padding: 12 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: fg, textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: fg, marginTop: 4 }}>{value}</div>
      <div style={{ fontSize: 11, color: fg, marginTop: 2 }}>{sub}</div>
    </div>
  );
}

/**
 * Pending vs Paid commissions across all transactions — read as four numbers, not as a deal book.
 *
 * MEASURED, at 8,000 deals: `listTransactions()` (the unpaged mode of the transactions endpoint)
 * took 860 ms, put 14.5 MB on the wire and pushed the Node heap to 394 MB, to produce the six
 * figures below. The Invoice screen paid that on every visit. `/api/dashboard/analytics` returns
 * the same figures in 5 KB, computed where the data is.
 *
 * BEFORE HST, like every other commission figure — HST is collected and remitted, not earned. The
 * invoice totals beside this panel legitimately include it; they are billings rather than earnings.
 */
export default function CommissionAnalytics() {
  const [stats, setStats] = useState({ paidAmount: 0, pendingAmount: 0, paidCount: 0, pendingCount: 0, total: 0, paidPct: 0 });

  useEffect(() => {
    getDeskAnalytics()
      .then((d) => {
        const total = d.totals.total;
        setStats({
          paidAmount: d.totals.paid,
          pendingAmount: d.totals.pending,
          paidCount: d.totals.paid_count,
          pendingCount: d.totals.pending_count,
          total,
          paidPct: total > 0 ? Math.round((d.totals.paid / total) * 100) : 0,
        });
      })
      .catch(() => { /* the panel is a summary; the invoice list below it still stands */ });
  }, []);

  return (
    <div className="analytics-dash" style={{ background: 'linear-gradient(135deg,#fff 0%,var(--surface-2) 100%)', border: '1px solid var(--line)', borderRadius: 'var(--r-lg)', padding: '14px 16px', marginBottom: 14, boxShadow: 'var(--shadow-sm)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em' }}>Analytics Dashboard</div>
          <div style={{ fontSize: 14, color: 'var(--text-2)', marginTop: 2 }}>Pending vs Paid commissions across all transactions · before HST</div>
        </div>
        {/* The deal count is the sum of the two buckets, so the badge and the tiles beside it
            cannot disagree — and no deal list has to be downloaded to produce it. */}
        <span className="pill ok" style={{ fontSize: 11 }}>{stats.paidCount + stats.pendingCount} deals tracked</span>
      </div>
      <div className="tiles" style={{ marginBottom: 0 }}>
        <Tile bg="var(--ok-bg)" bd="var(--ok-ring-2)" fg="var(--ok-ink)" label="Paid" value={formatCurrency(stats.paidAmount)} sub={`${stats.paidCount} deal${stats.paidCount === 1 ? '' : 's'}`} />
        <Tile bg="var(--warn-soft)" bd="var(--warn-ring)" fg="var(--warn-ink)" label="Pending" value={formatCurrency(stats.pendingAmount)} sub={`${stats.pendingCount} deal${stats.pendingCount === 1 ? '' : 's'}`} />
        <Tile bg="var(--info-bg)" bd="var(--info-ring)" fg="var(--info-ink)" label="Total Pipeline" value={formatCurrency(stats.total)} sub="All commissions" />
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
