import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Options describing a delete-confirmation popup. */
export interface ConfirmOptions {
  title: ReactNode;
  message: ReactNode;
  /** Extra controls between the message and the warning — e.g. choosing which occurrences to remove. */
  body?: ReactNode;
  linked?: ReactNode[];
  note?: ReactNode;
  /**
   * Label on the confirm button. Defaults to 'Delete' — this dialog started as the delete
   * confirmation and most callers still are one. Set it when the action being confirmed is
   * irreversible but is not a delete, so the button names what will actually happen: a dialog
   * whose only affirmative option reads "Delete" over the words "this sends the message to every
   * member of staff" asks the reader to press the wrong verb to get the right outcome.
   */
  confirmLabel?: ReactNode;
  /**
   * What KIND of action is being confirmed, which decides the button's colour.
   *
   * `destructive` is the DEFAULT, deliberately. This component began as the delete confirmation and
   * most of its three dozen callers still are one, so defaulting the other way would have quietly
   * turned every existing warning into an ordinary button - a much worse failure than the one being
   * fixed. Non-destructive callers opt in, and every existing call site keeps exactly the styling it
   * has today without being touched.
   *
   * THE COLOUR IS THE MESSAGE. A dialog that paints "Confirm Send" in the same red as "Delete
   * Forever" teaches people that red means "the button you press to continue", which is precisely
   * how a warning stops working.
   */
  variant?: 'destructive' | 'primary';
  /**
   * Blocks the confirm button while the dialog's own `body` is incomplete — e.g. a required reason
   * that has not been typed yet. Optional and undefined by default, so every existing caller keeps
   * an enabled button and is untouched by this.
   *
   * It exists because the confirm button ALWAYS closes the dialog. Without it, a caller needing a
   * required field has to accept the click, discover the field is empty, close, and report the
   * failure through a toast - which throws away whatever the user had already typed.
   */
  confirmDisabled?: boolean;
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
  // Destructive unless a caller says otherwise — see `variant` on ConfirmOptions for why round
  // that way.
  const destructive = (confirm.variant ?? 'destructive') === 'destructive';
  // Rendered through a portal to <body> so the fixed overlay always centres on the VIEWPORT and can
  // never be trapped by a transformed/animated ancestor (e.g. the parent modal). Without this, when
  // opened from inside another modal the dialog anchored to that modal and drifted above the screen
  // with a mis-placed backdrop mask.
  return createPortal(
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 4000 }}>
      <div className="modal" style={{ maxWidth: 480, margin: 0 }}>
        <button className="close" onClick={onClose}>✕</button>
        <div className="modal-h" style={destructive ? { color: 'var(--bad)' } : undefined}>{confirm.title}</div>
        <p style={{ fontSize: 13, marginTop: 4 }}>{confirm.message}</p>
        {confirm.body}
        {confirm.linked && confirm.linked.length > 0 && (
          <div style={{ background: 'var(--warn-bg)', border: '1px solid #fed7aa', borderRadius: 8, padding: '10px 12px', fontSize: 12.5, color: 'var(--warn-ink-alt)', marginTop: 8 }}>
            <strong>⚠ This may affect linked functionality:</strong>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {confirm.linked.map((l, i) => <li key={i} style={{ marginBottom: 2 }}>{l}</li>)}
            </ul>
            {confirm.note && <div style={{ marginTop: 8, color: 'var(--warn-ink-deep)' }}>{confirm.note}</div>}
          </div>
        )}
        <div className="actions">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          {/*
            `data-variant` is rendered whichever way this goes, so the styling can be asserted by a
            test rather than by reading a colour out of a screenshot.
          */}
          <button
            className="btn primary"
            data-variant={destructive ? 'destructive' : 'primary'}
            disabled={confirm.confirmDisabled}
            style={destructive ? { background: 'var(--bad)', borderColor: 'var(--bad)' } : undefined}
            onClick={() => { confirm.onConfirm?.(); onClose(); }}
          >
            {confirm.confirmLabel ?? 'Delete'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
