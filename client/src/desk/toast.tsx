import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

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

  const toast = useCallback<ToastFn>((msg, type = '') => {
    const id = `${performance.now()}-${toasts.length}`;
    setToasts((t) => [...t, { id, msg, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600);
  }, [toasts.length]);

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
