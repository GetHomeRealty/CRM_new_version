import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listTransactions } from '../lib/api';
import { typeClass } from './format';
import { useToast } from './toast';

export default function MlsPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listTransactions().then(setRows).catch(() => toast('Could not load MLS data', 'bad')).finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <div className="centered">Loading MLS…</div>;

  const withMls = rows.filter((t) => t.mls_num);

  return (
    <>
      <div className="stat-grid">
        <div className="stat-card"><div className="lbl">Total Listings/Deals</div><div className="val">{rows.length}</div></div>
        <div className="stat-card"><div className="lbl">With MLS #</div><div className="val">{withMls.length}</div></div>
        <div className="stat-card"><div className="lbl">Verified</div><div className="val" style={{ color: '#166534' }}>{rows.filter((t) => t.mls_verified).length}</div></div>
      </div>
      <table className="list-table">
        <thead><tr><th>Trade #</th><th>Type</th><th>Property</th><th>Listing Type</th><th>MLS #</th><th>Verified</th><th></th></tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--muted)', padding: 16 }}>No transactions.</td></tr>}
          {rows.map((t) => (
            <tr key={t.id}>
              <td>#{t.trade_no}</td>
              <td><span className={`pill ${typeClass(t.type)}`}>{t.type}</span></td>
              <td>{t.property}</td>
              <td><span className="pill info">{t.mls_type === 'exclusive' ? 'Exclusive' : 'MLS'}</span></td>
              <td>{t.mls_num || <span style={{ color: 'var(--muted-2)' }}>—</span>}</td>
              <td>{t.mls_verified ? <span className="pill ok">Verified</span> : <span className="pill warn">No</span>}</td>
              <td><button className="btn ghost sm" onClick={() => navigate(`/app/transactions/${t.id}?mode=view`)}>Open</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
