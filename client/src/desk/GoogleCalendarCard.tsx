import { crmPath, deskPath, AREA_SHORT } from './area';
import { useCallback, useEffect, useState } from 'react';
import {
  googleCalendarStatus, googleCalendarConnect, googleCalendarSync, googleCalendarDisconnect, googleCalendarRetrySync,
  type GoogleCalendarStatus, type IntegrationScope,
} from '../lib/accountApi';
import { apiErrorMessage } from '../lib/apiError';
import { useToast } from './toast';

/**
 * Where the connect flow returns to — the SAME area it was started from.
 *
 * This was hardcoded to `?tab=integrations`, which SettingsPage aliases to Transaction Desk,
 * so connecting from CRM Settings dumped the user on the Transaction Desk screen as though
 * the connection had been made there. The two areas hold independent connections, so the
 * return has to follow the scope.
 */
const returnPath = (scope: IntegrationScope): string =>
  (scope === 'desk' ? `${deskPath('settings')}?tab=desk&section=integrations` : `${crmPath('settings')}?tab=crm`);

/** The multicolour Google "G", inline so the card stays self-contained. */
const GoogleG = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </svg>
);

const fmtSync = (iso: string | null): string => (iso ? iso.slice(0, 16).replace('T', ' ') : '');

/**
 * Google Calendar via real OAuth, as a self-contained card. "Connect Google Calendar" fetches Google's
 * own consent-screen URL and sends the browser there; after the round-trip the server returns to
 * /app/account, and the hint stored below bounces the browser back here (see AccountSettingsPage).
 * Per-user; explains itself when the server has no Google credentials rather than failing silently.
 */
/**
 * `scope` decides which connection this card manages. CRM Settings and Transaction Desk
 * Settings hold INDEPENDENT Google connections, so connecting here never connects the
 * other side. The scope also rides through the OAuth round trip inside the signed state.
 */
