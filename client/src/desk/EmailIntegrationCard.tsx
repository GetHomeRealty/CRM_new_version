import { useCallback, useEffect, useState } from 'react';
import {
  listMyMailAccounts, setMyDefaultMailAccount, deleteMyMailAccount, testMyMailAccount,
  syncMailAccount,
  type AccountMailAccount, type IntegrationScope,
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
 * `scope` decides which area's accounts this card manages.
 *
 * CRM Settings and Transaction Desk Settings are completely separate mailboxes of
 * configuration: an address connected here is stamped with this scope and is listed only
 * here. Connecting an account under Transaction Desk never affects CRM, and vice versa —
 * there is no shared state and nothing to assign, so the card simply shows this area's
 * accounts and nothing else.
 */
export default function EmailIntegrationCard({ scope = 'crm' }: { scope?: IntegrationScope }) {
  const toast = useToast();
  const [accounts, setAccounts] = useState<AccountMailAccount[] | null>(null);
  const [editing, setEditing] = useState<AccountMailAccount | 'new' | null>(null);
  const [busy, setBusy] = useState<number | ''>('');

  const load = useCallback(() => { listMyMailAccounts(scope).then(setAccounts).catch(() => setAccounts([])); }, [scope]);
  useEffect(() => { load(); }, [load]);

  // Surface the outcome of a Gmail OAuth connect that returned to this page, then clean the URL.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('mail_connected')) toast('Email account connected.', 'ok');
    else if (p.get('mail_error')) toast(`Could not connect the email account: ${p.get('mail_error')}`, 'bad');
    if (p.get('mail_connected') || p.get('mail_error')) {
      // Back to the area the connect was started from — not always Transaction Desk.
      window.history.replaceState({}, '', scope === 'desk' ? '/app/settings?tab=desk&section=integrations' : '/app/settings?tab=crm');
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
  const subtitle = !accounts ? 'Checking…'
    : connected
      ? `${active.length} account${active.length === 1 ? '' : 's'} connected${def ? ` · default ${def.from_email}` : ' · no default set'}`
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
                  {a.is_default && <span className="pill ok" style={{ marginLeft: 6 }}>Default</span>}
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
                    onClick={() => void act(a.id, () => syncMailAccount(a.id).then((r) => toast(r.message, r.error ? 'bad' : 'ok')), 'Sync finished.')}>↻ Sync</button>
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

      <div className="intg-card-actions">
        <button className="btn primary sm" type="button" onClick={() => setEditing('new')}>+ Connect email account</button>
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
