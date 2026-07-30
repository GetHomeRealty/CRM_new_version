import { useMemo, useState, type CSSProperties } from 'react';
import type { AuditEntry, Transaction } from '../types';

interface AuditTrailModalProps {
  open: boolean;
  onClose: () => void;
  txn: Transaction;
}

export default function AuditTrailModal({ open, onClose, txn }: AuditTrailModalProps) {
  const logs: AuditEntry[] = txn.audit_logs || [];
  const [section, setSection] = useState('All');
  const [query, setQuery] = useState('');

  const sections = useMemo(
    () => ['All', ...Array.from(new Set(logs.map((e) => e.section).filter(Boolean))).sort()],
    [logs],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return logs.filter((e) => {
      if (section !== 'All' && e.section !== section) return false;
      if (!q) return true;
      return [e.who, e.section, e.field, e.action, e.old_value, e.new_value, e.details]
        .some((v) => (v || '').toString().toLowerCase().includes(q));
    });
  }, [logs, section, query]);

  if (!open) return null;

  const cell: CSSProperties = { padding: '8px 10px', borderBottom: '1px solid var(--surface-3)', fontSize: 12, verticalAlign: 'top' };
  const th: CSSProperties = { ...cell, color: 'var(--brand)', borderBottom: '2px solid var(--brand)', whiteSpace: 'nowrap', textAlign: 'left' };
  const fmt = (s: string | undefined) => {
    if (!s) return '';
    const d = new Date(s.replace(' ', 'T'));
    return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
  };
  const actionColor = (a: string | undefined) => {
    const t = (a || '').toLowerCase();
    if (t.includes('remov') || t.includes('delet')) return 'var(--bad-ink)';
    if (t.includes('add') || t.includes('creat') || t.includes('upload')) return 'var(--ok-ink)';
    return 'var(--text-2)';
  };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal xl" style={{ maxHeight: '92vh', overflowY: 'auto' }}>
        <button className="close" onClick={onClose}>✕</button>
        <div className="modal-h">Audit Trail</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
          Complete chronological history of every change to this transaction (most recent first).
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <select value={section} onChange={(e) => setSection(e.target.value)} style={{ maxWidth: 240 }}>
            {sections.map((s) => <option key={s} value={s}>{s === 'All' ? 'All sections' : s}</option>)}
          </select>
          <input placeholder="Search field, user, value…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>{filtered.length} of {logs.length}</span>
        </div>

        <div style={{ maxHeight: '62vh', overflow: 'auto', border: '1px solid var(--line)', borderRadius: 'var(--r-md)' }}>
          {filtered.length === 0 ? (
            <div style={{ padding: 18, textAlign: 'center', color: 'var(--muted)' }}>No changes recorded.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead style={{ background: '#fff7f7', position: 'sticky', top: 0, zIndex: 1 }}>
                <tr>
                  <th style={th}>Timestamp</th>
                  <th style={th}>User</th>
                  <th style={th}>Section</th>
                  <th style={th}>Field</th>
                  <th style={th}>Action</th>
                  <th style={th}>Old Value</th>
                  <th style={th}>New Value</th>
                  <th style={th}>Source</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((e) => (
                  <tr key={e.id}>
                    <td style={{ ...cell, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{fmt(e.stamp)}</td>
                    <td style={{ ...cell, fontWeight: 600 }}>{e.who}</td>
                    <td style={cell}>{e.section || '—'}</td>
                    <td style={cell}>{e.field || (e.details ? '' : '—')}</td>
                    <td style={{ ...cell, color: actionColor(e.action), fontWeight: 600 }}>{e.action}{e.details ? ` — ${e.details}` : ''}</td>
                    <td style={{ ...cell, color: 'var(--bad-ink)', background: e.old_value ? '#fff5f5' : 'transparent' }}>{e.old_value || ''}</td>
                    <td style={{ ...cell, color: 'var(--ok-ink)', background: e.new_value ? 'var(--ok-bg)' : 'transparent' }}>{e.new_value || ''}</td>
                    <td style={{ ...cell, color: 'var(--muted)' }}>{e.source || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="actions"><button className="btn ghost" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
