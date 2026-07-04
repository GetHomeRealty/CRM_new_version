import { useState } from 'react';

/**
 * Shared delete-confirmation popup. Pass a `confirm` object
 * { title, message, linked?: string[], onConfirm } and an onClose handler.
 * Mirrors the confirmation used on the Transaction Detail page so deletes behave
 * consistently everywhere (with a linked-impact warning).
 */
export function useConfirm() {
  const [confirm, setConfirm] = useState(null);
  return {
    confirm,
    askDelete: (opts) => setConfirm(opts),
    closeConfirm: () => setConfirm(null),
  };
}

export default function ConfirmDialog({ confirm, onClose }) {
  if (!confirm) return null;
  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ maxWidth: 480 }}>
        <button className="close" onClick={onClose}>✕</button>
        <div className="modal-h" style={{ color: 'var(--bad)' }}>{confirm.title}</div>
        <p style={{ fontSize: 13, marginTop: 4 }}>{confirm.message}</p>
        {confirm.linked && confirm.linked.length > 0 && (
          <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, padding: '10px 12px', fontSize: 12.5, color: '#9a3412', marginTop: 8 }}>
            <strong>⚠ This may affect linked functionality:</strong>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {confirm.linked.map((l, i) => <li key={i} style={{ marginBottom: 2 }}>{l}</li>)}
            </ul>
            {confirm.note && <div style={{ marginTop: 8, color: '#7c2d12' }}>{confirm.note}</div>}
          </div>
        )}
        <div className="actions">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" style={{ background: 'var(--bad)', borderColor: 'var(--bad)' }}
            onClick={() => { confirm.onConfirm?.(); onClose(); }}>Delete</button>
        </div>
      </div>
    </div>
  );
}
