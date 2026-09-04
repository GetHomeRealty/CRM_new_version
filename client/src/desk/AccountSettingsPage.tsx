import { useArea } from './AreaContext';
import { crmPath, AREA_LABEL, AREA_SHORT, type Area } from './area';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  deleteMyMailAccount, getAccountProfile, getAccountSettings, listMyMailAccounts,
  saveAccountProfile, setMyDefaultMailAccount, syncMailAccount, testMyMailAccount,
  type AccountIntegrations, type AccountMailAccount,
} from '../lib/accountApi';
import { getMyPhoto, uploadMyPhoto, deleteMyPhoto } from '../lib/api';
import { fileToBase64 } from '../lib/importApi';
import { apiErrorMessage, apiFieldErrors } from '../lib/apiError';
import { useAuth } from '../context/AuthContext';
import { useToast } from './toast';
import MailAccountModal from './MailAccountModal';
import UserAvatar, { bumpPhotoVersion } from './UserAvatar';
import GoogleCalendarCard from './GoogleCalendarCard';

const PHOTO_ACCEPT = '.png,.jpg,.jpeg,.gif,.webp';
const PHOTO_MAX_MB = 4;

/**
 * A user's own Settings, the same for everyone. Everything here is scoped to the signed-in user
 * by the server — their profile, their mail accounts, their signature — so nobody manages anyone
 * else's account from this screen.
 */
