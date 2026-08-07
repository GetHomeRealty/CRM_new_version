import { useCallback, useEffect, useRef, useState } from 'react';
import {
  crmEmailAction, crmIntegrations, crmOptions, getCrmEmailSettings, getCrmProfile, getCrmSettings,
  listCrmBroadcasts, listCrmEmailLog, listReferralCodes, saveCrmEmailSettings, saveCrmProfile,
  saveCrmSettings, sendCrmBroadcast,
} from '../lib/crmSettingsApi';
import { Link } from 'react-router-dom';
import { apiErrorMessage, apiFieldErrors } from '../lib/apiError';
import { useAuth } from '../context/AuthContext';
import { listLeads } from '../lib/leadsApi';
import AutoComplete from './AutoComplete';
import { useArea } from './AreaContext';
import { useUnsavedGuard } from './useUnsavedGuard';
import { areaPath } from './area';
import ConfirmDialog, { useConfirm } from './ConfirmDialog';
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

const TRIGGER_LABELS: Record<string, string> = {
  birthday: 'Birthday', anniversary: 'Anniversary', wedding: 'Wedding',
  seasonal: 'Seasonal', promotional: 'Promotional', referral: 'Referral', custom: 'Custom',
};

const ROLE_BADGE: Record<string, string> = {
  admin: 'Super Admin', manager: 'Admin', agent: 'Agent',
  accounting: 'Accounting', documentation: 'Documentation', crm: 'CRM',
};

/**
 * How a broadcast's delivery ended, in words rather than a stored keyword.
 *
 * `sending` is genuinely still going — delivery runs off the request thread — and a run interrupted
 * by a restart is closed out at the next boot rather than sitting here for ever, which is what six
 * of eight rows were doing when this was measured.
 */
