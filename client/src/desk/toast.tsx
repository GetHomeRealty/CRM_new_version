import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from 'react';

/** Fires a transient toast. `type` maps to a CSS class suffix ('', 'ok', 'bad', 'info'). */
export type ToastFn = (msg: ReactNode, type?: string) => void;

interface ToastItem {
  id: string;
  msg: ReactNode;
  type: string;
}

const ToastCtx = createContext<ToastFn>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  // A monotonic counter for ids, so `toast` never has to depend on `toasts.length`. That kept its
  // identity changing on every show/dismiss, which rippled through every consumer that lists
  // `toast` as a hook dependency (e.g. the lead page's `load`), re-firing effects and flashing the
  // whole screen on every action. A ref keeps `toast` stable for the life of the provider.
  const seq = useRef(0);

  /*
   * A NEW MESSAGE SUPERSEDES THE ONE IT REPLACES, RATHER THAN STACKING ON IT.
   *
   * Each toast lives 2600ms, so any two actions less than that apart left both on screen — three
   * saves in a row on the Settings screen showed the second still sitting under the third, which
   * reads as "two things happened" when one did. Measured during the 2026-08-04 audit.
   *
   * Superseded BY TYPE, not wholesale: a success replaces the previous success, and an error stays
   * visible beside it. Dropping everything on each new toast would hide the failure that actually
   * needs reading whenever a later action happened to succeed. Three is the cap for the rest, so a
   * genuine burst still cannot bury the screen.
   */
  const toast = useCallback<ToastFn>((msg, type = '') => {
    const id = `t${(seq.current += 1)}`;
    setToasts((t) => [...t.filter((x) => x.type !== type), { id, msg, type }].slice(-3));
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600);
  }, []);

  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div id="toast">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.type}`}>{t.msg}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export const useToast = (): ToastFn => useContext(ToastCtx);
