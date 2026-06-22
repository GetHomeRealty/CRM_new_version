import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listTransactions } from '../lib/api';
import { typeClass } from './format';
import { useToast } from './toast';

export default function CalendarPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listTransactions().then(setRows).catch(() => toast('Could not load calendar', 'bad')).finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Flatten each transaction's key dates into calendar events, sorted ascending.
  const events = useMemo(() => {
    const ev = [];
    rows.forEach((t) => {
      if (t.offer_date) ev.push({ date: t.offer_date, kind: 'Offer', t });
      if (t.closing_date) ev.push({ date: t.closing_date, kind: 'Closing', t });
      if (t.listing_expiry_date) ev.push({ date: t.listing_expiry_date, kind: 'Listing Expiry', t });
    });
    return ev.sort((a, b) => a.date.localeCompare(b.date));
  }, [rows]);

  if (loading) return <div className="centered">Loading calendar…</div>;

  // Group by month
  const groups = {};
  events.forEach((e) => { const m = e.date.slice(0, 7); (groups[m] = groups[m] || []).push(e); });

  const kindPill = (k) => k === 'Closing' ? 'ok' : (k === 'Listing Expiry' ? 'bad' : 'info');

  return (
    <>
      <div className="card" style={{ padding: '10px 14px' }}>
        <span className="help" style={{ margin: 0 }}>Upcoming offer, closing and listing-expiry dates across all transactions.</span>
      </div>
      {events.length === 0 && <div className="card"><div className="help">No dated transactions yet.</div></div>}
      {Object.entries(groups).map(([month, evs]) => (
        <div className="card" key={month}>
          <div className="modal-h" style={{ fontSize: 14 }}>{month}</div>
          <table className="list-table">
            <thead><tr><th style={{ width: 110 }}>Date</th><th style={{ width: 130 }}>Event</th><th>Type</th><th>Property</th><th></th></tr></thead>
            <tbody>
              {evs.map((e, i) => (
                <tr key={i}>
                  <td><strong>{e.date}</strong></td>
                  <td><span className={`pill ${kindPill(e.kind)}`}>{e.kind}</span></td>
                  <td><span className={`pill ${typeClass(e.t.type)}`}>{e.t.type}</span></td>
                  <td>{e.t.property}</td>
                  <td><button className="btn ghost sm" onClick={() => navigate(`/app/transactions/${e.t.id}?mode=view`)}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </>
  );
}
