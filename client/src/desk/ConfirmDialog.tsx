import { useState, type ReactNode } from 'react';

/** Options describing a delete-confirmation popup. */
export interface ConfirmOptions {
  title: ReactNode;
  message: ReactNode;
  linked?: ReactNode[];
  note?: ReactNode;
  onConfirm?: () => void;
}

/**
 * Shared delete-confirmation popup. Pass a `confirm` object
 * { title, message, linked?: string[], onConfirm } and an onClose handler.
 * Mirrors the confirmation used on the Transaction Detail page so deletes behave
 * consistently everywhere (with a linked-impact warning).
 */
export function useConfirm() {
  const [confirm, setConfirm] = useState<ConfirmOptions | null>(null);
  return {
    confirm,
    askDelete: (opts: ConfirmOptions) => setConfirm(opts),
    closeConfirm: () => setConfirm(null),
  };
}

export default function ConfirmDialog({ confirm, onClose }: { confirm: ConfirmOptions | null; onClose: () => void }) {
  if (!confirm) return null;
  return (
    // Fixed + viewport-centered with a high z-index so it appears in the middle of
    // whatever is on screen — even when opened from a tall, scrolled parent modal
    // (previously it anchored to the parent's top and scrolled out of view).
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 4000 }}>
      <div className="modal" style={{ maxWidth: 480, margin: 0 }}>
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