export default function GoogleCalendarCard({ scope = 'crm' }: { scope?: IntegrationScope }) {
  const toast = useToast();
  const [st, setSt] = useState<GoogleCalendarStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => { googleCalendarStatus(scope).then(setSt).catch(() => setSt(null)); }, [scope]);
  useEffect(() => { load(); }, [load]);

  // If the OAuth round-trip lands back here, surface the outcome once and clean the URL.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('google_connected')) toast('Google Calendar connected.', 'ok');
    else if (p.get('google_error')) toast(`Google connection failed: ${p.get('google_error')}`, 'bad');
    if (p.get('google_connected') || p.get('google_error')) {
      window.history.replaceState({}, '', returnPath(scope));
      load();
    }
  }, [toast, load, scope]);

  const connect = async () => {
    setBusy(true);
    try {
      const res = await googleCalendarConnect(scope);
      if (res.url) {
        sessionStorage.setItem('gcal_return', returnPath(scope)); // come back to the area we started in
        window.location.href = res.url;                        // → Google's own consent screen
      } else {
        toast(res.message || 'Google sign-in is not set up on the server.', 'bad');
      }
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not start Google sign-in'), 'bad');
    } finally {
      setBusy(false);
    }
  };

  const run = async (fn: () => Promise<{ message?: string; error?: string | null }>, ok: string) => {
    setBusy(true);
    try { const r = await fn(); toast(r.error ? (r.message || r.error) : (r.message || ok), r.error ? 'bad' : 'ok'); load(); }
    catch (ex) { toast(apiErrorMessage(ex, 'That did not work'), 'bad'); }
    finally { setBusy(false); }
  };

  const subtitle = !st ? 'Checking…'
    : !st.configured ? (st.setup_hint || 'Google sign-in is not set up on the server yet.')
    : st.connected ? `Signed in as ${st.email ?? 'your Google account'}${st.last_sync ? ` · last synced ${fmtSync(st.last_sync)}` : ''}`
    /*
     * NAMES THE AREA, because this component renders on both sides. The copy was hardcoded to
     * "the CRM", so the Transaction Desk card — and the Desk card on Account Settings — told the
     * user their events synced with the CRM. The one string in a scope-aware component that was
     * not scope-aware.
     *
     * "Sync both ways" is accurate and stays: the pull is a real incremental sync
     * (listEvents + a persisted syncToken) and the push covers insert, update, patch and delete.
     * Deliberately says no more than that — Google owns title, date, time and description on a
     * pull while type and status stay the CRM's, so any wording implying merged or reconciled
     * edits would overstate what happens.
     */
    : `Choose a Google account, review the requested access, and continue to connect your calendar. Your events then sync both ways between Google Calendar and the ${AREA_SHORT[scope]}.`;

  return (
    <div className="intg-card">
      <div className="intg-card-head">
        <div className="intg-card-icon"><GoogleG /></div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="intg-card-title">Google Calendar</div>
          <div className="muted" style={{ fontSize: 12.5 }}>{subtitle}</div>
        </div>
        <span className={`pill ${st?.connected ? 'ok' : ''}`} style={{ flex: 'none' }}>
          {!st ? 'Checking…' : st.connected ? 'Connected' : 'Not connected'}
        </span>
      </div>

      {st?.error && <div className="muted" style={{ color: 'var(--bad)', marginTop: 8 }}>{st.error}</div>}

      {/*
        * WHAT GOOGLE HAS NOT RECEIVED (CRM-GCAL-M01).
        *
        * A push that failed used to be caught, logged as a warning and dropped — no retry, nothing
        * on the row, nothing here. An appointment moved while Google was briefly unreachable kept
        * its old time on the agent's phone for ever, and the only way to find out was to look at
        * the phone.
        *
        * Shown separately from `error` because the two are genuinely different: the connection can
        * be healthy right now and still owe Google a viewing that failed during an outage earlier.
        * A retry sweep is already working through these in the background; the button is for
        * somebody who has just fixed the cause and does not want to wait — and for the events that
        * have used up their five automatic attempts, which is exactly when a person is looking.
        */}
      {!!st?.pending_sync && (
        <div className="muted" data-testid="gcal-pending-sync"
          style={{ color: 'var(--warn-ink, var(--bad))', marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span>
            {st.pending_sync} appointment{st.pending_sync === 1 ? '' : 's'} {st.pending_sync === 1 ? 'has' : 'have'} not
            reached Google yet.
          </span>
          <button className="btn ghost sm" type="button" disabled={busy}
            onClick={() => void run(() => googleCalendarRetrySync(scope), 'Retried.')}>
            Retry now
          </button>
        </div>
      )}

      <div className="intg-card-actions">
        {st?.connected ? (
          <>
            <button className="btn ghost sm" type="button" disabled={busy} onClick={() => void run(() => googleCalendarSync(scope), 'Synced.')}>↻ Sync now</button>
            <button className="btn ghost sm" type="button" disabled={busy} onClick={() => void run(() => googleCalendarDisconnect(scope).then(() => ({ message: 'Disconnected.' })), 'Disconnected.')}>Disconnect</button>
          </>
        ) : (
          <button className="btn gsi" type="button" disabled={busy || (st ? !st.configured : true)} onClick={() => void connect()}>
            <GoogleG size={18} /><span>{busy ? 'Starting…' : 'Connect Google Calendar'}</span>
          </button>
        )}
        {st && !st.configured && (
          <span className="muted" style={{ fontSize: 12 }}>Ask an admin to add the Google keys on the server.</span>
        )}
        {/*
          Only before connecting, and only about choosing the ACCOUNT — the one part of Google's
          flow an agent has to make a decision in. Nothing here names Google's buttons: those labels
          differ between personal and Workspace accounts and change without notice, so instructions
          built on them would be wrong for some agents on the day they were written.
        */}
        {st?.configured && !st.connected && (
          <span className="muted" style={{ fontSize: 12 }}>
            If the account is already signed in on this browser, simply select it. To connect a
            different account, choose <strong>Use another account</strong>.
          </span>
        )}
      </div>
    </div>
  );
}