const BROADCAST_STATUS: Record<string, string> = {
  sending: 'Sending…', completed: 'Delivered', partial: 'Partly delivered', failed: 'Failed',
};
const BROADCAST_PILL: Record<string, string> = {
  sending: 'info', completed: 'ok', partial: 'warn', failed: 'bad',
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
  const { can } = useAuth();
  // Only to build the link to Notification Preferences, which lives in whichever area you are in.
  const { area } = useArea();

  /**
   * Whether the brokerage-wide settings on this screen may be CHANGED, as opposed to read.
   *
   * The tab opens on `settings: view` so that a grant the API already honours has a screen to
   * happen on; every write behind it is `@Screen('settings', 'edit')`. Asking the same question the
   * server asks is what keeps this from becoming the failure the Company Settings audit opened
   * with — a form that enables, a Save button that appears, and a 403 on every attempt.
   *
   * Personal Information is deliberately NOT gated on this. It writes one row — `users` WHERE id =
   * the caller — its endpoint asks only for `view`, and taking it away would stop an Admin editing
   * their own phone number, which is nobody's idea of a settings permission.
   */
  const canEdit = can('settings', 'edit');

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
  // Every section here has its own Save button, so an edit in one is easy to walk away from.
  const [dirty, setDirty] = useState(false);
  useUnsavedGuard(dirty);
  // For the one control on this screen that stops every CRM email for the whole brokerage.
  const { confirm, askDelete, closeConfirm } = useConfirm();

  /**
   * Only the first fetch shows a loading state; later refreshes swap the panels in place so the
   * whole settings screen does not disappear behind "Loading CRM settings…" after every save.
   */
  const loadedOnce = useRef(false);

  /**
   * What "Allow CRM emails" was when the screen last agreed with the server.
   *
   * The confirmation below fires on the TRANSITION to off, not on the state. Without this, a
   * brokerage that already has CRM email switched off would be asked to confirm it again on every
   * unrelated save in this card — and a confirmation people see when nothing is happening is one
   * they learn to click through.
   */
  const loadedEmailSending = useRef(true);

  const load = useCallback(async () => {
    if (!loadedOnce.current) setLoading(true);
    try {
      const [s, p, e, i, c, b, l, o] = await Promise.all([
        getCrmSettings(), getCrmProfile(), getCrmEmailSettings(), crmIntegrations(),
        listReferralCodes(), listCrmBroadcasts(), listCrmEmailLog(25), crmOptions(),
      ]);
      setSettings(s); setProfile(p); setEmailSettings(e); setIntegrations(i);
      loadedEmailSending.current = e.autoSendEnabled;
      setCodes(c); setBroadcasts(b); setLog(l); setSeasons(o.seasons);
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not load CRM settings'), 'bad');
    } finally {
      loadedOnce.current = true;
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  /**
   * Wraps a setter so touching any field marks the form dirty. The leave-warning reads this, and
   * `run` clears it the moment a save succeeds — a section that has been saved is not unsaved work.
   */
  const markDirty = <T,>(setter: (v: T) => void) => (v: T) => { setDirty(true); setter(v); };

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    setErrors({});
    try {
      await fn();
      setDirty(false);
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

  /**
   * Save the Email Campaigns card — asking first when the save switches CRM email OFF entirely.
   *
   * "Allow CRM emails" is the brokerage kill switch: with it off, nothing sends for anybody, and the
   * send screen simply refuses without explaining itself. The Triggers screen already confirms
   * before somebody switches off all of their OWN emails, and the broadcast form confirms before
   * emailing everyone — this control has a wider blast radius than either and asked nothing.
   *
   * The question is asked only on the transition to off. Turning it back on, or any other edit in
   * this card, saves without ceremony: a confirmation on every save is one people learn to dismiss.
   */
  const persistEmailCampaigns = () => run(
    'emailSettings',
    async () => {
      const saved = await saveCrmEmailSettings({ ...emailSettings });
      setEmailSettings(saved);
      loadedEmailSending.current = saved.autoSendEnabled;
    },
    'Settings updated successfully',
  );

  const saveEmailCampaigns = () => {
    const switchingOff = !emailSettings.autoSendEnabled && loadedEmailSending.current;
    if (!switchingOff) { void persistEmailCampaigns(); return; }
    askDelete({
      title: 'Switch off CRM email for the whole brokerage?',
      message: 'No CRM email will send for anybody — not yours, not any colleague’s — whatever their own trigger settings say. The send screen will refuse without explaining why.',
      note: 'You can turn it back on here at any time.',
      onConfirm: () => { closeConfirm(); void persistEmailCampaigns(); },
    });
  };


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
        {!canEdit && (
          <p className="help">
            <strong>Read-only.</strong> You can see the brokerage's CRM settings but not change
            them — that needs the Settings permission at <em>Edit</em>, which an administrator grants
            under Settings → Roles &amp; Permissions. Your own personal information below is still
            yours to change.
          </p>
        )}
        {integrations?.mail_redirect.active && (
          <div className="reminder-warn" style={{ marginTop: 8 }}>
            <strong>Outgoing email is being diverted.</strong> {integrations.mail_redirect.detail}
          </div>
        )}
      </div>

      {/* ---------------------------------------------------- personal info */}
      <div className="card">
        <h3 className="modal-h">Personal Information</h3>
        <div className="g2">
          <div className="field">
            <label htmlFor="crm-name">Full Name *</label>
            <input id="crm-name" maxLength={255} value={profile.name} onChange={(e) => markDirty(setProfile)({ ...profile, name: e.target.value })} />
            {err('name')}
          </div>
          <div className="field">
            <label htmlFor="crm-username">Username *</label>
            <input id="crm-username" maxLength={255} value={profile.username} onChange={(e) => markDirty(setProfile)({ ...profile, username: e.target.value })} />
            {err('username')}
          </div>
          <div className="field">
            <label htmlFor="crm-phone">Phone Number</label>
            <input id="crm-phone" maxLength={64} value={profile.phone} onChange={(e) => markDirty(setProfile)({ ...profile, phone: e.target.value })} />
            {err('phone')}
          </div>
          <div className="field">
            <label htmlFor="crm-email">Email Address</label>
            <input id="crm-email" type="email" maxLength={255} value={profile.email} onChange={(e) => markDirty(setProfile)({ ...profile, email: e.target.value })} />
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

      {/*
        ------------------------------------------------------------ broadcast

        "Notification Settings" used to sit here: six switches — Email Alerts, SMS Alerts, Lead
        Notifications, Showing Reminders, Market Updates, Document Alerts — that were saved,
        acknowledged with "Notification settings updated successfully", and READ BY NOTHING. A
        repository-wide search for a consumer of `crm_settings.notifications` returns this file and
        no other. Switching "Email Alerts" off changed nothing at all.

        They are gone rather than relabelled, because a working notification screen already exists
        two menu items away — Settings → Notification Preferences — and the harm was not the wasted
        pixels. It was that somebody muted an alert here, kept receiving it, and had no reason to
        look for the real screen. The stored values are untouched and still round-trip through the
        API; nothing reads them, and they can be dropped with a migration.

        The broadcast form stayed and now has this card to itself, which is what it always was:
        an action, not a preference.
      */}
      <div className="card">
        <h3 className="modal-h">Broadcast Message</h3>
        <p className="help" style={{ marginTop: 0 }}>
          Emails every active member of staff. There is no undo — once it is sent it is in
          everyone's inbox.
        </p>
        <p className="help">
          Looking for which alerts reach <em>you</em>? That is
          {' '}<Link to={areaPath(area, 'notifications')}>Settings → Notification Preferences</Link>,
          which is per-person and does not live here.
        </p>
        {canEdit && (
          <BroadcastForm onSent={async () => { setBroadcasts(await listCrmBroadcasts()); }} />
        )}
        {broadcasts.length > 0 && (
          <ul className="crm-feed">
            {broadcasts.slice(0, 5).map((b) => (
              <li key={b.id}>
                <div>{b.message}</div>
                <div className="muted">
                  {stamp(b.created_at)} · {b.recipients} of {b.attempted} delivered
                  {b.failed > 0 && ` · ${b.failed} failed`} · {b.sent_by ?? '—'}
                  {' '}<span className={`pill ${BROADCAST_PILL[b.status] ?? ''}`}>{BROADCAST_STATUS[b.status] ?? b.status}</span>
                </div>
                {b.error && <div className="muted" style={{ fontSize: 11 }}>{b.error}</div>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* --------------------------------------------- user email preferences */}
      <div className="card">
        <h3 className="modal-h">Email Preferences</h3>
        <div className="field">
          <label htmlFor="crm-signature">Signature</label>
          <textarea id="crm-signature" rows={3} maxLength={5000} value={settings.emailSettings.signature} disabled={!canEdit}
            onChange={(e) => markDirty(setSettings)({ ...settings, emailSettings: { ...settings.emailSettings, signature: e.target.value } })} />
          <span className="help">
            The brokerage-wide default, appended to CRM emails when the sender has not set their
            own. Your personal signature lives on your own Settings page.
          </span>
          {err('signature')}
        </div>
        <div className="field">
          <label htmlFor="crm-reply-template">Reply Template</label>
          <textarea id="crm-reply-template" rows={3} maxLength={5000} value={settings.emailSettings.replyTemplate} disabled={!canEdit}
            onChange={(e) => markDirty(setSettings)({ ...settings, emailSettings: { ...settings.emailSettings, replyTemplate: e.target.value } })} />
          {err('replyTemplate')}
        </div>
        {/*
          "Auto-responder" and "Forwarding Address" were here and are gone. Both were validated,
          length-capped, stored — and read by nothing: there is no IMAP auto-reply and no forwarding
          rule anywhere in the codebase. A forwarding address in particular is the kind of setting
          somebody configures once, believes, and relies on; leaving it visible was a promise that
          a colleague's mail would reach them.

          The signature above is the one field in this card that has an effect, and it is the reason
          the card is still here.
        */}
        {canEdit && (
          <div className="actions">
            <button className="btn primary" type="button" disabled={busy !== ''}
              onClick={() => void run('emailPrefs', () => saveCrmSettings({ emailSettings: settings.emailSettings }), 'Email preferences saved successfully')}>
              {busy === 'emailPrefs' ? 'Saving…' : 'Save Email Preferences'}
            </button>
          </div>
        )}
      </div>

      {/*
        ------------------------------------------------------------ preferences

        "Preferences" used to sit here: Language, Time Zone, Currency, Date Format and Theme. All
        five saved, all five reported "Preferences saved", and all five were read by NOTHING. Theme
        was the demonstrable one — saved as `dark`, page stayed light, no `data-theme` attribute, no
        stylesheet consulting it. No date anywhere is formatted from `dateFormat`, no figure from
        `currency`, no timestamp from `timeZone`, and there is no translation layer for `language`.

        Removed rather than left inert. Implementing them is real work in every module that displays
        a date or an amount, and it is not made closer by a form that pretends it is already done —
        somebody who sets the time zone and then reads a showing time off the calendar is being
        actively misled. The stored values are untouched; when the display layer exists, the card
        comes back.

        The currency that actually prints on an invoice is Company Settings → Invoicing Defaults,
        and that one is now allow-listed.
      */}

      {/* --------------------------------------------------- email campaigns */}
      <div className="card">
        <h3 className="modal-h">Email Campaigns</h3>
        <p className="help">
          The CRM's own SMTP details and automatic-email switches. Transaction Desk sends through
          the Mail Accounts configured above; these values are kept for reference and to gate the
          triggers below.
        </p>
        <div className="g2">
          <div className="field">
            <label htmlFor="crm-smtp-host">SMTP Host</label>
            <input id="crm-smtp-host" value={emailSettings.smtpHost} disabled={!canEdit} maxLength={255}
              onChange={(e) => markDirty(setEmailSettings)({ ...emailSettings, smtpHost: e.target.value })} />
            {err('smtpHost')}
          </div>
          <div className="field">
            <label htmlFor="crm-smtp-port">SMTP Port</label>
            <input id="crm-smtp-port" value={emailSettings.smtpPort} disabled={!canEdit} maxLength={5}
              onChange={(e) => markDirty(setEmailSettings)({ ...emailSettings, smtpPort: e.target.value })} />
            {err('smtpPort')}
          </div>
          <div className="field">
            <label htmlFor="crm-smtp-user">SMTP User</label>
            <input id="crm-smtp-user" value={emailSettings.smtpUser} disabled={!canEdit} maxLength={255}
              onChange={(e) => markDirty(setEmailSettings)({ ...emailSettings, smtpUser: e.target.value })} />
            {err('smtpUser')}
          </div>
          <div className="field">
            <label htmlFor="crm-admin-email">Admin Email</label>
            <input id="crm-admin-email" type="email" value={emailSettings.adminEmail} disabled={!canEdit} maxLength={255}
              onChange={(e) => markDirty(setEmailSettings)({ ...emailSettings, adminEmail: e.target.value })} />
            {err('adminEmail')}
          </div>
        </div>
        {/*
          This switch is now enforced. It was not: `CrmAdvancedEmailService.autoSendEnabled()` had
          no caller at all, so turning it off changed nothing and a send went straight through — the
          2026-08-04 audit measured exactly that. `dispatch()` consults it before anything else now,
          which is what this label has always claimed.
        */}
        <Toggle label="Allow CRM emails" hint="Master switch — turn off to block every send below"
          checked={emailSettings.autoSendEnabled} disabled={!canEdit}
          onChange={(v) => markDirty(setEmailSettings)({ ...emailSettings, autoSendEnabled: v })} />

        <h4 className="modal-sub">Email Triggers</h4>
        <p className="help" style={{ marginTop: 0 }}>
          Each switch decides whether that email may be sent from “Send a CRM Email” below.
          <strong> Nothing here sends on a schedule</strong> — every CRM email is sent by hand.
        </p>
        <div className="g3">
          {emailSettings.trigger_keys.map((key) => (
            <Toggle key={key} label={TRIGGER_LABELS[key] ?? title(key)}
              checked={emailSettings.emailTemplates[key] !== false}
              disabled={!canEdit || !emailSettings.autoSendEnabled}
              onChange={(v) => markDirty(setEmailSettings)({ ...emailSettings, emailTemplates: { ...emailSettings.emailTemplates, [key]: v } })} />
          ))}
        </div>
        {canEdit && (
          <div className="actions">
            <button className="btn primary" type="button" disabled={busy !== ''}
              onClick={() => saveEmailCampaigns()}>
              {busy === 'emailSettings' ? 'Saving…' : 'Save Email Campaign Settings'}
            </button>
          </div>
        )}
      </div>

      {/* Trigger templates moved to the Triggers screen (Triggers -> CRM Triggers), where an
          automation is actually looked for. Same data, same endpoint — only the location moved. */}

      {/* -------------------------------------------------- send an email */}
      {/* Both the send and the code generator are POSTs behind `@Screen('settings','edit')`, so a
          read-only viewer is not offered a form whose every submission would come back 403. */}
      {canEdit && (
        <SendEmailCard
          seasons={seasons}
          onSent={async () => { setLog(await listCrmEmailLog(25)); }}
        />
      )}

      {/* ------------------------------------------------------ referral codes */}
      <div className="card">
        <h3 className="modal-h">Referral Codes</h3>
        {canEdit && <ReferralGenerator onGenerated={async () => setCodes(await listReferralCodes())} />}
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
        <h3 className="modal-h">Integrations</h3>
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
        <h3 className="modal-h">CRM Email Log</h3>
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

      <ConfirmDialog confirm={confirm} onClose={closeConfirm} />
    </>
  );
}

function BroadcastForm({ onSent }: { onSent: () => Promise<void> }) {
  const toast = useToast();
  const [message, setMessage] = useState('');
  const [type, setType] = useState('info');
  const [busy, setBusy] = useState(false);
  const { confirm, askDelete, closeConfirm } = useConfirm();

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

  /*
   * ASKED FOR, NOT JUST CLICKED. One press of this button emails every active member of staff, and
   * there is no undo — a typo, a wrong audience or a message meant for one office is in everybody's
   * inbox by the time it is noticed. Every other irreversible action in the application confirms
   * first; this one is more far-reaching than most of them and did not.
   *
   * The server also refuses an identical repeat within a minute, which covers the double submit a
   * dialog cannot — a retry, a second tab, an impatient reload.
   */
  const ask = () => {
    const preview = message.trim();
    askDelete({
      title: 'Email everyone?',
      message: `This sends the message below to every active member of staff, immediately. It cannot be recalled.`,
      body: (
        <div style={{ background: 'var(--warn-bg)', border: '1px solid #fed7aa', borderRadius: 8, padding: '10px 12px', fontSize: 12.5, marginTop: 8, whiteSpace: 'pre-wrap' }}>
          {preview.length > 400 ? `${preview.slice(0, 400)}…` : preview}
        </div>
      ),
      note: 'Everyone with an active account and an email address will receive it.',
      confirmLabel: 'Send',
      onConfirm: () => { closeConfirm(); void send(); },
    });
  };

  return (
    <>
      <div className="field">
        <label htmlFor="crm-broadcast">Message</label>
        <textarea id="crm-broadcast" rows={3} maxLength={5000} value={message} placeholder="Enter your message here…"
          onChange={(e) => setMessage(e.target.value)} />
        <span className="help">
          Emailed to every active user, one message each — nobody sees anyone else's address.
          Delivery runs in the background and the list below shows how far it has reached.
        </span>
      </div>
      <div className="toolbar-row">
        <label htmlFor="crm-broadcast-type">Type</label>
        <select id="crm-broadcast-type" value={type} onChange={(e) => setType(e.target.value)}>
          {['info', 'warning', 'success'].map((t) => <option key={t} value={t}>{title(t)}</option>)}
        </select>
        <button className="btn primary" type="button" disabled={busy || !message.trim()} onClick={ask}>
          {busy ? 'Sending…' : 'Send to All Users'}
        </button>
      </div>
      <ConfirmDialog confirm={confirm} onClose={closeConfirm} />
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
        <label htmlFor="crm-discount">Discount %</label>
        <input id="crm-discount" type="number" min={1} max={100} value={form.discount} onChange={(e) => setForm({ ...form, discount: e.target.value })} />
      </div>
      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor="crm-valid-days">Valid days</label>
        <input id="crm-valid-days" type="number" min={1} value={form.validDays} onChange={(e) => setForm({ ...form, validDays: e.target.value })} />
      </div>
      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor="crm-max-uses">Max uses</label>
        <input id="crm-max-uses" type="number" min={1} value={form.maxUsage} onChange={(e) => setForm({ ...form, maxUsage: e.target.value })} />
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

/** Just enough of a lead to offer it as a recipient. */
interface LeadOption { id: number; name: string; email: string }

/** The CRM's advanced-email actions: wedding, seasonal, promotional, referral and custom. */
function SendEmailCard({ seasons, onSent }: { seasons: string[]; onSent: () => Promise<void> }) {
  const toast = useToast();
  const [kind, setKind] = useState('wedding');
  const [busy, setBusy] = useState(false);
  const [leadMatches, setLeadMatches] = useState<LeadOption[]>([]);
  const [searchingLeads, setSearchingLeads] = useState(false);
  const [form, setForm] = useState({
    leadName: '', leadEmail: '', weddingDate: '',
    season: seasons[0] ?? 'Holiday Season', year: String(new Date().getFullYear()),
    offerTitle: '', offerDescription: '', offerDiscount: '', offerValidUntil: '', offerCode: '',
    referralCode: '', referralDiscount: '10', referralMaxUsage: '5', referralValidUntil: '',
    subject: '', content: '',
  });
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  /*
   * Searched on the server, not filtered from a preloaded list.
   *
   * A brokerage has tens of thousands of leads; shipping them all to the browser to type-ahead
   * against would be the wrong trade in every direction. `listLeads` already applies the same
   * ownership rule the send does, so the list offered here is exactly the set the send will accept
   * — the picker cannot suggest an address that would then be refused.
   *
   * Debounced, because this fires on every keystroke, and skipped below two characters where the
   * result would be a page of arbitrary leads rather than an answer.
   */
  useEffect(() => {
    const q = form.leadEmail.trim();
    if (q.length < 2) { setLeadMatches([]); return undefined; }
    let cancelled = false;
    setSearchingLeads(true);
    const t = setTimeout(() => {
      listLeads({ search: q }, 1, 20)
        .then((r) => {
          if (cancelled) return;
          setLeadMatches(r.data
            .filter((l) => !!l.email)
            .map((l) => ({ id: l.id, name: l.name, email: l.email })));
        })
        .catch(() => { if (!cancelled) setLeadMatches([]); })
        .finally(() => { if (!cancelled) setSearchingLeads(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); setSearchingLeads(false); };
  }, [form.leadEmail]);

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
      <h3 className="modal-h">Send a CRM Email</h3>
      <p className="help">
        Sends immediately to the address below, using the matching trigger — a disabled trigger
        refuses the send. Every attempt is recorded in the log at the bottom of this page.
      </p>
      <div className="g3">
        <div className="field">
          <label htmlFor="crm-type">Type</label>
          <select id="crm-type" value={kind} onChange={(e) => setKind(e.target.value)}>
            {Object.keys(actionFor).map((k) => <option key={k} value={k}>{title(k)}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="crm-recipient-name">Recipient Name</label>
          <input id="crm-recipient-name" value={form.leadName} onChange={(e) => set('leadName', e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="crm-recipient-email">Recipient Email *</label>
          {/*
            A PICKER, BECAUSE ONLY A LEAD CAN RECEIVE THIS. The server refuses any address that is
            not a lead in the CRM — that is what stops this endpoint being a mail relay — and the
            box used to be free text, so the only way to find an acceptable address was to type one
            and read the refusal. Typing still works for anyone who knows the address; the list is
            there so nobody has to guess.
          */}
          <AutoComplete<LeadOption>
            id="crm-recipient-email"
            value={form.leadEmail}
            onChange={(v) => set('leadEmail', v)}
            onPick={(lead) => { set('leadEmail', lead.email); if (lead.name) set('leadName', lead.name); }}
            options={leadMatches}
            getLabel={(l) => l.email}
            getSub={(l) => l.name}
            type="email"
            placeholder="Start typing a name or address…"
          />
          <span className="help">
            {searchingLeads ? 'Searching leads…' : 'Only people already in the CRM can be emailed from here.'}
          </span>
        </div>
      </div>

      {kind === 'wedding' && (
        <div className="field">
          <label htmlFor="crm-wedding-date">Wedding Date</label>
          <input id="crm-wedding-date" type="date" value={form.weddingDate} onChange={(e) => set('weddingDate', e.target.value)} />
        </div>
      )}

      {kind === 'seasonal' && (
        <div className="g2">
          <div className="field">
            <label htmlFor="crm-season">Season</label>
            <select id="crm-season" value={form.season} onChange={(e) => set('season', e.target.value)}>
              {seasons.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="crm-year">Year</label>
            <input id="crm-year" value={form.year} onChange={(e) => set('year', e.target.value)} />
          </div>
        </div>
      )}

      {kind === 'promotional' && (
        <>
          <div className="g2">
            <div className="field">
              <label htmlFor="crm-offer-title">Offer Title</label>
              <input id="crm-offer-title" value={form.offerTitle} onChange={(e) => set('offerTitle', e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="crm-discount-2">Discount</label>
              <input id="crm-discount-2" value={form.offerDiscount} onChange={(e) => set('offerDiscount', e.target.value)} placeholder="e.g. 10%" />
            </div>
            <div className="field">
              <label htmlFor="crm-offer-code">Offer Code</label>
              <input id="crm-offer-code" value={form.offerCode} onChange={(e) => set('offerCode', e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="crm-valid-until">Valid Until</label>
              <input id="crm-valid-until" type="date" value={form.offerValidUntil} onChange={(e) => set('offerValidUntil', e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="crm-description">Description</label>
            <textarea id="crm-description" rows={2} value={form.offerDescription} onChange={(e) => set('offerDescription', e.target.value)} />
          </div>
        </>
      )}

      {kind === 'referral' && (
        <div className="g2">
          <div className="field">
            <label htmlFor="crm-referral-code">Referral Code *</label>
            <input id="crm-referral-code" value={form.referralCode} onChange={(e) => set('referralCode', e.target.value)} placeholder="Generate one below, or type it" />
          </div>
          <div className="field">
            <label htmlFor="crm-discount-3">Discount %</label>
            <input id="crm-discount-3" type="number" value={form.referralDiscount} onChange={(e) => set('referralDiscount', e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="crm-max-uses-2">Max Uses</label>
            <input id="crm-max-uses-2" type="number" value={form.referralMaxUsage} onChange={(e) => set('referralMaxUsage', e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="crm-valid-until-2">Valid Until</label>
            <input id="crm-valid-until-2" type="date" value={form.referralValidUntil} onChange={(e) => set('referralValidUntil', e.target.value)} />
          </div>
        </div>
      )}

      {kind === 'custom' && (
        <>
          <div className="field">
            <label htmlFor="crm-subject">Subject *</label>
            <input id="crm-subject" value={form.subject} onChange={(e) => set('subject', e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="crm-message-html">Message (HTML) *</label>
            <textarea id="crm-message-html" rows={5} className="tpl-code" value={form.content} onChange={(e) => set('content', e.target.value)} />
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
