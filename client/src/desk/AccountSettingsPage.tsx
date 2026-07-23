import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  addMyMailAccount, deleteMyMailAccount, getAccountProfile, getAccountSettings, listMyMailAccounts,
  saveAccountEmailPrefs, saveAccountProfile, setMyDefaultMailAccount, syncMailAccount, testMyMailAccount,
  updateMyMailAccount, googleCalendarStatus, googleCalendarConnect, googleCalendarSync, googleCalendarDisconnect,
  icalStatus, icalConnect, icalSync, icalDisconnect,
  type AccountEmailPrefs, type AccountIntegrations, type AccountMailAccount, type MailAccountInput,
  type GoogleCalendarStatus, type IcalStatus,
} from '../lib/accountApi';
import { apiErrorMessage, apiFieldErrors } from '../lib/apiError';
import { useToast } from './toast';

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

      {/* ---- Connected Email Accounts ---- */}
      <div className="card">
        <div className="modal-sub">Mail Configuration</div>
        <p className="help">Connect your own SMTP account to send lead emails and campaigns from your own address. Until you add one, your mail goes out through the brokerage account.</p>

        <div className="acct-head">
          <strong>Connected Email Accounts</strong>
          <button className="btn primary sm" type="button" onClick={() => setEditing('new')}>+ Add Email Account</button>
        </div>

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
                  <button className="btn ghost sm" type="button" onClick={() => setEditing(a)}>Edit</button>
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

      {/* ---- Other Integrations ---- */}
      <div className="card">
        <div className="modal-sub">Other Integrations</div>
        <p className="help">Calendar and social accounts.</p>

        <div className="intg">
          <GoogleCalendarRow />
          <IcalFeedRow />


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

  // Surface the outcome of the round-trip once, then clean the URL.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('google_connected')) { toast('Google Calendar connected.', 'ok'); }
    else if (p.get('google_error')) { toast(`Google connection failed: ${p.get('google_error')}`, 'bad'); }
    if (p.get('google_connected') || p.get('google_error')) {
      window.history.replaceState({}, '', '/app/account');
      load();
    }
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

/**
 * Google Calendar via the secret iCal link — the no-OAuth option. Read-only: it pulls Google
 * events into the CRM calendar but cannot push CRM events back. No account picker; you paste the
 * "Secret address in iCal format" from Google Calendar settings.
 */
