import { useEffect, useMemo, useState } from 'react';
import { listTransactions } from '../lib/api';
import { formatCurrency } from './format';
import { useToast } from './toast';

export default function ReportsPage() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listTransactions().then(setRows).catch(() => toast('Could not load reports', 'bad')).finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const summary = useMemo(() => {
    let price = 0, commission = 0, paid = 0, pending = 0;
    rows.forEach((t) => {
      price += t.price || 0;
      commission += t.commission?.total || 0;
      if (t.commission?.paid) paid += t.commission?.amount || 0; else pending += t.commission?.amount || 0;
    });
    return { price, commission, paid, pending };
  }, [rows]);

  const exportCsv = () => {
    const headers = ['Trade #', 'Type', 'Property', 'Agent', 'Price', 'Commission %', 'Commission (incl HST)', 'Commission Status', 'Validation', 'Status', 'Offer Date', 'Closing Date'];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((t) => [
      t.trade_no, t.type, t.property, t.agent || '', t.price, t.comm_pct ?? t.comm_value ?? '',
      (t.commission?.total ?? 0), t.comm_status, t.valid_status, (t.statuses || []).join('/'),
      t.offer_date || '', t.closing_date || '',
    ].map(esc).join(','));
    const csv = [headers.map(esc).join(','), ...lines].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `transactions-report.csv`; a.click();
    URL.revokeObjectURL(url);
    toast('CSV exported', 'ok');
  };

  if (loading) return <div className="centered">Loading reports…</div>;

  return (
    <>
      <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div className="modal-h" style={{ fontSize: 14, margin: 0 }}>Transactions Report</div>
        <button className="btn primary sm" onClick={exportCsv} disabled={rows.length === 0}>⬇ Export CSV ({rows.length})</button>
      </div>
      <div className="tiles">
        <div className="stat-card"><div className="lbl">Total Volume (Price)</div><div className="val">{formatCurrency(summary.price)}</div></div>
        <div className="stat-card"><div className="lbl">Total Commission</div><div className="val">{formatCurrency(summary.commission)}</div></div>
        <div className="stat-card"><div className="lbl">Paid</div><div className="val" style={{ color: '#166534' }}>{formatCurrency(summary.paid)}</div></div>
        <div className="stat-card"><div className="lbl">Pending</div><div className="val" style={{ color: '#92400e' }}>{formatCurrency(summary.pending)}</div></div>
      </div>
      <div className="card">
        <span className="help" style={{ margin: 0 }}>Export produces a CSV of all transactions (trade #, type, property, agent, price, commission, statuses, dates) for spreadsheets or accounting.</span>
      </div>
    </>
  );
}
