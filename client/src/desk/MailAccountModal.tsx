import { useState } from 'react';
import { createPortal } from 'react-dom';
import {
  addMyMailAccount, updateMyMailAccount, mailGoogleConnect,
  type AccountMailAccount, type MailAccountInput,
} from '../lib/accountApi';
import { apiErrorMessage, apiFieldErrors } from '../lib/apiError';
import { useToast } from './toast';

/** The multicolour Google "G", inline. */
const GoogleG = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </svg>
);

// Gmail's own SMTP/IMAP settings, auto-filled so an agent only supplies an app password.
const GMAIL = { host: 'smtp.gmail.com', port: 587, encryption: 'tls', imap_host: 'imap.gmail.com', imap_port: 993, imap_encryption: 'ssl' };

/**
 * Add or edit a personal mail account. Adding is a short wizard — enter the address, pick Gmail or
 * Custom SMTP, and give one app password. Editing shows the full detail form. Shared by Account
 * Settings and the CRM Settings → Integrations "Email Integration" card.
 */
export default function MailAccountModal({ account, onClose, onSaved }: {
  account: AccountMailAccount | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = !!account;
  // Adding: 'choose' → 'gmail' | 'smtp'. Editing: straight to the detail form.
  const [step, setStep] = useState<'choose' | 'gmail' | 'smtp' | 'edit'>(editing ? 'edit' : 'choose');
  const [email, setEmail] = useState(account?.from_email ?? '');

  // Rendered through a portal to <body> so the fixed-position overlay can never be trapped by a
  // transformed/animated ancestor (the settings cards use a pageIn transform) — which otherwise
  // makes the modal mis-position and overlap the page instead of centering over the viewport.
  return createPortal(
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
    </div>,
    document.body,
  );
}

/** Step 1 — pick how to connect: one-click Google sign-in, or the manual Gmail/SMTP fallback. */
function ChooseProvider({ email, setEmail, onGmail, onSmtp, onCancel }: {
  email: string; setEmail: (v: string) => void; onGmail: () => void; onSmtp: () => void; onCancel: () => void;
}) {
  const toast = useToast();
  const [connecting, setConnecting] = useState(false);
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const isGmail = /@(gmail\.com|googlemail\.com)$/i.test(email.trim());

  // Preferred path: OAuth. Sends the browser to Google's account chooser; the server stores the
  // account and returns to whichever page opened this modal (remembered below).
  const connectGoogle = async () => {
    setConnecting(true);
    try {
      const res = await mailGoogleConnect();
      if (res.url) {
        sessionStorage.setItem('mail_return', window.location.pathname + window.location.search);
        window.location.href = res.url;
      } else {
        toast(res.message || 'Google sign-in is not set up on the server.', 'bad');
        setConnecting(false);
      }
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not start Google sign-in'), 'bad');
      setConnecting(false);
    }
  };

  return (
    <>
      <div className="modal-h">Connect Email Account</div>

      <button type="button" className="btn gsi" style={{ width: '100%', justifyContent: 'center' }} disabled={connecting} onClick={() => void connectGoogle()}>
        <GoogleG /><span>{connecting ? 'Starting…' : 'Sign in with Google'}</span>
      </button>
      <p className="help" style={{ textAlign: 'center', margin: '8px 0 14px' }}>
        Recommended for Gmail / Google Workspace — pick your account, no password needed.
      </p>

      <div className="or-divider"><span>or connect manually</span></div>

      <div className="field" style={{ marginTop: 12 }}>
        <label>Email Address</label>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
      </div>
      <div className="provider-choice">
        <button type="button" className="provider-card" disabled={!valid} onClick={onGmail}>
          <span className="provider-ico">📧</span>
          <strong>Gmail{isGmail ? '' : ' / Google Workspace'}</strong>
          <span className="muted">Use a Gmail app password. Hosts filled in for you.</span>
        </button>
        <button type="button" className="provider-card" disabled={!valid} onClick={onSmtp}>
          <span className="provider-ico">🛠</span>
          <strong>Custom SMTP</strong>
          <span className="muted">Any provider — app password, host and port.</span>
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
