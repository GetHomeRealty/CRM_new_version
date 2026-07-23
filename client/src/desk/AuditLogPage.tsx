import { useEffect, useState, type CSSProperties } from 'react';
import { getAuditLogs } from '../lib/api';
import { useToast } from './toast';
import type { AuditEntry } from '../types';

const cell: CSSProperties = { padding: '8px 10px', borderBottom: '1px solid #f3f4f6', fontSize: 12, verticalAlign: 'top' };
const th: CSSProperties = { ...cell, color: 'var(--brand)', borderBottom: '2px solid var(--brand)', whiteSpace: 'nowrap', textAlign: 'left' };

const fmt = (s: string | undefined) => {
  if (!s) return '';
  const d = new Date(s.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
};
const actionColor = (a: string | undefined) => {
  const t = (a || '').toLowerCase();
  if (t.includes('remov') || t.includes('delet')) return '#991b1b';
  if (t.includes('add') || t.includes('creat') || t.includes('upload') || t.includes('sent')) return '#166534';
  return 'var(--text-2)';
};

interface AuditMeta { current_page: number; last_page: number; total: number; }

export default function AuditLogPage() {
  const toast = useToast();
  const [category, setCategory] = useState('');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [meta, setMeta] = useState<AuditMeta>({ current_page: 1, last_page: 1, total: 0 });
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  // Reset to page 1 whenever a filter changes.
  useEffect(() => { setPage(1); }, [category, from, to]);

  useEffect(() => {
    const t = setTimeout(() => {
      setLoading(true);
      getAuditLogs({ category: category || undefined, q: q || undefined, from: from || undefined, to: to || undefined, page })
        .then((d) => { setRows(d.data || []); setMeta(d.meta || { current_page: 1, last_page: 1, total: 0 }); if (d.categories) setCategories(d.categories); })
        .catch(() => toast('Could not load audit trail', 'bad'))
        .finally(() => setLoading(false));
    }, 350);
    return () => clearTimeout(t);
  }, [category, q, from, to, page]); // eslint-disable-line react-hooks/exhaustive-deps

  const catOptions = ['Transactions', ...categories.filter((c) => c !== 'Audit Trail')];

  return (
    <div className="card" style={{ margin: 0 }}>
      <div className="modal-h" style={{ fontSize: 16 }}>Audit Trail</div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
        Cross-module history of every change across the system (most recent first).
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ maxWidth: 200 }}>
          <option value="">All categories</option>
          {catOptions.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <input placeholder="Search user, field, value…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
        <label style={{ fontSize: 12, color: 'var(--muted)' }}>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label style={{ fontSize: 12, color: 'var(--muted)' }}>To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        {(category || q || from || to) && <button className="btn ghost sm" onClick={() => { setCategory(''); setQ(''); setFrom(''); setTo(''); }}>Clear</button>}
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{meta.total} entries</span>
      </div>

      <div style={{ maxHeight: '64vh', overflow: 'auto', border: '1px solid var(--line)', borderRadius: 'var(--r-md)' }}>
        {loading ? (
          <div style={{ padding: 18, textAlign: 'center', color: 'var(--muted)' }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 18, textAlign: 'center', color: 'var(--muted)' }}>No audit entries found.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead style={{ background: '#fff7f7', position: 'sticky', top: 0, zIndex: 1 }}>
              <tr>
                <th style={th}>Timestamp</th>
                <th style={th}>Category</th>
                <th style={th}>Record</th>
                <th style={th}>User</th>
                <th style={th}>Section</th>
                <th style={th}>Field</th>
                <th style={th}>Action</th>
                <th style={th}>Old Value</th>
                <th style={th}>New Value</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td style={{ ...cell, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{fmt(e.stamp)}</td>
                  <td style={cell}><span className="pill info" style={{ fontSize: 10 }}>{e.category}</span></td>
                  <td style={cell}>{e.record || '—'}</td>
                  <td style={{ ...cell, fontWeight: 600 }}>{e.who}</td>
                  <td style={cell}>{e.section || '—'}</td>
                  <td style={cell}>{e.field || '—'}</td>
                  <td style={{ ...cell, color: actionColor(e.action), fontWeight: 600 }}>{e.action}{e.details ? ` — ${e.details}` : ''}</td>
                  <td style={{ ...cell, color: '#991b1b', background: e.old_value ? '#fff5f5' : 'transparent' }}>{e.old_value || ''}</td>
                  <td style={{ ...cell, color: '#166534', background: e.new_value ? '#f0fdf4' : 'transparent' }}>{e.new_value || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {meta.last_page > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, marginTop: 12 }}>
          <button className="btn ghost sm" disabled={meta.current_page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>← Prev</button>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>Page {meta.current_page} of {meta.last_page}</span>
          <button className="btn ghost sm" disabled={meta.current_page >= meta.last_page} onClick={() => setPage((p) => Math.min(meta.last_page, p + 1))}>Next →</button>
        </div>
      )}
    </div>
  );
}
