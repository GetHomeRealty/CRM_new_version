import { AREA_LABEL, crmPath, deskPath } from './area';
import { useCallback, useEffect, useState } from 'react';
import {
  listMyMailAccounts, setMyDefaultMailAccount, deleteMyMailAccount, testMyMailAccount,
  syncMailAccount, mailAccountLimit,
  type AccountMailAccount, type EmailAccountLimit, type IntegrationScope,
} from '../lib/accountApi';
import { apiErrorMessage } from '../lib/apiError';
import { useToast } from './toast';
import MailAccountModal from './MailAccountModal';

/**
 * Email Integration card for CRM Settings → Integrations — the same shape as the Google Calendar
 * card. Shows the signed-in user's own sending accounts and connects a new one (Gmail or SMTP)
 * through the shared MailAccountModal wizard. Everything is scoped to this login by the server.
 */
/**
 * Personal mail is connected once for the whole Hub. `scope` only records which page initiated
 * OAuth so the browser can return there; both areas list and operate on the same account.
 */
export default function EmailIntegrationCard({ scope = 'crm' }: { scope?: IntegrationScope }) {
  const toast = useToast();
  const [accounts, setAccounts] = useState<AccountMailAccount[] | null>(null);
  const [editing, setEditing] = useState<AccountMailAccount | 'new' | null>(null);
  const [busy, setBusy] = useState<number | ''>('');
  /**
   * The per-area allowance, read from the server. Null while it is still loading — the Add button
   * stays enabled in that moment rather than flickering to "limit reached", because the POST
   * enforces the rule anyway and a button that briefly lies is worse than one that is briefly
   * optimistic.
   */
  const [limit, setLimit] = useState<EmailAccountLimit | null>(null);

  const load = useCallback(() => {
    listMyMailAccounts().then(setAccounts).catch(() => setAccounts([]));
    mailAccountLimit(scope).then(setLimit).catch(() => setLimit(null));
  }, [scope]);
  useEffect(() => { load(); }, [load]);

  // Surface the outcome of a Gmail OAuth connect that returned to this page, then clean the URL.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('mail_connected')) toast('Email account connected.', 'ok');
    else if (p.get('mail_error')) toast(`Could not connect the email account: ${p.get('mail_error')}`, 'bad');
    if (p.get('mail_connected') || p.get('mail_error')) {
      // Back to the area the connect was started from — not always Transaction Desk.
      window.history.replaceState({}, '', scope === 'desk' ? `${deskPath('settings')}?tab=desk&section=integrations` : `${crmPath('settings')}?tab=crm`);
      load();
    }
  }, [toast, load, scope]);

  const act = async (id: number, fn: () => Promise<unknown>, ok: string) => {
    setBusy(id);
    try { await fn(); toast(ok, 'ok'); load(); }
    catch (ex) { toast(apiErrorMessage(ex, 'That did not work'), 'bad'); }
    finally { setBusy(''); }
  };

  const active = (accounts ?? []).filter((a) => a.is_active);
  const def = (accounts ?? []).find((a) => a.is_default);
  const connected = active.length > 0;
  const atLimit = limit ? !limit.canAdd : false;
  const subtitle = !accounts ? 'Checking…'
    : connected
      // "Primary" rather than "default": it is the account this area sends from, and section 6
      // asks for it to be named clearly. Saying nothing is set is worth doing loudly — that is
      // exactly the state where mail quietly leaves from the brokerage address instead.
      ? `${active.length} Hub account${active.length === 1 ? '' : 's'} connected${def ? ` · primary ${def.from_email}` : ' · no primary set'}`
      : 'Connect your own email to send and receive from your address — Gmail or any SMTP. Until then, mail goes out through the brokerage account.';

  return (
    <div className="intg-card">
      <div className="intg-card-head">
        <div className="intg-card-icon"><span style={{ fontSize: 20 }}>✉️</span></div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="intg-card-title">Mail Configuration</div>
          <div className="muted" style={{ fontSize: 12.5 }}>{subtitle}</div>
        </div>
        <span className={`pill ${connected ? 'ok' : ''}`} style={{ flex: 'none' }}>
          {!accounts ? 'Checking…' : connected ? 'Connected' : 'Not connected'}
        </span>
      </div>

      {accounts && accounts.length > 0 && (
        <ul className="acct-list" style={{ marginTop: 10 }}>
          {accounts.map((a) => (
            <li key={a.id}>
              <div className="acct-info">
                <div>
                  <strong>{a.from_email}</strong>
                  {a.is_default && <span className="pill ok" style={{ marginLeft: 6 }} title={`Mail for ${AREA_LABEL[scope]} is sent from this address by default`}>Primary</span>}
                  {!a.is_active && <span className="pill bad" style={{ marginLeft: 6 }}>Inactive</span>}
                </div>
                <div className="muted">
                  {a.host}:{a.port}
                  {a.imap_host ? ` · 📥 inbox ${a.inbound_enabled ? 'on' : 'off'}` : ' · 📥 inbox not set up'}
                  {a.last_synced_at && ` · last synced ${a.last_synced_at.slice(0, 16).replace('T', ' ')}`}
                  {a.sync_error && <span className="pill bad" title={a.sync_error} style={{ marginLeft: 6 }}>Sync error</span>}
                </div>
              </div>
              <div className="acct-actions">
                {a.imap_host && a.inbound_enabled && (
                  <button className="btn ghost sm" type="button" disabled={busy === a.id}
                    onClick={() => void act(a.id, () => syncMailAccount(scope, a.id).then((r) => toast(r.message, r.error ? 'bad' : 'ok')), 'Sync finished.')}>↻ Sync</button>
                )}
                {!a.is_default && (
                  <button className="btn ghost sm" type="button" disabled={busy === a.id}
                    onClick={() => void act(a.id, () => setMyDefaultMailAccount(a.id), 'Set as the primary account for this area.')}
                    title={`Send ${AREA_LABEL[scope]} mail from this address`}>Make primary</button>
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

      <div className="intg-card-actions" style={{ flexWrap: 'wrap', gap: 8 }}>
        {/* Disabled AND explained. Section 7 is explicit that hiding the button is not the
            control — the server refuses the request regardless — so this exists to say why
            rather than to enforce anything. */}
        <button className="btn primary sm" type="button" disabled={atLimit}
          onClick={() => setEditing('new')}>+ Connect email account</button>
        {atLimit && (
          <span className="help" style={{ flex: '1 1 100%' }}>
            Your role allows one Hub email account shared by CRM and Transactions. Disconnect the
            account above to connect a different address.
          </span>
        )}
      </div>

      {editing && (
        <MailAccountModal
          account={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          scope={scope}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}
