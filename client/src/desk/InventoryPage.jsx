import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listTransactions } from '../lib/api';
import { formatPrice, typeClass, isListingType } from './format';
import { useToast } from './toast';

export default function InventoryPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listTransactions().then(setRows).catch(() => toast('Could not load inventory', 'bad')).finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const listings = useMemo(() => rows.filter((t) => isListingType(t.type)), [rows]);
  if (loading) return <div className="centered">Loading inventory…</div>;

  const stPill = (s) => s === 'Open' ? 'info' : (s === 'Sold' || s === 'Closed' ? 'ok' : (s === 'Void' || s === 'Terminated' || s === 'Expired' ? 'bad' : 'warn'));

  return (
    <>
      <div className="stat-grid">
        <div className="stat-card"><div className="lbl">Active Listings</div><div className="val">{listings.length}</div></div>
        <div className="stat-card"><div className="lbl">Sale Listings</div><div className="val">{listings.filter((t) => t.type.includes('Sale')).length}</div></div>
        <div className="stat-card"><div className="lbl">Lease Listings</div><div className="val">{listings.filter((t) => t.type.includes('Lease')).length}</div></div>
      </div>
      <table className="list-table">
        <thead><tr><th>Trade #</th><th>Type</th><th>Property</th><th>Price</th><th>Listing Contract</th><th>Expiry</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {listings.length === 0 && <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--muted)', padding: 16 }}>No listing inventory yet. Create a listing-type transaction.</td></tr>}
          {listings.map((t) => {
            const s = (t.statuses && t.statuses[0]) || 'Open';
            return (
              <tr key={t.id}>
                <td>#{t.trade_no}</td>
                <td><span className={`pill ${typeClass(t.type)}`}>{t.type}</span></td>
                <td>{t.property}</td>
                <td>{formatPrice(t.price)}</td>
                <td>{t.listing_contract_date || '—'}</td>
                <td>{t.listing_expiry_date || '—'}</td>
                <td><span className={`pill ${stPill(s)}`}>{s}</span></td>
                <td><button className="btn ghost sm" onClick={() => navigate(`/app/transactions/${t.id}?mode=view`)}>Open</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
