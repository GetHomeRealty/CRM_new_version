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

  const toast = useCallback<ToastFn>((msg, type = '') => {
    const id = `t${(seq.current += 1)}`;
    setToasts((t) => [...t, { id, msg, type }]);
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
