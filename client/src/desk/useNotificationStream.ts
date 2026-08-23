import { useEffect, useRef } from 'react';

/**
 * "You have a new notification" — pushed, instead of waited for.
 *
 * The Centre and both bells refetched on a sixty-second timer, so a lead assigned at 10:00:05 could
 * sit unseen until 10:01:05. The row was in the database the whole time; nothing told the browser.
 *
 * MODELLED ON THE INBOX'S SUBSCRIBER in `InboxPage`, deliberately: same transport, same
 * `withCredentials`, same reliance on `EventSource`'s own reconnect. A second pattern would be a
 * second set of reconnect edge cases to get right.
 *
 * ================================================================================================
 * ONE CONNECTION FOR THE WHOLE APPLICATION.
 *
 * Three places want to know — the admin bell, the agent bell and the Notification Centre — and each
 * opening its own `EventSource` would mean three connections per tab, three reconnect storms when a
 * laptop wakes, and a server holding three streams for one person. So the connection is opened once
 * per page and subscribers are called from a set. `useNotificationStream(fn)` is the whole API; the
 * caller does not know whether it opened the socket or joined one.
 *
 * THE EVENT IS A SIGNAL, NEVER DATA. It carries a category and a timestamp and nothing else. Every
 * subscriber responds by refetching through the ordinary secured endpoints, which already apply
 * every ownership rule — so this cannot become a second way to read somebody's notifications, and
 * it cannot create a row on the client. That is also why a duplicate event is harmless: two nudges
 * produce one refetch of the same rows.
 * ================================================================================================
 */

type Listener = () => void;

const listeners = new Set<Listener>();
let source: EventSource | null = null;
/** Set while a refetch is already in flight, so a burst of events collapses into one round. */
let refetching = false;

/**
 * Coalesce. A campaign finishing can raise several notifications within a second, and one refetch
 * answers all of them — this is also what stops SSE and the sixty-second poll landing together and
 * fetching twice.
 */
function notifyAll(): void {
  if (refetching) return;
  refetching = true;
  // A microtask, not a timer: it batches the events already queued without adding latency a person
  // could notice.
  void Promise.resolve().then(() => {
    refetching = false;
    for (const fn of [...listeners]) {
      try { fn(); } catch { /* one bad subscriber must not stop the others */ }
    }
  });
}

function open(): void {
  if (source || typeof EventSource === 'undefined') return;
  const base = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';
  try {
    // `withCredentials`, because the stream is authenticated by the same session cookie as every
    // other request. Without it the browser connects anonymously and the server closes it — which
    // is also what makes the stream carry the CURRENT user: a different session is a different
    // cookie, so one person's stream can never be handed to another.
    source = new EventSource(`${base}/api/notifications/stream`, { withCredentials: true });
  } catch {
    // A browser that refuses to open it keeps the polling fallback and loses nothing else.
    source = null;
    return;
  }
  source.addEventListener('notification', notifyAll);
}

function close(): void {
  if (!source) return;
  source.removeEventListener('notification', notifyAll);
  source.close();
  source = null;
}

/**
 * Refetch whenever a notification is raised for the signed-in user.
 *
 * `onEvent` is held in a ref so a caller may pass an inline arrow without reopening the connection
 * on every render — the subscription is keyed on the component's lifetime, not on the identity of
 * the function.
 *
 * The connection closes when the LAST subscriber unmounts, which covers logging out: the layout
 * unmounts, the set empties, the stream is closed, and the next session opens a fresh one carrying
 * its own cookie.
 */
export function useNotificationStream(onEvent: () => void, enabled = true): void {
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    if (!enabled) return undefined;

    const listener: Listener = () => {
      // Skipped while the tab is hidden, exactly as the Inbox does: waking a background tab to
      // redraw a list nobody is looking at buys nothing, and the poll catches it up on return.
      if (!document.hidden) handler.current();
    };
    listeners.add(listener);
    open();

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) close();
    };
  }, [enabled]);
}

/** For tests: the live connection state without exporting the connection itself. */
export const __streamState = () => ({ open: source !== null, listeners: listeners.size });
