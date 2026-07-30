import { deskPath } from './area';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listReports } from '../lib/reportsApi';
import { apiErrorMessage } from '../lib/apiError';
import { useToast } from './toast';
import type { ReportListItem } from '../types';

const CATEGORY_ORDER = ['Deal Reports', 'Commission Reports', 'Payment Reports', 'Agent Reports', 'Client and Referral Reports', 'Review and Marketing Reports'];

/** Reports dashboard — category-grouped cards; each opens a full report page. */
export default function ReportsPage() {
  const toast = useToast();
  const nav = useNavigate();
  const [reports, setReports] = useState<ReportListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    listReports()
      .then(setReports)
      .catch((e) => { const m = apiErrorMessage(e, 'Could not load reports'); setError(m); toast(m, 'bad'); })
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <div className="centered">Loading reports…</div>;
  if (error) return <div className="card" style={{ color: 'var(--bad)' }}>{error}</div>;

  const cats = CATEGORY_ORDER.filter((c) => reports.some((r) => r.category === c));
  const extras = [...new Set(reports.map((r) => r.category))].filter((c) => !CATEGORY_ORDER.includes(c));

  return (
    <>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="modal-h" style={{ fontSize: 15, margin: 0 }}>Reports</div>
        <div className="modal-sub" style={{ marginTop: 4 }}>Generate detailed transaction, commission, payment and agent reports. Select a report to filter, customize columns and export to XLSX or PDF.</div>
      </div>

      {[...cats, ...extras].map((cat) => (
        <div key={cat} style={{ marginBottom: 18 }}>
          <div className="modal-h" style={{ fontSize: 13, margin: '0 0 10px' }}>{cat}</div>
          <div className="report-grid">
            {reports.filter((r) => r.category === cat).map((r) => (
              <div key={r.type} className="card report-card">
                <div>
                  <div className="report-card-name">{r.name}</div>
                  <div className="report-card-desc">{r.description}</div>
                </div>
                <button className="btn primary sm" onClick={() => nav(deskPath(`reports/${r.type}`))}>Open Report →</button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
