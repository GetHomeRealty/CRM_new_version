import { useCallback, useEffect, useRef, useState } from 'react';
import {
  crmEmailAction, crmIntegrations, crmOptions, getCrmEmailSettings, getCrmProfile, getCrmSettings,
  listCrmBroadcasts, listCrmEmailLog, listReferralCodes, saveCrmEmailSettings, saveCrmProfile,
  saveCrmSettings, sendCrmBroadcast,
} from '../lib/crmSettingsApi';
import { apiErrorMessage, apiFieldErrors } from '../lib/apiError';
import { useToast } from './toast';
import MetaConnectionPanel from './MetaConnectionPanel';
import GoogleCalendarCard from './GoogleCalendarCard';
import EmailIntegrationCard from './EmailIntegrationCard';
import type {
  CrmBroadcast, CrmEmailLogRow, CrmEmailSettings, CrmIntegrations, CrmProfile, CrmReferralCode,
  CrmSendResult, CrmSettings,
} from '../types';

const title = (v: string): string => v.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim();
const stamp = (iso: string | null): string => (iso ? iso.replace('T', ' ').slice(0, 16) : '—');

/** Labels for the six CRM notification switches, with the CRM's own descriptions. */
const NOTIFICATION_LABELS: Record<string, [string, string]> = {
  emailAlerts: ['Email Alerts', 'Receive important updates via email'],
  smsAlerts: ['SMS Alerts', 'Get notifications via text message'],
  leadNotifications: ['Lead Notifications', 'Get notified about new leads and updates'],
  showingReminders: ['Showing Reminders', 'Receive reminders for property showings'],
  marketUpdates: ['Market Updates', 'Stay informed about market changes'],
  documentAlerts: ['Document Alerts', 'Get notified about document updates'],
};

const TRIGGER_LABELS: Record<string, string> = {
  birthday: 'Birthday', anniversary: 'Anniversary', wedding: 'Wedding',
  seasonal: 'Seasonal', promotional: 'Promotional', referral: 'Referral', custom: 'Custom',
};

const ROLE_BADGE: Record<string, string> = {
  admin: 'Super Admin', manager: 'Admin', agent: 'Agent',
  accounting: 'Accounting', documentation: 'Documentation', crm: 'CRM',
};

