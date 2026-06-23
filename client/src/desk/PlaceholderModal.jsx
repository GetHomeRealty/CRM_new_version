export default function PlaceholderModal({ open, onClose, title, description }) {
  if (!open) return null;
  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <button className="close" onClick={onClose}>✕</button>
        <div className="modal-h">{title}</div>
        <div style={{ padding: 16, background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 'var(--r-md)' }}>
          <p style={{ margin: '0 0 8px', fontSize: 13 }}>🚧 This module is planned for a later stage.</p>
          <p className="help" style={{ margin: 0 }}>{description}</p>
        </div>
        <div className="actions"><button className="btn ghost" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
