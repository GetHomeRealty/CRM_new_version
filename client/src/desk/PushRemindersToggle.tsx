import { useCallback, useEffect, useState } from 'react';
import { useArea } from './AreaContext';
import { useToast } from './toast';
import { apiErrorMessage } from '../lib/apiError';
import { pushKey, pushSubscribe, pushTest, pushUnsubscribe } from '../lib/calendarApi';

/**
 * Turning browser reminders on for this device.
 *
 * WHY IT SAYS "THIS DEVICE". A push subscription belongs to one browser on one machine, not to an
 * account — turning it on at the office does nothing for the phone in somebody's pocket. Wording it
 * as a per-device switch is the difference between an agent adding their phone and an agent
 * wondering why the reminder they enabled last week never arrived on it.
 *
 * WHY THE PERMISSION IS ONLY ASKED ON CLICK. A browser gives a site one chance: a prompt fired on
 * page load is dismissed reflexively, and once it is denied the site cannot ask again — the person
 * has to dig through site settings. So the prompt appears only after somebody has asked for it.
 *
 * WHAT IT DOES NOT PROMISE. Email remains the reminder of record. This is the notice that arrives
 * while somebody is between viewings, and the copy says so rather than implying a phone that is off
 * will still get one.
 */

type State = 'checking' | 'unsupported' | 'unconfigured' | 'blocked' | 'off' | 'on';

/** The VAPID key travels as base64url and the browser wants raw bytes. */
function toBytes(base64url: string): ArrayBuffer {
  const padded = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out.buffer;
}

const supported = (): boolean =>
  typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export default function PushRemindersToggle() {
  const { area } = useArea();
  const toast = useToast();
  const [state, setState] = useState<State>('checking');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!supported()) { setState('unsupported'); return; }
    try {
      const { configured } = await pushKey();
      if (!configured) { setState('unconfigured'); return; }
      if (Notification.permission === 'denied') { setState('blocked'); return; }
      const reg = await navigator.serviceWorker.getRegistration('/');
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        // The browser and the server can drift apart: a device dropped after repeated failures, or
        // wiped from the server for any other reason, leaves a browser that is still subscribed and
        // a switch that says "on" while nothing arrives. Re-sending the subscription costs one
        // idempotent call per page load and puts the two back in step.
        await pushSubscribe(sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } }, area)
          .catch(() => undefined);
      }
      setState(sub ? 'on' : 'off');
    } catch {
      // A failed check must not leave a spinner where a switch should be.
      setState('off');
    }
  }, [area]);

  useEffect(() => { void refresh(); }, [refresh]);

  const enable = async () => {
    setBusy(true);
    try {
      const { public_key: key } = await pushKey();
      if (!key) { toast('Browser reminders are not set up on this server.', 'bad'); setState('unconfigured'); return; }

      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'blocked' : 'off');
        toast('Notifications were not allowed, so nothing was turned on.', 'bad');
        return;
      }

      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      // `register` resolves before the worker is usable; subscribing against a worker that is still
      // installing throws, and the error a person would see is "no active Service Worker".
      await navigator.serviceWorker.ready;

      const sub = await reg.pushManager.subscribe({
        // Every push must show a notification. Chrome refuses silent pushes outright, and a site
        // that pushed without showing anything would lose the permission it just asked for.
        userVisibleOnly: true,
        applicationServerKey: toBytes(key),
      });
      await pushSubscribe(sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } }, area);
      setState('on');
      toast('Appointment reminders will now appear on this device.', 'ok');
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not turn on browser reminders'), 'bad');
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration('/');
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        // The server row goes first. The other order can leave a record of a browser that has
        // already stopped listening, and every reminder after that is a wasted send.
        await pushUnsubscribe(sub.endpoint).catch(() => undefined);
        await sub.unsubscribe();
      }
      setState('off');
      toast('Browser reminders are off for this device. Emails still arrive.', 'ok');
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not turn off browser reminders'), 'bad');
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    try {
      const r = await pushTest(area);
      if (r.sent > 0) toast(`Test notification sent to ${r.sent} device${r.sent === 1 ? '' : 's'}.`, 'ok');
      else toast('No device received it — try turning reminders off and on again.', 'bad');
      void refresh();
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not send a test notification'), 'bad');
    } finally {
      setBusy(false);
    }
  };

  // Nothing to offer and nothing to explain: a server without keys should not show a dead switch.
  if (state === 'checking' || state === 'unconfigured') return null;

  return (
    <div className="card push-card" style={{ marginTop: 12 }}>
      <div className="push-row">
        <div>
          <strong>Appointment reminders on this device</strong>
          <div className="muted" style={{ fontSize: 13 }}>
            {state === 'unsupported'
              ? 'This browser cannot show push notifications. Email reminders still arrive.'
              : state === 'blocked'
                ? 'Notifications are blocked for this site. Allow them in your browser’s site settings, then reload.'
                : state === 'on'
                  ? 'A notice appears a day before and an hour before each appointment. Email reminders arrive as well.'
                  : 'Get a notice a day before and an hour before each appointment, without opening your email.'}
          </div>
          {state === 'off' && (
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              On iPhone and iPad this works only after adding this site to the Home Screen.
            </div>
          )}
        </div>
        {state !== 'unsupported' && state !== 'blocked' && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {state === 'on' && (
              <button className="btn ghost sm" onClick={test} disabled={busy}>Send a test</button>
            )}
            <button
              className={state === 'on' ? 'btn ghost sm' : 'btn primary sm'}
              onClick={state === 'on' ? disable : enable}
              disabled={busy}
            >
              {busy ? 'Working…' : state === 'on' ? 'Turn off' : 'Turn on'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