function IcalFeedRow() {
  const toast = useToast();
  const [st, setSt] = useState<IcalStatus | null>(null);
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => { icalStatus().then(setSt).catch(() => setSt(null)); }, []);
  useEffect(() => { load(); }, [load]);

  const connect = async () => {
    if (!url.trim()) return;
    setBusy(true);
    try {
      const r = await icalConnect(url.trim());
      toast(r.message, 'ok');
      setAdding(false); setUrl(''); load();
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not connect that calendar link'), 'bad');
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

  return (
    <div className="intg-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <strong>Google Calendar — link (no sign-in)</strong>
          <div className="muted">
            {st?.connected
              ? `Connected${st.name ? ` "${st.name}"` : ''} via secret link — read-only${st.last_sync ? ` · last synced ${st.last_sync.slice(0, 16).replace('T', ' ')}` : ''}`
              : 'Paste your calendar’s secret iCal link — your Google events appear on the calendar. No account picker; read-only.'}
          </div>
          {st?.error && <div className="muted" style={{ color: 'var(--bad)' }}>{st.error}</div>}
        </div>
        <div className="acct-actions">
          <span className={`pill ${st?.connected ? 'ok' : ''}`}>{st?.connected ? 'Connected' : 'Not connected'}</span>
          {st?.connected ? (
            <>
              <button className="btn ghost sm" type="button" disabled={busy} onClick={() => void run(() => icalSync(), 'Synced.')}>↻ Sync now</button>
              <button className="btn ghost sm" type="button" disabled={busy} onClick={() => void run(() => icalDisconnect().then(() => ({ message: 'Disconnected.' })), 'Disconnected.')}>Disconnect</button>
            </>
          ) : (
            <button className="btn sm" type="button" onClick={() => setAdding((a) => !a)}>Use a calendar link</button>
          )}
        </div>
      </div>

      {adding && !st?.connected && (
        <div className="notice-box">
          In Google Calendar, open <em>Settings → your calendar → Integrate calendar</em>, and copy the
          <strong> “Secret address in iCal format”</strong> (ends in <code>/basic.ics</code>). Paste it here.
          <div className="type-custom-row" style={{ marginTop: 8 }}>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" />
            <button className="btn primary sm" type="button" disabled={busy || !url.trim()} onClick={() => void connect()}>
              {busy ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Gmail's own SMTP/IMAP settings, auto-filled so an agent only supplies an app password.
const GMAIL = { host: 'smtp.gmail.com', port: 587, encryption: 'tls', imap_host: 'imap.gmail.com', imap_port: 993, imap_encryption: 'ssl' };

// ------------------------------------------------------------- add/edit modal
/**
 * Adding is a short wizard — enter the address, pick Gmail or Custom SMTP, and give one password.
 * Editing an existing account shows the full detail form. Kept deliberately simple for agents;
 * the fiddly host/port defaults are filled in for them.
 */
function MailAccountModal({ account, onClose, onSaved }: {
  account: AccountMailAccount | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = !!account;
  // Adding: 'choose' → 'gmail' | 'smtp'. Editing: straight to the detail form.
  const [step, setStep] = useState<'choose' | 'gmail' | 'smtp' | 'edit'>(editing ? 'edit' : 'choose');
  const [email, setEmail] = useState(account?.from_email ?? '');

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <button className="close" type="button" onClick={onClose} aria-label="Close">✕</button>

        {step === 'choose' && (
          <ChooseProvider email={email} setEmail={setEmail}
            onGmail={() => setStep('gmail')} onSmtp={() => setStep('smtp')} onCancel={onClose} />
        )}
        {step === 'gmail' && (
          <ProviderForm mode="gmail" email={email} onBack={() => setStep('choose')} onClose={onClose} onSaved={onSaved} />
        )}
        {step === 'smtp' && (
          <ProviderForm mode="smtp" email={email} onBack={() => setStep('choose')} onClose={onClose} onSaved={onSaved} />
        )}
        {step === 'edit' && account && (
          <EditForm account={account} onClose={onClose} onSaved={onSaved} />
        )}
      </div>
    </div>
  );
}

/** Step 1 — the address and the two ways to connect it. */
function ChooseProvider({ email, setEmail, onGmail, onSmtp, onCancel }: {
  email: string; setEmail: (v: string) => void; onGmail: () => void; onSmtp: () => void; onCancel: () => void;
}) {
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const isGmail = /@(gmail\.com|googlemail\.com)$/i.test(email.trim());
  return (
    <>
      <div className="modal-h">Add Email Account</div>
      <div className="field">
        <label>Email Address</label>
        <input type="email" value={email} autoFocus onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
      </div>
      <p className="help">How would you like to connect it?</p>
      <div className="provider-choice">
        <button type="button" className="provider-card" disabled={!valid} onClick={onGmail}>
          <span className="provider-ico">📧</span>
          <strong>Gmail{isGmail ? '' : ' / Google Workspace'}</strong>
          <span className="muted">Sign in with a Gmail app password. Hosts filled in for you.</span>
        </button>
        <button type="button" className="provider-card" disabled={!valid} onClick={onSmtp}>
          <span className="provider-ico">🛠</span>
          <strong>Custom SMTP</strong>
          <span className="muted">Your own mail server — app password, host and port.</span>
        </button>
      </div>
      <div className="modal-foot">
        <button className="btn ghost" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </>
  );
}

/** Step 2 — Gmail (just an app password) or Custom SMTP (password + host + port). */
function ProviderForm({ mode, email, onBack, onClose, onSaved }: {
  mode: 'gmail' | 'smtp'; email: string; onBack: () => void; onClose: () => void; onSaved: () => void;
}) {
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState(587);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState(false);
  const err = (k: string) => (errors[k]?.length ? <div className="field-err">{errors[k][0]}</div> : null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErrors({});
    try {
      const common = { name: email, from_email: email, username: email, password };
      const body: MailAccountInput = mode === 'gmail'
        ? { ...common, ...GMAIL, is_default: true, inbound_enabled: true }
        : {
            ...common, host: smtpHost.trim(), port: Number(smtpPort), encryption: 'tls',
            // Reasonable IMAP guess from the SMTP host (smtp.x → imap.x), so inbound works too.
            imap_host: smtpHost.trim().replace(/^smtp\./i, 'imap.'),
            imap_port: 993, imap_encryption: 'ssl', inbound_enabled: true, is_default: true,
          };
      await addMyMailAccount(body);
      toast('Email account added.', 'ok');
      onSaved();
    } catch (ex) {
      const f = apiFieldErrors(ex);
      if (f) setErrors(f);
      toast(apiErrorMessage(ex, 'Could not add the account'), 'bad');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <div className="modal-h">{mode === 'gmail' ? 'Connect Gmail' : 'Custom SMTP'}</div>
      <p className="help"><strong>{email}</strong></p>

      {mode === 'gmail' ? (
        <div className="notice-box">
          Gmail is connected with an <strong>app password</strong>, not your normal password. In your
          Google Account go to <em>Security → App passwords</em> (2-step verification must be on),
          create one for “Mail”, and paste the 16-character code below. Sending and inbox sync both
          use it.
        </div>
      ) : (
        <p className="help">Enter your provider’s SMTP details. Use an app password if your provider requires one.</p>
      )}

      <div className="field">
        <label>App Password *</label>
        <input type="password" value={password} autoFocus onChange={(e) => setPassword(e.target.value)}
          placeholder={mode === 'gmail' ? '16-character Gmail app password' : 'App password or SMTP password'} required />
        {err('password')}
      </div>

      {mode === 'smtp' && (
        <div className="g2">
          <div className="field">
            <label>SMTP Host *</label>
            <input value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} placeholder="smtp.yourprovider.com" required />
            {err('host')}
          </div>
          <div className="field">
            <label>SMTP Port *</label>
            <input type="number" value={smtpPort} onChange={(e) => setSmtpPort(Number(e.target.value))} placeholder="587" required />
            {err('port')}
          </div>
        </div>
      )}

      <div className="modal-foot">
        <button className="btn ghost" type="button" onClick={onBack}>← Back</button>
        <button className="btn ghost" type="button" onClick={onClose}>Cancel</button>
        <button className="btn primary" type="submit" disabled={saving || !password || (mode === 'smtp' && !smtpHost.trim())}>
          {saving ? 'Adding…' : 'Add Account'}
        </button>
      </div>
    </form>
  );
}

/** The full detail form, used only when editing an existing account. */
function EditForm({ account, onClose, onSaved }: { account: AccountMailAccount; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: account.name, from_name: account.from_name ?? '', from_email: account.from_email,
    host: account.host, port: account.port, username: account.username ?? '', password: '',
    encryption: account.encryption ?? 'tls', is_active: account.is_active, is_default: account.is_default,
    imap_host: account.imap_host ?? '', imap_port: account.imap_port ?? 993,
    imap_encryption: account.imap_encryption ?? 'ssl', inbound_enabled: account.inbound_enabled,
  });
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const err = (k: string) => (errors[k]?.length ? <div className="field-err">{errors[k][0]}</div> : null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErrors({});
    try {
      const body: Partial<MailAccountInput> = {
        name: form.name.trim(), from_name: form.from_name.trim(), from_email: form.from_email.trim(),
        host: form.host.trim(), port: Number(form.port), username: form.username.trim(),
        encryption: form.encryption, is_active: form.is_active, is_default: form.is_default,
        imap_host: form.imap_host.trim(), imap_port: form.imap_host ? Number(form.imap_port) : null,
        imap_encryption: form.imap_encryption, inbound_enabled: !!(form.imap_host && form.inbound_enabled),
      };
      if (form.password) body.password = form.password;
      await updateMyMailAccount(account.id, body);
      toast('Email account updated.', 'ok');
      onSaved();
    } catch (ex) {
      const f = apiFieldErrors(ex);
      if (f) setErrors(f);
      toast(apiErrorMessage(ex, 'Could not save the account'), 'bad');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <div className="modal-h">Edit Email Account</div>
      <div className="g2">
        <div className="field"><label>Account Name *</label><input value={form.name} onChange={(e) => set('name', e.target.value)} required />{err('name')}</div>
        <div className="field"><label>From Name</label><input value={form.from_name} onChange={(e) => set('from_name', e.target.value)} /></div>
        <div className="field"><label>From Email *</label><input type="email" value={form.from_email} onChange={(e) => set('from_email', e.target.value)} required />{err('from_email')}</div>
        <div className="field"><label>SMTP Host *</label><input value={form.host} onChange={(e) => set('host', e.target.value)} required />{err('host')}</div>
        <div className="field"><label>Port</label><input type="number" value={form.port} onChange={(e) => set('port', Number(e.target.value))} />{err('port')}</div>
        <div className="field">
          <label>Encryption</label>
          <select value={form.encryption} onChange={(e) => set('encryption', e.target.value)}><option value="tls">TLS</option><option value="ssl">SSL</option></select>
        </div>
        <div className="field"><label>Username</label><input value={form.username} onChange={(e) => set('username', e.target.value)} /></div>
        <div className="field"><label>App Password (leave blank to keep)</label><input type="password" value={form.password} onChange={(e) => set('password', e.target.value)} placeholder={account.has_password ? '•••••••• stored' : ''} /></div>
      </div>
      <div className="toolbar-row" style={{ gap: 16 }}>
        <label className="acct-toggle"><input type="checkbox" checked={form.is_active} onChange={(e) => set('is_active', e.target.checked)} /><span>Active</span></label>
        <label className="acct-toggle"><input type="checkbox" checked={form.is_default} onChange={(e) => set('is_default', e.target.checked)} /><span>Default sender</span></label>
      </div>

      <div className="modal-sub" style={{ marginTop: 12 }}>Receive Mail (IMAP)</div>
      <div className="g3">
        <div className="field"><label>IMAP Host</label><input value={form.imap_host} onChange={(e) => set('imap_host', e.target.value)} placeholder="imap.gmail.com" />{err('imap_host')}</div>
        <div className="field"><label>IMAP Port</label><input type="number" value={form.imap_port ?? 993} onChange={(e) => set('imap_port', Number(e.target.value))} />{err('imap_port')}</div>
        <div className="field"><label>IMAP Security</label><select value={form.imap_encryption} onChange={(e) => set('imap_encryption', e.target.value)}><option value="ssl">SSL (993)</option><option value="tls">STARTTLS (143)</option></select></div>
      </div>
      <label className="acct-toggle">
        <input type="checkbox" checked={form.inbound_enabled} disabled={!form.imap_host} onChange={(e) => set('inbound_enabled', e.target.checked)} />
        <span><strong>Automatically sync received mail</strong></span>
      </label>

      <div className="modal-foot">
        <button className="btn ghost" type="button" onClick={onClose}>Cancel</button>
        <button className="btn primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}
