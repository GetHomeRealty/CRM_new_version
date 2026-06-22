import { useEffect, useMemo, useState } from 'react';
import { listAgents } from '../lib/api';
import { useToast } from './toast';

export default function UsersPage() {
  const toast = useToast();
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');

  useEffect(() => {
    listAgents().then(setAgents).catch(() => toast('Could not load users', 'bad')).finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(
    () => agents.filter((a) => a.toLowerCase().includes(q.toLowerCase().trim())),
    [agents, q]
  );

  if (loading) return <div className="centered">Loading users…</div>;

  const initial = (n) => (n || '?').charAt(0).toUpperCase();

  return (
    <>
      <div className="toolbar"><div className="toolbar-row">
        <input className="inp" placeholder="🔍 Search agents" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="pill info" style={{ fontSize: 11 }}>{filtered.length} of {agents.length} agents</span>
      </div></div>
      <div className="card">
        <div className="modal-h" style={{ fontSize: 14 }}>Agent &amp; Admin Directory</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))', gap: 10 }}>
          {filtered.map((a) => (
            <div key={a} style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid var(--line)', borderRadius: 10, padding: 10, background: '#fff' }}>
              <div style={{ width: 34, height: 34, borderRadius: '50%', background: 'var(--brand)', color: '#fff', display: 'grid', placeItems: 'center', fontWeight: 700, flexShrink: 0 }}>{initial(a)}</div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>{a.includes('- Team') ? 'Team' : 'Agent'}</div>
              </div>
            </div>
          ))}
          {filtered.length === 0 && <div className="help">No agents match.</div>}
        </div>
      </div>
    </>
  );
}
