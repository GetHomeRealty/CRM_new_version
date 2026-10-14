export type PushState = 'unavailable' | 'disabled' | 'enabled' | 'denied' | 'error';
export interface PushDependencies {
  available: boolean;
  capability: (signal: AbortSignal) => Promise<{ enabled: boolean; registered: boolean }>;
  permission: (ask: boolean) => Promise<boolean>;
  token: () => Promise<string>;
  register: (token: string, signal: AbortSignal) => Promise<void>;
  remove: (signal: AbortSignal) => Promise<void>;
  changed: (state: PushState) => void;
}
/** One operation at a time; teardown aborts writes and ignores late native results. No permission prompt on refresh. */
export function createNativePushSession(deps: PushDependencies) {
  let alive = true;
  let pending: AbortController | null = null;
  const run = async (action: 'refresh' | 'enable' | 'disable') => {
    if (!alive || pending) return;
    if (!deps.available) { deps.changed('unavailable'); return; }
    const controller = new AbortController(); pending = controller;
    const timer = setTimeout(() => controller.abort(), 20_000);
    const current = () => alive && !controller.signal.aborted;
    const update = (state: PushState) => { if (current()) deps.changed(state); };
    try {
      if (action === 'disable') { await deps.remove(controller.signal); update('disabled'); return; }
      const capability = await deps.capability(controller.signal);
      if (!current()) return;
      if (!capability.enabled) { update('unavailable'); return; }
      if (action === 'refresh' && !capability.registered) { update('disabled'); return; }
      const granted = await deps.permission(action === 'enable');
      if (!current()) return;
      if (!granted) { await deps.remove(controller.signal); update('denied'); return; }
      const token = await deps.token();
      if (!current()) return;
      await deps.register(token, controller.signal);
      update('enabled');
    } catch { if (alive) deps.changed('error'); }
    finally { clearTimeout(timer); if (pending === controller) pending = null; }
  };
  return { refresh: () => run('refresh'), enable: () => run('enable'), disable: () => run('disable'), stop: () => { alive = false; pending?.abort(); } };
}
