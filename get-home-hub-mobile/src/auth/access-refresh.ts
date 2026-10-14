/** Serialized refresh lifecycle; stale results cannot update a replaced session. */
export function createAccessRefresh<T>(fetchAccess: (signal: AbortSignal) => Promise<T>, apply: (value: T) => void, onError: () => void, timeoutMs = 15_000) {
  let stopped = false;
  let pending = false;
  let controller: AbortController | null = null;
  return {
    async refresh() {
      if (stopped || pending) return;
      pending = true;
      controller = new AbortController();
      const request = controller;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      try {
        // Race cancellation too: a stalled transport may never settle after abort.
        const cancelled = new Promise<never>((_, reject) => {
          onAbort = () => reject(new Error('Access refresh cancelled'));
          request.signal.addEventListener('abort', onAbort, { once: true });
          timer = setTimeout(() => request.abort(), timeoutMs);
        });
        const value = await Promise.race([fetchAccess(request.signal), cancelled]);
        if (!stopped) apply(value);
      } catch {
        if (!stopped) onError();
      } finally {
        clearTimeout(timer);
        if (onAbort) request.signal.removeEventListener('abort', onAbort);
        controller = null;
        pending = false;
      }
    },
    stop() { stopped = true; controller?.abort(); },
  };
}
