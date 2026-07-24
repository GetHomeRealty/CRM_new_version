import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  deleteMyMailAccount, getAccountProfile, getAccountSettings, listMyMailAccounts,
  saveAccountEmailPrefs, saveAccountProfile, setMyDefaultMailAccount, syncMailAccount, testMyMailAccount,
  googleCalendarStatus, googleCalendarConnect, googleCalendarSync, googleCalendarDisconnect,
  type AccountEmailPrefs, type AccountIntegrations, type AccountMailAccount,
  type GoogleCalendarStatus,
} from '../lib/accountApi';
import { apiErrorMessage, apiFieldErrors } from '../lib/apiError';
import { useToast } from './toast';
import MailAccountModal from './MailAccountModal';

const EMPTY_PREFS: AccountEmailPrefs = {
  signature: '', replyTemplate: '', autoSync: false,
  autoResponder: { enabled: false, message: '' }, forwardingAddress: '',
};

/**
 * A user's own Settings, the same for everyone. Everything here is scoped to the signed-in user
 * by the server — their profile, their mail accounts, their signature — so nobody manages anyone
 * else's account from this screen.
 */
export default function AccountSettingsPage() {
  const toast = useToast();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [phone, setPhone] = useState('');
  const [profileErrs, setProfileErrs] = useState<Record<string, string[]>>({});
  const [savingProfile, setSavingProfile] = useState(false);

  const [accounts, setAccounts] = useState<AccountMailAccount[]>([]);
  const [prefs, setPrefs] = useState<AccountEmailPrefs>(EMPTY_PREFS);
  const [integrations, setIntegrations] = useState<AccountIntegrations | null>(null);
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [editing, setEditing] = useState<AccountMailAccount | 'new' | null>(null);
  const [busy, setBusy] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadWarning, setLoadWarning] = useState('');
  const loadedOnce = useRef(false);

  /**
   * Each section loads independently, so a hiccup in one — a slow mail-account read right after
   * connecting an account, say — can never blank the whole page. Whatever loads is shown; only
   * the parts that failed carry a quiet notice, instead of one blocking "could not load" error.
   */
  const load = useCallback(async () => {
    if (!loadedOnce.current) setLoading(true);
    const [p, s, a] = await Promise.allSettled([getAccountProfile(), getAccountSettings(), listMyMailAccounts()]);

    if (p.status === 'fulfilled') { setName(p.value.name); setUsername(p.value.username); setPhone(p.value.phone); }
    if (s.status === 'fulfilled') { setPrefs({ ...EMPTY_PREFS, ...s.value.emailSettings }); setIntegrations(s.value.integrations); }
    if (a.status === 'fulfilled') setAccounts(a.value);

    const failed = [
      p.status === 'rejected' && 'your profile',
      s.status === 'rejected' && 'your preferences',
      a.status === 'rejected' && 'your email accounts',
    ].filter(Boolean);
    setLoadWarning(failed.length ? `Could not load ${failed.join(' or ')}. Your other settings are shown; try Refresh.` : '');

    loadedOnce.current = true;
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Finish a Gmail OAuth connect: the server returns to /app/account?mail_connected=1 (or
  // ?mail_error=…). If the connect was started from another page (e.g. CRM Settings), a stored hint
  // bounces the browser back there; otherwise show the result here and refresh the accounts list.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const outcome = p.get('mail_connected') ? 'mail_connected=1'
      : p.get('mail_error') ? `mail_error=${encodeURIComponent(p.get('mail_error') ?? '')}` : '';
    if (!outcome) return;
    const back = sessionStorage.getItem('mail_return');
    sessionStorage.removeItem('mail_return');
    if (back && new URL(back, window.location.origin).pathname !== window.location.pathname) {
      window.location.replace(back + (back.includes('?') ? '&' : '?') + outcome);
      return;
    }
    if (p.get('mail_connected')) toast('Email account connected.', 'ok');
    else toast(`Could not connect the email account: ${p.get('mail_error')}`, 'bad');
    window.history.replaceState({}, '', '/app/account');
    void load();
  }, [toast, load]);

  const saveProfile = async () => {
    setSavingProfile(true);
    setProfileErrs({});
    try {
      await saveAccountProfile({ name: name.trim(), username: username.trim(), phone: phone.trim() });
      toast('Personal information saved.', 'ok');
    } catch (ex) {
      const f = apiFieldErrors(ex);
      if (f) setProfileErrs(f);
      toast(apiErrorMessage(ex, 'Could not save your details'), 'bad');
    } finally {
      setSavingProfile(false);
    }
  };

  const savePrefs = async () => {
    setSavingPrefs(true);
    try {
      await saveAccountEmailPrefs({ signature: prefs.signature, replyTemplate: prefs.replyTemplate, autoSync: prefs.autoSync });
      toast('Email preferences saved.', 'ok');
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not save your preferences'), 'bad');
    } finally {
      setSavingPrefs(false);
    }
  };

  const act = async (id: number, fn: () => Promise<unknown>, ok: string) => {
    setBusy(id);
    try { await fn(); toast(ok, 'ok'); await load(); }
    catch (ex) { toast(apiErrorMessage(ex, 'That did not work'), 'bad'); }
    finally { setBusy(0); }
  };

  const perr = (k: string) => (profileErrs[k]?.length ? <div className="field-err">{profileErrs[k][0]}</div> : null);

  if (loading) return <div className="card"><p className="help">Loading your settings…</p></div>;

  return (
    <>
      <div className="toolbar">
        <div className="toolbar-row" style={{ justifyContent: 'space-between' }}>
          <div>
            <h2 className="lead-title">Settings</h2>
            <div className="lead-subtitle"><span className="muted">Your profile, email accounts, preferences and integrations — private to you.</span></div>
          </div>
          <button className="btn ghost" type="button" onClick={() => void load()}>↻ Refresh</button>
        </div>
      </div>

      {loadWarning && (
        <div className="lead-lock-note" style={{ marginBottom: 12 }}>⚠ {loadWarning}</div>
      )}

      {/* ---- Personal Information ---- */}
      <div className="card">
        <div className="modal-sub">Personal Information</div>
        <div className="g3">
          <div className="field">
            <label>Full Name *</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your full name" />
            {perr('name')}
          </div>
          <div className="field">
            <label>Username *</label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Your username" />
            {perr('username')}
          </div>
          <div className="field">
            <label>Phone</label>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Enter your phone number" />
            {perr('phone')}
          </div>
        </div>
        <div className="toolbar-row" style={{ marginTop: 6 }}>
          <button className="btn primary" type="button" disabled={savingProfile} onClick={() => void saveProfile()}>
            {savingProfile ? 'Saving…' : 'Save Personal Information'}
          </button>
        </div>
      </div>

      {/* ---- Integration — Mail / Calendar / Meta ---- */}
      <div className="card">
        <div className="modal-sub">Integration — Mail / Calendar / Meta</div>

        <div className="acct-head">
          <strong>Mail Configuration</strong>
          <button className="btn primary sm" type="button" onClick={() => setEditing('new')}>+ Add Email Account</button>
        </div>
        <p className="help">Connect your own email to send lead emails and campaigns from your own address. Until you add one, your mail goes out through the brokerage account.</p>

        {accounts.length === 0 ? (
          <div className="acct-empty">
            <p className="help">No email accounts connected yet.</p>
            <p className="help">Add your first email account to get started.</p>
          </div>
        ) : (
          <ul className="acct-list">
            {accounts.map((a) => (
              <li key={a.id}>
                <div className="acct-info">
                  <div>
                    <strong>{a.name}</strong>
                    {a.is_default && <span className="pill ok" style={{ marginLeft: 6 }}>Default</span>}
                    {!a.is_active && <span className="pill bad" style={{ marginLeft: 6 }}>Inactive</span>}
                  </div>
                  <div className="muted">{a.from_email} · {a.host}:{a.port}{a.encryption ? ` · ${a.encryption.toUpperCase()}` : ''}</div>
                  {a.imap_host ? (
                    <div className="muted">
                      📥 Inbound: {a.inbound_enabled ? <span className="pill ok">On</span> : <span className="pill">Off</span>}
                      {' '}via {a.imap_host}:{a.imap_port ?? 993}
                      {a.last_synced_at && ` · last synced ${a.last_synced_at.slice(0, 16).replace('T', ' ')}`}
                      {a.sync_error && <span className="pill bad" title={a.sync_error} style={{ marginLeft: 6 }}>Sync error</span>}
                    </div>
                  ) : (
                    <div className="muted">📥 Inbound sync not set up — add an IMAP server to receive mail here.</div>
                  )}
                </div>
                <div className="acct-actions">
                  {a.imap_host && a.inbound_enabled && (
                    <button className="btn ghost sm" type="button" disabled={busy === a.id}
                      onClick={() => void act(a.id, () => syncMailAccount(a.id).then((r) => toast(r.message, r.error ? 'bad' : 'ok')), 'Sync finished.')}>
                      ↻ Sync now
                    </button>
                  )}
                  {!a.is_default && (
                    <button className="btn ghost sm" type="button" disabled={busy === a.id}
                      onClick={() => void act(a.id, () => setMyDefaultMailAccount(a.id), 'Set as your default.')}>Set default</button>
                  )}
                  <button className="btn ghost sm" type="button" disabled={busy === a.id}
                    onClick={() => void act(a.id, () => testMyMailAccount(a.id).then((r) => toast(r.message, 'ok')), 'Test sent.')}>Test</button>
                  {a.encryption !== 'oauth' && <button className="btn ghost sm" type="button" onClick={() => setEditing(a)}>Edit</button>}
                  <button className="btn ghost sm" type="button" disabled={busy === a.id}
                    onClick={() => void act(a.id, () => deleteMyMailAccount(a.id), 'Account removed.')}>Delete</button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <p className="help" style={{ marginTop: 10 }}>
          <strong>Auto Sync:</strong> accounts with inbound sync switched on are polled automatically
          every few minutes, and matched to your leads by sender address. Use <em>Sync now</em> on an
          account to pull immediately.
        </p>

        {/* Calendar & social — grouped with mail under one Integrations section. */}
        <div className="intg" style={{ marginTop: 14 }}>
          <GoogleCalendarRow />

          <div className="intg-row">
            <div>
              <strong>Facebook Meta — Lead Ads</strong>
              <div className="muted">{integrations?.meta.detail ?? 'Link your own Meta account to sync your lead forms.'}</div>
            </div>
            <div className="acct-actions">
              <span className={`pill ${integrations?.meta.connected ? 'ok' : ''}`}>
                {integrations?.meta.connected ? 'Connected' : 'Not connected'}
              </span>
              <button className="btn ghost sm" type="button" onClick={() => navigate('/app/meta')}>
                {integrations?.meta.connected ? 'Open' : 'Connect'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ---- Email Preferences ---- */}
      <div className="card">
        <div className="modal-sub">Email Preferences</div>
        <div className="field">
          <label>Email Signature</label>
          <textarea rows={4} value={prefs.signature} maxLength={5000}
            onChange={(e) => setPrefs((p) => ({ ...p, signature: e.target.value }))}
            placeholder="Your name, title, phone — appended to outbound emails" />
        </div>
        <div className="field">
          <label>Default Reply Template</label>
          <textarea rows={3} value={prefs.replyTemplate} maxLength={5000}
            onChange={(e) => setPrefs((p) => ({ ...p, replyTemplate: e.target.value }))}
            placeholder="Optional default opening for replies" />
        </div>
        <div className="toolbar-row">
          <button className="btn primary" type="button" disabled={savingPrefs} onClick={() => void savePrefs()}>
            {savingPrefs ? 'Saving…' : 'Save Email Preferences'}
          </button>
        </div>
      </div>

      {editing && (
        <MailAccountModal
          account={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }}
        />
      )}
    </>
  );
}

/**
 * Google Calendar — real OAuth. "Connect" fetches Google's consent-screen URL and sends the
 * browser to it; Google shows the account picker and consent, then redirects back to
 * /app/account?google_connected=1. Works once the server has Google OAuth credentials; until
 * then the button explains it's not set up rather than failing.
 */
function GoogleCalendarRow() {
  const toast = useToast();
  const [st, setSt] = useState<GoogleCalendarStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => { googleCalendarStatus().then(setSt).catch(() => setSt(null)); }, []);
  useEffect(() => { load(); }, [load]);

  // Surface the outcome of the round-trip once, then clean the URL. If the connect was started from
  // another page (e.g. Email Settings → Integrations), a stored hint sends the browser back there so
  // the flow ends where it began.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const outcome = p.get('google_connected') ? 'google_connected=1'
      : p.get('google_error') ? `google_error=${encodeURIComponent(p.get('google_error') ?? '')}` : '';
    if (!outcome) return;
    const back = sessionStorage.getItem('gcal_return');
    if (back) {
      sessionStorage.removeItem('gcal_return');
      window.location.replace(back + (back.includes('?') ? '&' : '?') + outcome);
      return;
    }
    if (p.get('google_connected')) toast('Google Calendar connected.', 'ok');
    else toast(`Google connection failed: ${p.get('google_error')}`, 'bad');
    window.history.replaceState({}, '', '/app/account');
    load();
  }, [toast, load]);

  const connect = async () => {
    setBusy(true);
    try {
      const res = await googleCalendarConnect();
      if (res.url) window.location.href = res.url;               // → Google's own consent screen
      else toast(res.message || 'Google sign-in is not set up on the server.', 'bad');
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

  const detail = !st ? 'Checking…'
    : !st.configured ? (st.setup_hint || 'Google sign-in is not set up on the server yet.')
    : st.connected ? `Connected as ${st.email ?? 'your Google account'}${st.last_sync ? ` · last synced ${st.last_sync.slice(0, 16).replace('T', ' ')}` : ''}`
    : 'Connect your Google Calendar — sign in with Google and your events sync both ways.';

  return (
    <div className="intg-row">
      <div>
        <strong>Google Calendar</strong>
        <div className="muted">{detail}</div>
        {st?.error && <div className="muted" style={{ color: 'var(--bad)' }}>{st.error}</div>}
      </div>
      <div className="acct-actions">
        <span className={`pill ${st?.connected ? 'ok' : ''}`}>{st?.connected ? 'Connected' : 'Not connected'}</span>
        {st?.connected ? (
          <>
            <button className="btn ghost sm" type="button" disabled={busy}
              onClick={() => void run(() => googleCalendarSync(), 'Synced.')}>↻ Sync now</button>
            <button className="btn ghost sm" type="button" disabled={busy}
              onClick={() => void run(() => googleCalendarDisconnect().then(() => ({ message: 'Disconnected.' })), 'Disconnected.')}>Disconnect</button>
          </>
        ) : (
          <button className="btn primary sm" type="button" disabled={busy || (st ? !st.configured : true)} onClick={() => void connect()}>
            {busy ? '…' : 'Connect Google Calendar'}
          </button>
        )}
      </div>
    </div>
  );
}