export default function AccountSettingsPage() {
  const { area, link } = useArea();
  const toast = useToast();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [hasPhoto, setHasPhoto] = useState(false);
  const [photoBusy, setPhotoBusy] = useState('');
  const [photoV, setPhotoV] = useState<number>(0);
  const photoInput = useRef<HTMLInputElement>(null);

  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [phone, setPhone] = useState('');
  const [profileErrs, setProfileErrs] = useState<Record<string, string[]>>({});
  const [savingProfile, setSavingProfile] = useState(false);

  const [accounts, setAccounts] = useState<AccountMailAccount[]>([]);
  const [integrations, setIntegrations] = useState<AccountIntegrations | null>(null);
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
    const [p, s, a, ph] = await Promise.allSettled([
      // Scoped to the area whose Settings you are on.
      //
      // This asked for every account the user had, so the Transaction Desk's Settings listed the
      // CRM's mailboxes alongside its own and the CRM's listed the Desk's. The two areas are
      // meant to be separate — the server has always taken a scope for exactly this, and the
      // Integrations card next door already passes one. Only this screen did not.
      getAccountProfile(), getAccountSettings(), listMyMailAccounts(), getMyPhoto(),
    ]);

    if (p.status === 'fulfilled') { setName(p.value.name); setUsername(p.value.username); setPhone(p.value.phone); }
    // A failed photo read is not worth a warning — the avatar just shows the initial.
    if (ph.status === 'fulfilled') { setHasPhoto(ph.value.has_photo); setPhotoV(ph.value.photo_version ?? 0); }
    // `getAccountSettings` is still needed here — the Integration card below reads `integrations`.
    if (s.status === 'fulfilled') setIntegrations(s.value.integrations);
    if (a.status === 'fulfilled') setAccounts(a.value);

    const failed = [
      p.status === 'rejected' && 'your profile',
      s.status === 'rejected' && 'your preferences',
      a.status === 'rejected' && 'your email accounts',
    ].filter(Boolean);
    setLoadWarning(failed.length ? `Could not load ${failed.join(' or ')}. Your other settings are shown; try Refresh.` : '');

    loadedOnce.current = true;
    setLoading(false);
    // `area` is a dependency: moving between CRM Settings and Transaction Desk Settings has to
    // refetch, or the previous area's mailboxes would stay on screen.
  }, [area]);

  useEffect(() => { void load(); }, [load]);

  const pickPhoto = async (file: File | null) => {
    if (!file) return;
    if (file.size > PHOTO_MAX_MB * 1024 * 1024) {
      toast(`That image is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is ${PHOTO_MAX_MB} MB.`, 'bad');
      return;
    }
    setPhotoBusy('upload');
    try {
      const info = await uploadMyPhoto(file.name, await fileToBase64(file));
      setHasPhoto(info.has_photo);
      setPhotoV(info.photo_version ?? bumpPhotoVersion());
      bumpPhotoVersion();
      toast('Profile picture updated', 'ok');
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not upload the picture'), 'bad');
    } finally {
      setPhotoBusy('');
      if (photoInput.current) photoInput.current.value = '';
    }
  };

  const removePhoto = async () => {
    setPhotoBusy('remove');
    try {
      const info = await deleteMyPhoto();
      setHasPhoto(info.has_photo);
      setPhotoV(info.photo_version ?? bumpPhotoVersion());
      bumpPhotoVersion();
      toast('Profile picture removed', 'ok');
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not remove the picture'), 'bad');
    } finally { setPhotoBusy(''); }
  };

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
    window.history.replaceState({}, '', link('account'));
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

      {/*
        * Two-step verification used to sit here, above Profile Picture. It moved to CRM → Settings
        * → Two-Step Verification, which is now the only place it is configured. Nothing about the
        * factors themselves changed — same card, same endpoints, same enrolled methods — only where
        * it is listed. The `two-step` route is its open door for anyone without `settings`.
        */}

      {/* ---- Profile Picture ---- */}
      <div className="card">
        <div className="modal-sub">Profile Picture</div>
        <p className="help" style={{ marginTop: 0 }}>
          Shown beside your name across the app. Yours to set — every account has one,
          whatever your role.
        </p>
        <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
          <UserAvatar userId={user?.id ?? null} name={name || user?.name} size={112} version={photoV} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <input ref={photoInput} type="file" accept={PHOTO_ACCEPT} style={{ display: 'none' }}
              onChange={(e) => void pickPhoto(e.target.files?.[0] ?? null)} />
            <button className="btn primary sm" type="button" disabled={!!photoBusy} onClick={() => photoInput.current?.click()}>
              {photoBusy === 'upload' ? 'Uploading…' : hasPhoto ? '⭱ Replace Picture' : '⭱ Upload Picture'}
            </button>
            {hasPhoto && (
              <button className="btn ghost sm" type="button" disabled={!!photoBusy} onClick={() => void removePhoto()}>
                {photoBusy === 'remove' ? 'Removing…' : '🗑 Remove Picture'}
              </button>
            )}
            <span className="help" style={{ maxWidth: 280 }}>
              PNG, JPG, GIF or WEBP · up to {PHOTO_MAX_MB} MB. A square, head-and-shoulders
              crop looks best — the picture is displayed as a circle.
            </span>
          </div>
        </div>
      </div>

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

      {/* ---- Notification Preferences ----
          A link rather than the controls themselves. Agents do not see the admin Settings group
          in the sidebar, where this otherwise lives, so without an entry here the screen would be
          reachable only by typing the URL. */}
      <div className="card">
        <div className="modal-sub">Notifications</div>
        <div className="acct-head">
          <div>
            <strong>Notification Preferences</strong>
            <div className="muted">
              Choose which push notifications reach your phone and desktop. Emails and in-app
              notifications are not affected.
            </div>
          </div>
          <button className="btn ghost sm" type="button" onClick={() => navigate(link('notifications'))}>
            Manage
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
        <p className="help">
          The email accounts {AREA_LABEL[area]} sends from. Each area keeps its own — accounts you
          connect here are not used by the other side, and are not listed there.
          Until you add one, your mail goes out through the brokerage account.
        </p>

        {accounts.length === 0 ? (
          <div className="acct-empty">
            <p className="help">No Hub email account connected yet.</p>
            <p className="help">Add your first email account to get started.</p>
          </div>
        ) : (
          <ul className="acct-list">
            {accounts.map((a) => (
              <li key={a.id}>
                <div className="acct-info">
                  <div>
                    <strong>{a.name}</strong>
                    {/* The area, on every row.
                        This list shows the CRM's accounts and the Transaction Desk's together, and
                        each area has its own default — so two rows legitimately read "Default" at
                        once. Without saying which area a row belongs to, that looks like a fault,
                        and pressing "Set default" looked like it did nothing: the list re-sorts
                        defaults to the top, so the row moved, and where the same address is
                        connected to both areas the two rows were indistinguishable. */}
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
                      onClick={() => void act(a.id, () => syncMailAccount(a.scope ?? area, a.id).then((r) => toast(r.message, r.error ? 'bad' : 'ok')), 'Sync finished.')}>
                      ↻ Sync now
                    </button>
                  )}
                  {/* The button turns into its own answer.
                      The state used to be shown as a pill beside the address, far from the control
                      that changed it — and because the list re-sorts defaults to the top, the row
                      moved at the same moment, so the press appeared to do nothing. Swapping the
                      button for the word "Default" in the same slot means the change happens where
                      you are looking. */}
                  {a.is_default ? (
                    <span className="pill ok" style={{ whiteSpace: 'nowrap' }}
                      title={`${AREA_LABEL[(a.scope ?? area) as Area]} mail is sent from this address`}>
                      ★ Default
                    </span>
                  ) : (
                    <button className="btn ghost sm" type="button" disabled={busy === a.id}
                      title={`Send ${AREA_LABEL[(a.scope ?? area) as Area]} mail from this address`}
                      onClick={() => void act(
                        a.id,
                        () => setMyDefaultMailAccount(a.id),
                        `${a.from_email} is now the default for ${AREA_SHORT[(a.scope ?? area) as Area]}.`,
                      )}>
                      Set default
                    </button>
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
          {/*
            ONE CARD — the one belonging to the area this screen is being viewed under.

            This is a single component served at both /crm/account and /desk/account, and it used to
            render BOTH scoped cards regardless. So Settings under the CRM showed a "Transaction
            Management" Google Calendar and Settings under Transaction Management showed a
            "Customer Relationship Management" one — each area offering a connection that belongs to
            the other.

            The two connections remain genuinely separate: `google_connections.scope` still keys
            them, the same column pattern `mail_accounts.scope` uses, and connecting one still does
            not connect the other. What changed is only which of them THIS screen offers. The
            heading is kept and follows the area, because a card that just says "Google Calendar"
            cannot tell you which of the two it manages — that ambiguity is what the headings were
            added for in the first place.
          */}
          <div className="intg-scope">
            <h4 className="intg-scope-title">
              {area === 'crm' ? 'Customer Relationship Management' : 'Transaction Management'}
            </h4>
            <GoogleCalendarCard scope={area === 'crm' ? 'crm' : 'desk'} />
          </div>

          {/*
            Meta Lead Ads is a CRM integration: it feeds lead forms into the Leads module and has
            nothing to do with a transaction. Shown on this screen only from the CRM side, so the
            Transaction Desk does not offer a connection it has no use for.

            Hidden, not removed — the card is unchanged and still here under the CRM, along with the
            connection itself. Nothing is disconnected by this.
          */}
          {area === 'crm' && (
            <div className="intg-row">
              <div>
                <strong>Facebook Meta — Lead Ads</strong>
                <div className="muted">{integrations?.meta.detail ?? 'Link your own Meta account to sync your lead forms.'}</div>
              </div>
              <div className="acct-actions">
                <span className={`pill ${integrations?.meta.connected ? 'ok' : ''}`}>
                  {integrations?.meta.connected ? 'Connected' : 'Not connected'}
                </span>
                <button className="btn ghost sm" type="button" onClick={() => navigate(crmPath('meta'))}>
                  {integrations?.meta.connected ? 'Open' : 'Connect'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Email Preferences used to sit here — removed by request.
          The signature and reply template are unchanged and still edited in CRM Settings →
          Email Preferences, which also carries the auto-responder this card never had. Nothing was
          dropped from the database or the API; this screen simply stopped being a second, thinner
          place to edit the same two fields. */}

      {editing && (
        <MailAccountModal
          account={editing === 'new' ? null : editing}
          // Without this the new account is stored with no area at all, and then appears on
          // neither screen — connected, invisible, and unusable.
          scope={area}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }}
        />
      )}
    </>
  );
}