/** A labelled on/off control. `input[type=checkbox]` styled as a switch by desk.css. */
function Toggle({ label, hint, checked, onChange, disabled }: {
  label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <label className="crm-toggle">
      <span className="crm-toggle-text">
        <strong>{label}</strong>
        {hint && <em>{hint}</em>}
      </span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

/**
 * CRM Settings, migrated from the CRM app and rendered beneath Transaction Desk's existing
 * Email Settings. Nothing above it is modified — the two sets of settings coexist, and the
 * overlap between them is intentional for now.
 */
export default function CrmSettingsPanel() {
  const toast = useToast();

  const [settings, setSettings] = useState<CrmSettings | null>(null);
  const [profile, setProfile] = useState<CrmProfile | null>(null);
  const [emailSettings, setEmailSettings] = useState<CrmEmailSettings | null>(null);
  const [integrations, setIntegrations] = useState<CrmIntegrations | null>(null);
  const [codes, setCodes] = useState<CrmReferralCode[]>([]);
  const [broadcasts, setBroadcasts] = useState<CrmBroadcast[]>([]);
  const [log, setLog] = useState<CrmEmailLogRow[]>([]);
  const [seasons, setSeasons] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  /**
   * Only the first fetch shows a loading state; later refreshes swap the panels in place so the
   * whole settings screen does not disappear behind "Loading CRM settings…" after every save.
   */
  const loadedOnce = useRef(false);

  const load = useCallback(async () => {
    if (!loadedOnce.current) setLoading(true);
    try {
      const [s, p, e, i, c, b, l, o] = await Promise.all([
        getCrmSettings(), getCrmProfile(), getCrmEmailSettings(), crmIntegrations(),
        listReferralCodes(), listCrmBroadcasts(), listCrmEmailLog(25), crmOptions(),
      ]);
      setSettings(s); setProfile(p); setEmailSettings(e); setIntegrations(i);
      setCodes(c); setBroadcasts(b); setLog(l); setSeasons(o.seasons);
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not load CRM settings'), 'bad');
    } finally {
      loadedOnce.current = true;
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    setErrors({});
    try {
      await fn();
      if (ok) toast(ok, 'ok');
    } catch (ex) {
      const fields = apiFieldErrors(ex);
      if (fields) setErrors(fields);
      toast(apiErrorMessage(ex, 'That did not work'), 'bad');
    } finally {
      setBusy('');
    }
  };

  const err = (k: string) => (errors[k]?.length ? <div className="field-err">{errors[k][0]}</div> : null);

  if (loading) return <div className="card"><p className="help">Loading CRM settings…</p></div>;
  if (!settings || !profile || !emailSettings) {
    return <div className="card"><p className="help">CRM settings are unavailable.</p></div>;
  }

  return (
    <>
      <div className="card crm-intro">
        <h2 className="crm-h">CRM Settings</h2>
        <p className="help">
          Migrated from the CRM. These sit alongside the Transaction Desk settings above and are
          stored separately — some fields deliberately appear in both places for now.
          {settings.is_admin
            ? ' You are editing the shared, brokerage-wide settings.'
            : ' You are editing your own personal settings.'}
        </p>
        {integrations?.mail_redirect.active && (
          <div className="reminder-warn" style={{ marginTop: 8 }}>
            <strong>Outgoing email is being diverted.</strong> {integrations.mail_redirect.detail}
          </div>
        )}
      </div>

      {/* ---------------------------------------------------- personal info */}
      <div className="card">
        <div className="modal-h">Personal Information</div>
        <div className="g2">
          <div className="field">
            <label>Full Name *</label>
            <input value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} />
            {err('name')}
          </div>
          <div className="field">
            <label>Username *</label>
            <input value={profile.username} onChange={(e) => setProfile({ ...profile, username: e.target.value })} />
            {err('username')}
          </div>
          <div className="field">
            <label>Phone Number</label>
            <input value={profile.phone} onChange={(e) => setProfile({ ...profile, phone: e.target.value })} />
            {err('phone')}
          </div>
          <div className="field">
            <label>Email Address</label>
            <input type="email" value={profile.email} onChange={(e) => setProfile({ ...profile, email: e.target.value })} />
            {err('email')}
          </div>
        </div>
        <div className="field">
          <label>Role</label>
          <span className="pill info">{ROLE_BADGE[profile.role] ?? profile.role}</span>
          <span className="help">Role is managed by administrators.</span>
        </div>
        <div className="actions">
          <button className="btn primary" type="button" disabled={busy !== ''}
            onClick={() => void run('profile', async () => setProfile(await saveCrmProfile({
              name: profile.name, username: profile.username, email: profile.email, phone: profile.phone,
            })), 'Personal information updated successfully')}>
            {busy === 'profile' ? 'Saving…' : 'Save Personal Information'}
          </button>
        </div>
      </div>

      {/* ---------------------------------------------------- notifications */}
      <div className="card">
        <div className="modal-h">Notification Settings</div>
        <div className="g2">
          {settings.options.notification_keys.map((key) => {
            const [label, hint] = NOTIFICATION_LABELS[key] ?? [title(key), ''];
            const value = (settings.notifications as unknown as Record<string, boolean>)[key];
            return (
              <Toggle key={key} label={label} hint={hint} checked={!!value}
                onChange={(v) => setSettings({ ...settings, notifications: { ...settings.notifications, [key]: v } })} />
            );
          })}
        </div>
        <div className="actions">
          <button className="btn primary" type="button" disabled={busy !== ''}
            onClick={() => void run('notifications', () => saveCrmSettings({ notifications: settings.notifications }), 'Notification settings updated successfully')}>
            {busy === 'notifications' ? 'Saving…' : 'Save Notification Settings'}
          </button>
        </div>

        <div className="modal-sub">Broadcast Message</div>
        <BroadcastForm
          onSent={async () => { setBroadcasts(await listCrmBroadcasts()); }}
        />
        {broadcasts.length > 0 && (
          <ul className="crm-feed">
            {broadcasts.slice(0, 5).map((b) => (
              <li key={b.id}>
                <div>{b.message}</div>
                <div className="muted">{stamp(b.created_at)} · {b.recipients} recipient(s) · {b.sent_by ?? '—'}</div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* --------------------------------------------- user email preferences */}
      <div className="card">
        <div className="modal-h">Email Preferences</div>
        <div className="field">
          <label>Signature</label>
          <textarea rows={3} value={settings.emailSettings.signature}
            onChange={(e) => setSettings({ ...settings, emailSettings: { ...settings.emailSettings, signature: e.target.value } })} />
          <span className="help">Appended to the CRM emails you send from this screen.</span>
          {err('signature')}
        </div>
        <div className="field">
          <label>Reply Template</label>
          <textarea rows={3} value={settings.emailSettings.replyTemplate}
            onChange={(e) => setSettings({ ...settings, emailSettings: { ...settings.emailSettings, replyTemplate: e.target.value } })} />
          {err('replyTemplate')}
        </div>
        <Toggle label="Auto-responder" hint="Send an automatic reply to incoming mail"
          checked={settings.emailSettings.autoResponder.enabled}
          onChange={(v) => setSettings({ ...settings, emailSettings: { ...settings.emailSettings, autoResponder: { ...settings.emailSettings.autoResponder, enabled: v } } })} />
        <div className="field">
          <label>Auto-responder Message</label>
          <textarea rows={2} value={settings.emailSettings.autoResponder.message}
            disabled={!settings.emailSettings.autoResponder.enabled}
            onChange={(e) => setSettings({ ...settings, emailSettings: { ...settings.emailSettings, autoResponder: { ...settings.emailSettings.autoResponder, message: e.target.value } } })} />
        </div>
        <div className="field">
          <label>Forwarding Address</label>
          <input type="email" value={settings.emailSettings.forwardingAddress}
            onChange={(e) => setSettings({ ...settings, emailSettings: { ...settings.emailSettings, forwardingAddress: e.target.value } })} />
          {err('forwardingAddress')}
        </div>
        <div className="actions">
          <button className="btn primary" type="button" disabled={busy !== ''}
            onClick={() => void run('emailPrefs', () => saveCrmSettings({ emailSettings: settings.emailSettings }), 'Email preferences saved successfully')}>
            {busy === 'emailPrefs' ? 'Saving…' : 'Save Email Preferences'}
          </button>
        </div>
      </div>

      {/* ------------------------------------------------------- preferences */}
      <div className="card">
        <div className="modal-h">Preferences</div>
        <div className="g3">
          <div className="field">
            <label>Language</label>
            <select value={settings.preferences.language}
              onChange={(e) => setSettings({ ...settings, preferences: { ...settings.preferences, language: e.target.value } })}>
              {settings.options.languages.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Time Zone</label>
            <select value={settings.preferences.timeZone}
              onChange={(e) => setSettings({ ...settings, preferences: { ...settings.preferences, timeZone: e.target.value } })}>
              {settings.options.time_zones.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Currency</label>
            <select value={settings.preferences.currency}
              onChange={(e) => setSettings({ ...settings, preferences: { ...settings.preferences, currency: e.target.value } })}>
              {settings.options.currencies.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Date Format</label>
            <select value={settings.preferences.dateFormat}
              onChange={(e) => setSettings({ ...settings, preferences: { ...settings.preferences, dateFormat: e.target.value } })}>
              {settings.options.date_formats.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Theme</label>
            <select value={settings.preferences.theme}
              onChange={(e) => setSettings({ ...settings, preferences: { ...settings.preferences, theme: e.target.value } })}>
              {settings.options.themes.map((t) => <option key={t} value={t}>{title(t)}</option>)}
            </select>
          </div>
        </div>
        <div className="actions">
          <button className="btn primary" type="button" disabled={busy !== ''}
            onClick={() => void run('prefs', () => saveCrmSettings({ preferences: settings.preferences }), 'Preferences saved')}>
            {busy === 'prefs' ? 'Saving…' : 'Save Preferences'}
          </button>
        </div>
      </div>

      {/* --------------------------------------------------- email campaigns */}
      <div className="card">
        <div className="modal-h">Email Campaigns</div>
        <p className="help">
          The CRM's own SMTP details and automatic-email switches. Transaction Desk sends through
          the Mail Accounts configured above; these values are kept for reference and to gate the
          triggers below.
        </p>
        <div className="g2">
          <div className="field">
            <label>SMTP Host</label>
            <input value={emailSettings.smtpHost} onChange={(e) => setEmailSettings({ ...emailSettings, smtpHost: e.target.value })} />
          </div>
          <div className="field">
            <label>SMTP Port</label>
            <input value={emailSettings.smtpPort} onChange={(e) => setEmailSettings({ ...emailSettings, smtpPort: e.target.value })} />
            {err('smtpPort')}
          </div>
          <div className="field">
            <label>SMTP User</label>
            <input value={emailSettings.smtpUser} onChange={(e) => setEmailSettings({ ...emailSettings, smtpUser: e.target.value })} />
          </div>
          <div className="field">
            <label>Admin Email</label>
            <input type="email" value={emailSettings.adminEmail} onChange={(e) => setEmailSettings({ ...emailSettings, adminEmail: e.target.value })} />
            {err('adminEmail')}
          </div>
        </div>
        <Toggle label="Automatic sending" hint="Master switch for the triggers below"
          checked={emailSettings.autoSendEnabled}
          onChange={(v) => setEmailSettings({ ...emailSettings, autoSendEnabled: v })} />

        <div className="modal-sub">Email Triggers</div>
        <div className="g3">
          {emailSettings.trigger_keys.map((key) => (
            <Toggle key={key} label={TRIGGER_LABELS[key] ?? title(key)}
              checked={emailSettings.emailTemplates[key] !== false}
              disabled={!emailSettings.autoSendEnabled}
              onChange={(v) => setEmailSettings({ ...emailSettings, emailTemplates: { ...emailSettings.emailTemplates, [key]: v } })} />
          ))}
        </div>
        <div className="actions">
          <button className="btn primary" type="button" disabled={busy !== ''}
            onClick={() => void run('emailSettings', async () => setEmailSettings(await saveCrmEmailSettings({ ...emailSettings })), 'Settings updated successfully')}>
            {busy === 'emailSettings' ? 'Saving…' : 'Save Email Campaign Settings'}
          </button>
        </div>
      </div>

      {/* Trigger templates moved to the Triggers screen (Triggers -> CRM Triggers), where an
          automation is actually looked for. Same data, same endpoint — only the location moved. */}

      {/* -------------------------------------------------- send an email */}
      <SendEmailCard
        seasons={seasons}
        onSent={async () => { setLog(await listCrmEmailLog(25)); }}
      />

      {/* ------------------------------------------------------ referral codes */}
      <div className="card">
        <div className="modal-h">Referral Codes</div>
        <ReferralGenerator onGenerated={async () => setCodes(await listReferralCodes())} />
        {codes.length === 0 ? <p className="help">No referral codes yet.</p> : (
          <div className="lead-scroll">
            <table className="list-table">
              <thead><tr><th>Code</th><th>Discount</th><th>Valid until</th><th>Used</th><th>Created by</th></tr></thead>
              <tbody>
                {codes.map((c) => (
                  <tr key={c.id}>
                    <td><strong>{c.code}</strong></td>
                    <td>{c.discount}%</td>
                    <td>{c.validUntil} {c.expired && <span className="pill bad">Expired</span>}</td>
                    <td>{c.usageCount} / {c.maxUsage}</td>
                    <td className="muted">{c.created_by ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* -------------------------------------------------------- integrations */}
      {/* CRM-side integrations. Meta lives here and ONLY here: Facebook/Instagram lead
          capture is a CRM concern, so it is deliberately absent from Settings →
          Integrations, which serves the transaction side. Mail and calendar appear in
          both places because a single per-user connection powers both — the same card,
          the same connection, reachable from whichever area you happen to be working in. */}
      <div className="card">
        <div className="modal-h">Integrations</div>
        <p className="help">
          Connect the outside services the CRM works with. Each connection is scoped to your own login.
        </p>

        {/* Mail Configuration — connect your own Gmail / SMTP sending + inbox account. */}
        <EmailIntegrationCard scope="crm" />

        {/* Google Calendar — real OAuth "Sign in with Google", connected right here. */}
        <GoogleCalendarCard scope="crm" />
      </div>

      {/* Live Meta connection — the same panel the Meta screen uses, embedded here so the
          integration can be managed without leaving CRM Settings. */}
      <MetaConnectionPanel compact />

      {/* ----------------------------------------------------------- send log */}
      <div className="card">
        <div className="modal-h">CRM Email Log</div>
        {log.length === 0 ? <p className="help">Nothing sent from CRM Settings yet.</p> : (
          <div className="lead-scroll">
            <table className="list-table">
              <thead><tr><th>When</th><th>Type</th><th>Recipient</th><th>Subject</th><th>Result</th><th>By</th></tr></thead>
              <tbody>
                {log.map((r) => (
                  <tr key={r.id}>
                    <td>{stamp(r.created_at)}</td>
                    <td>{title(r.kind)}</td>
                    <td className="muted">
                      {r.recipient}
                      {r.redirected && <div className="pill warn">→ {r.redirected}</div>}
                    </td>
                    <td className="muted">{r.subject ?? '—'}</td>
                    <td>{r.success ? <span className="pill ok">Sent</span> : <span className="pill bad" title={r.error ?? ''}>Failed</span>}</td>
                    <td className="muted">{r.sent_by ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function BroadcastForm({ onSent }: { onSent: () => Promise<void> }) {
  const toast = useToast();
  const [message, setMessage] = useState('');
  const [type, setType] = useState('info');
  const [busy, setBusy] = useState(false);

  const send = async () => {
    if (!message.trim()) { toast('Please enter a message', 'bad'); return; }
    setBusy(true);
    try {
      const res = await sendCrmBroadcast(message.trim(), type);
      toast(res.message, 'ok');
      setMessage('');
      await onSent();
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not send the broadcast'), 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="field">
        <textarea rows={3} value={message} placeholder="Enter your message here…"
          onChange={(e) => setMessage(e.target.value)} />
        <span className="help">Recorded for every active user. Transaction Desk builds its notification feeds from live data, so this is stored as an announcement rather than pushed.</span>
      </div>
      <div className="toolbar-row">
        <select value={type} onChange={(e) => setType(e.target.value)}>
          {['info', 'warning', 'success'].map((t) => <option key={t} value={t}>{title(t)}</option>)}
        </select>
        <button className="btn primary" type="button" disabled={busy || !message.trim()} onClick={() => void send()}>
          {busy ? 'Sending…' : 'Send to All Users'}
        </button>
      </div>
    </>
  );
}

function ReferralGenerator({ onGenerated }: { onGenerated: () => Promise<void> }) {
  const toast = useToast();
  const [form, setForm] = useState({ discount: '10', validDays: '30', maxUsage: '5' });
  const [busy, setBusy] = useState(false);

  return (
    <div className="toolbar-row" style={{ marginBottom: 12 }}>
      <div className="field" style={{ marginBottom: 0 }}>
        <label>Discount %</label>
        <input type="number" min={1} max={100} value={form.discount} onChange={(e) => setForm({ ...form, discount: e.target.value })} />
      </div>
      <div className="field" style={{ marginBottom: 0 }}>
        <label>Valid days</label>
        <input type="number" min={1} value={form.validDays} onChange={(e) => setForm({ ...form, validDays: e.target.value })} />
      </div>
      <div className="field" style={{ marginBottom: 0 }}>
        <label>Max uses</label>
        <input type="number" min={1} value={form.maxUsage} onChange={(e) => setForm({ ...form, maxUsage: e.target.value })} />
      </div>
      <button className="btn ghost" type="button" disabled={busy}
        onClick={() => {
          setBusy(true);
          crmEmailAction<{ success: boolean; data: { code: string } }>('generateReferralCode', {
            discount: Number(form.discount), validDays: Number(form.validDays), maxUsage: Number(form.maxUsage),
          })
            .then(async (r) => { toast(`Referral code ${r.data.code} generated.`, 'ok'); await onGenerated(); })
            .catch((ex) => toast(apiErrorMessage(ex, 'Could not generate a code'), 'bad'))
            .finally(() => setBusy(false));
        }}>
        {busy ? 'Generating…' : 'Generate Code'}
      </button>
    </div>
  );
}

/** The CRM's advanced-email actions: wedding, seasonal, promotional, referral and custom. */
function SendEmailCard({ seasons, onSent }: { seasons: string[]; onSent: () => Promise<void> }) {
  const toast = useToast();
  const [kind, setKind] = useState('wedding');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    leadName: '', leadEmail: '', weddingDate: '',
    season: seasons[0] ?? 'Holiday Season', year: String(new Date().getFullYear()),
    offerTitle: '', offerDescription: '', offerDiscount: '', offerValidUntil: '', offerCode: '',
    referralCode: '', referralDiscount: '10', referralMaxUsage: '5', referralValidUntil: '',
    subject: '', content: '',
  });
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const actionFor: Record<string, string> = {
    wedding: 'sendWeddingEmail', seasonal: 'sendSeasonalEmail',
    promotional: 'sendPromotionalEmail', referral: 'sendReferralEmail', custom: 'sendCustomEmail',
  };

  const payload = (): Record<string, unknown> => {
    const base = { leadName: form.leadName, leadEmail: form.leadEmail };
    switch (kind) {
      case 'wedding': return { ...base, weddingDate: form.weddingDate };
      case 'seasonal': return { ...base, season: form.season, year: form.year };
      case 'promotional': return { ...base, offer: {
        title: form.offerTitle, description: form.offerDescription,
        discount: form.offerDiscount, validUntil: form.offerValidUntil, code: form.offerCode,
      } };
      case 'referral': return { ...base, referralCode: {
        code: form.referralCode, discount: Number(form.referralDiscount) || 10,
        validUntil: form.referralValidUntil || new Date(Date.now() + 30 * 86400000).toISOString(),
        usageCount: 0, maxUsage: Number(form.referralMaxUsage) || 5,
      } };
      default: return { ...base, subject: form.subject, content: form.content };
    }
  };

  const send = async () => {
    if (!form.leadEmail.trim()) { toast('Enter a recipient email address', 'bad'); return; }
    setBusy(true);
    try {
      const res = await crmEmailAction<CrmSendResult>(actionFor[kind], payload());
      toast(res.message, res.success ? 'ok' : 'bad');
      await onSent();
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not send the email'), 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="modal-h">Send a CRM Email</div>
      <p className="help">
        Sends immediately to the address below, using the matching trigger — a disabled trigger
        refuses the send. Every attempt is recorded in the log at the bottom of this page.
      </p>
      <div className="g3">
        <div className="field">
          <label>Type</label>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {Object.keys(actionFor).map((k) => <option key={k} value={k}>{title(k)}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Recipient Name</label>
          <input value={form.leadName} onChange={(e) => set('leadName', e.target.value)} />
        </div>
        <div className="field">
          <label>Recipient Email *</label>
          <input type="email" value={form.leadEmail} onChange={(e) => set('leadEmail', e.target.value)} />
        </div>
      </div>

      {kind === 'wedding' && (
        <div className="field">
          <label>Wedding Date</label>
          <input type="date" value={form.weddingDate} onChange={(e) => set('weddingDate', e.target.value)} />
        </div>
      )}

      {kind === 'seasonal' && (
        <div className="g2">
          <div className="field">
            <label>Season</label>
            <select value={form.season} onChange={(e) => set('season', e.target.value)}>
              {seasons.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Year</label>
            <input value={form.year} onChange={(e) => set('year', e.target.value)} />
          </div>
        </div>
      )}

      {kind === 'promotional' && (
        <>
          <div className="g2">
            <div className="field">
              <label>Offer Title</label>
              <input value={form.offerTitle} onChange={(e) => set('offerTitle', e.target.value)} />
            </div>
            <div className="field">
              <label>Discount</label>
              <input value={form.offerDiscount} onChange={(e) => set('offerDiscount', e.target.value)} placeholder="e.g. 10%" />
            </div>
            <div className="field">
              <label>Offer Code</label>
              <input value={form.offerCode} onChange={(e) => set('offerCode', e.target.value)} />
            </div>
            <div className="field">
              <label>Valid Until</label>
              <input type="date" value={form.offerValidUntil} onChange={(e) => set('offerValidUntil', e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label>Description</label>
            <textarea rows={2} value={form.offerDescription} onChange={(e) => set('offerDescription', e.target.value)} />
          </div>
        </>
      )}

      {kind === 'referral' && (
        <div className="g2">
          <div className="field">
            <label>Referral Code *</label>
            <input value={form.referralCode} onChange={(e) => set('referralCode', e.target.value)} placeholder="Generate one below, or type it" />
          </div>
          <div className="field">
            <label>Discount %</label>
            <input type="number" value={form.referralDiscount} onChange={(e) => set('referralDiscount', e.target.value)} />
          </div>
          <div className="field">
            <label>Max Uses</label>
            <input type="number" value={form.referralMaxUsage} onChange={(e) => set('referralMaxUsage', e.target.value)} />
          </div>
          <div className="field">
            <label>Valid Until</label>
            <input type="date" value={form.referralValidUntil} onChange={(e) => set('referralValidUntil', e.target.value)} />
          </div>
        </div>
      )}

      {kind === 'custom' && (
        <>
          <div className="field">
            <label>Subject *</label>
            <input value={form.subject} onChange={(e) => set('subject', e.target.value)} />
          </div>
          <div className="field">
            <label>Message (HTML) *</label>
            <textarea rows={5} className="tpl-code" value={form.content} onChange={(e) => set('content', e.target.value)} />
          </div>
        </>
      )}

      <div className="actions">
        <button className="btn primary" type="button" disabled={busy} onClick={() => void send()}>
          {busy ? 'Sending…' : 'Send Email'}
        </button>
      </div>
    </div>
  );
}
