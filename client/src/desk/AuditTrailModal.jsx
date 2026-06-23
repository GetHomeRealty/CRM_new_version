export default function AuditTrailModal({ open, onClose, txn }) {
  if (!open) return null;
  const logs = txn.audit_logs || [];

  const cell = { padding: '8px 10px', borderBottom: '1px solid #f3f4f6', fontSize: 12, verticalAlign: 'top' };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal lg">
        <button className="close" onClick={onClose}>✕</button>
        <div className="modal-h">Audit Trail</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
          Chronological log of changes to this transaction (most recent first).
        </div>
        <div style={{ maxHeight: '55vh', overflow: 'auto', border: '1px solid var(--line)', borderRadius: 'var(--r-md)' }}>
          {logs.length === 0 ? (
            <div style={{ padding: 18, textAlign: 'center', color: 'var(--muted)' }}>No changes recorded yet.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead style={{ background: '#fff7f7', position: 'sticky', top: 0 }}>
                <tr>
                  <th style={{ ...cell, color: 'var(--brand)', borderBottom: '2px solid var(--brand)', whiteSpace: 'nowrap' }}>Timestamp</th>
                  <th style={{ ...cell, color: 'var(--brand)', borderBottom: '2px solid var(--brand)' }}>User</th>
                  <th style={{ ...cell, color: 'var(--brand)', borderBottom: '2px solid var(--brand)' }}>Field</th>
                  <th style={{ ...cell, color: 'var(--brand)', borderBottom: '2px solid var(--brand)' }}>Old</th>
                  <th style={{ ...cell, color: 'var(--brand)', borderBottom: '2px solid var(--brand)' }}>New</th>
                  <th style={{ ...cell, color: 'var(--brand)', borderBottom: '2px solid var(--brand)' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((e) => (
                  <tr key={e.id}>
                    <td style={{ ...cell, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{e.stamp}</td>
                    <td style={{ ...cell, fontWeight: 600 }}>{e.who}</td>
                    <td style={cell}>{e.field || '—'}</td>
                    <td style={{ ...cell, color: '#991b1b', background: '#fff5f5' }}>{e.old_value || ''}</td>
                    <td style={{ ...cell, color: '#166534', background: '#f0fdf4' }}>{e.new_value || ''}</td>
                    <td style={{ ...cell, color: 'var(--text-2)' }}>{e.action}{e.details ? ` — ${e.details}` : ''}</td>
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
