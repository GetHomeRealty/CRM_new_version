import { crmPath } from './area';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  disconnectMeta, metaAuthUrl, metaDiagnostics, metaForms, metaPages, metaStatus,
  refreshMetaPages, syncMetaLeads, toggleMetaForm, metaSyncHistory, metaWebhookHealth,
} from '../lib/metaApi';
import { apiErrorMessage } from '../lib/apiError';
import { useToast } from './toast';
import { useAuth } from '../context/AuthContext';
import type {
  MetaForm, MetaPage as MetaPageInfo, MetaStatus, MetaSyncRun, MetaWebhookHealth,
} from '../types';

const stamp = (iso: string | null): string => (iso ? iso.replace('T', ' ').slice(0, 16) : '—');

/**
 * Meta connection panel — the same component is embedded in Email Settings → Integrations and
 * on the full Meta screen, so both always agree about connection state.
 *
 * `compact` hides the lead table and history, for the Email Settings embed.
 */
export default function MetaConnectionPanel({ compact = false }: { compact?: boolean }) {
  const toast = useToast();
  const navigate = useNavigate();
  const { can } = useAuth();
  const canEdit = can('meta', 'edit');

  const [status, setStatus] = useState<MetaStatus | null>(null);
  const [pages, setPages] = useState<MetaPageInfo[]>([]);
  const [selectedPage, setSelectedPage] = useState('');
  const [forms, setForms] = useState<MetaForm[]>([]);
  const [history, setHistory] = useState<MetaSyncRun[]>([]);
  const [webhook, setWebhook] = useState<MetaWebhookHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');

  const loadStatus = useCallback(async () => {
    try { setStatus(await metaStatus()); } catch (ex) { toast(apiErrorMessage(ex, 'Could not read Meta status'), 'bad'); }
  }, [toast]);

  useEffect(() => {
    void (async () => {
      await loadStatus();
      try {
        const [h, w] = await Promise.all([metaSyncHistory(5), metaWebhookHealth(5)]);
        setHistory(h); setWebhook(w);
      } catch { /* history is supplementary */ }
      setLoading(false);
    })();
  }, [loadStatus]);

  useEffect(() => {
    if (!status?.is_connected) { setPages([]); return; }
    metaPages().then((p) => { setPages(p); setSelectedPage((cur) => cur || p[0]?.id || ''); }).catch(() => setPages([]));
  }, [status?.is_connected]);

  useEffect(() => {
    if (!selectedPage) { setForms([]); return; }
    metaForms(selectedPage).then((r) => setForms(r.forms)).catch(() => setForms([]));
  }, [selectedPage]);

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast(ok, 'ok');
    } catch (ex) {
      toast(apiErrorMessage(ex, 'That did not work'), 'bad');
    } finally {
      setBusy('');
    }
  };

  if (loading) return <div className="card"><p className="help">Loading Meta connection…</p></div>;

  const connectedForms = forms.filter((f) => f.is_connected).length;

  return (
    <div className="card">
      <div className="modal-h">Meta / Facebook Lead Ads</div>

      {/* ---- state banners, most urgent first ---- */}
      {status && !status.configured && (
        <div className="import-error" style={{ marginBottom: 10 }}>
          <strong>Not configured on this server.</strong> Set <code>META_APP_ID</code> and{' '}
          <code>META_APP_SECRET</code> (or the <code>FACEBOOK_*</code> equivalents) and restart the API.
        </div>
      )}
      {status?.configured && !status.token_storage_secure && (
        <div className="reminder-warn" style={{ marginBottom: 10 }}>
          <strong>APP_KEY is not set</strong> — Facebook access tokens would be stored unencrypted.
        </div>
      )}
      {status?.token_expired && (
        <div className="import-error" style={{ marginBottom: 10 }}>
          <strong>The Facebook token has expired.</strong> Lead sync has stopped. Reconnect to resume.
        </div>
      )}
      {status?.is_connected && !status.token_expired && status.needs_reconnect && (
        <div className="reminder-warn" style={{ marginBottom: 10 }}>
          <strong>Reconnect soon.</strong>
          {status.token_days_left !== null && status.token_days_left >= 0
            ? ` The access token expires in ${status.token_days_left} day(s).` : ''}
          {status.missing_permissions.length > 0
            ? ` Missing permission(s): ${status.missing_permissions.join(', ')}.` : ''}
        </div>
      )}
      {status?.last_error && (
        <div className="reminder-warn" style={{ marginBottom: 10 }}>
          <strong>Last error from Facebook:</strong> {status.last_error}
          <div className="help">{stamp(status.last_error_at)}</div>
        </div>
      )}

      {/* ---- status ---- */}
      <dl className="lead-dl">
        <dt>Status</dt>
        <dd>
          {status?.is_connected
            ? <span className="pill ok">Connected</span>
            : <span className="pill bad">Not connected</span>}
        </dd>
        {status?.is_connected && (
          <>
            <dt>Account</dt><dd>{status.facebook_user_name ?? '—'}</dd>
            <dt>Pages</dt><dd>{status.pages_count}{status.page_name ? ` · ${status.page_name}` : ''}</dd>
            <dt>Lead forms</dt><dd>{status.connected_forms} connected</dd>
            <dt>Token expires</dt>
            <dd>{status.token_expires_at ? `${stamp(status.token_expires_at)} (${status.token_days_left} day(s))` : 'Never / unknown'}</dd>
            <dt>Last sync</dt><dd>{stamp(status.last_sync)}</dd>
            <dt>Last webhook</dt><dd>{stamp(status.last_webhook_at)}</dd>
            <dt>Leads imported</dt><dd>{status.leads_count}</dd>
            {status.ad_account_name && (<><dt>Ad account</dt><dd>{status.ad_account_name}</dd></>)}
          </>
        )}
      </dl>

      <div className="toolbar-row" style={{ marginTop: 10 }}>
        {!status?.is_connected && canEdit && (
          <button className="btn primary sm" type="button" disabled={busy !== '' || !status?.configured}
            onClick={() => void run('connect', async () => window.location.assign(await metaAuthUrl()))}>
            {busy === 'connect' ? 'Opening Facebook…' : 'Connect Facebook'}
          </button>
        )}
        {status?.is_connected && canEdit && (
          <>
            <button className="btn primary sm" type="button" disabled={busy !== ''}
              onClick={() => void run('sync', async () => {
                const r = await syncMetaLeads();
                toast(r.message, r.errors.length && !r.imported ? 'info' : 'ok');
                await loadStatus();
                setHistory(await metaSyncHistory(5));
              })}>
              {busy === 'sync' ? 'Syncing…' : '↻ Sync Now'}
            </button>
            <button className="btn ghost sm" type="button" disabled={busy !== ''}
              onClick={() => void run('reconnect', async () => window.location.assign(await metaAuthUrl()))}>
              Reconnect
            </button>
            <button className="btn ghost sm" type="button" disabled={busy !== ''}
              onClick={() => void run('pages', async () => { await refreshMetaPages(); setPages(await metaPages()); }, 'Pages refreshed.')}>
              Refresh Pages
            </button>
            <button className="btn ghost sm" type="button" disabled={busy !== ''}
              onClick={() => void run('disconnect', async () => {
                await disconnectMeta(); setPages([]); setForms([]); await loadStatus();
              }, 'Meta disconnected.')}>
              Disconnect
            </button>
          </>
        )}
        <button className="btn ghost sm" type="button" disabled={busy !== ''}
          onClick={() => void run('test', async () => {
            const d = await metaDiagnostics();
            toast(d.blockers.length ? `Connection test: ${d.blockers[0]}` : 'Connection test passed — no configuration problems found.',
              d.blockers.length ? 'bad' : 'ok');
          })}>
          {busy === 'test' ? 'Testing…' : 'Test Connection'}
        </button>
        {compact && (
          <button className="btn ghost sm" type="button" onClick={() => navigate(crmPath('meta'))}>Open Meta screen</button>
        )}
      </div>

      {/* ---- pages + forms ---- */}
      {status?.is_connected && (
        <>
          <div className="modal-sub">Pages &amp; Lead Forms{forms.length ? ` (${connectedForms} of ${forms.length} connected)` : ''}</div>
          <div className="toolbar-row">
            <select value={selectedPage} onChange={(e) => setSelectedPage(e.target.value)}>
              {pages.length === 0 && <option value="">No pages available</option>}
              {pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          {pages.length === 0 && (
            <p className="help">
              No Pages came back from Facebook. The signed-in account must administer a Page and
              have granted <code>pages_show_list</code>.
            </p>
          )}
          {forms.length === 0 && pages.length > 0 && <p className="help">No lead forms on this Page.</p>}
          {forms.length > 0 && (
            <ul className="meta-forms">
              {forms.map((f) => (
                <li key={f.id}>
                  <div>
                    <strong>{f.name}</strong>
                    <div className="muted">{f.leads_count} lead(s) on Meta{f.status ? ` · ${f.status.toLowerCase()}` : ''}</div>
                  </div>
                  <div className="toolbar-row">
                    <span className={`pill ${f.is_connected ? 'ok' : ''}`}>{f.is_connected ? 'Connected' : 'Off'}</span>
                    {canEdit && (
                      <button className="btn ghost sm" type="button" disabled={busy !== ''}
                        onClick={() => void run(`form-${f.id}`, async () => {
                          await toggleMetaForm(selectedPage, f.id, f.name, !f.is_connected);
                          setForms((list) => list.map((x) => (x.id === f.id ? { ...x, is_connected: !f.is_connected } : x)));
                          await loadStatus();
                        })}>
                        {f.is_connected ? 'Disconnect' : 'Connect'}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="help">Only connected forms are read. New leads also arrive instantly by webhook.</p>
        </>
      )}

      {/* ---- history + webhook health ---- */}
      {!compact && history.length > 0 && (
        <>
          <div className="modal-sub">Recent Syncs</div>
          <ul className="crm-feed">
            {history.map((h) => (
              <li key={h.id}>
                <div>
                  <strong>{h.trigger}</strong> · {h.imported} imported, {h.updated} updated,
                  {' '}{h.duplicates} merged, {h.skipped} skipped from {h.forms_read} form(s)
                </div>
                <div className="muted">{stamp(h.started_at)}{h.errors.length ? ` · ${h.errors[0]}` : ''}</div>
              </li>
            ))}
          </ul>
        </>
      )}
      {!compact && webhook && (
        <>
          <div className="modal-sub">Webhook Health</div>
          <p className="help">
            {webhook.total} delivery(ies) received{webhook.failed > 0 ? `, ${webhook.failed} failed` : ''} ·
            last {stamp(webhook.last_received_at)}
          </p>
          {webhook.events.length > 0 && (
            <ul className="crm-feed">
              {webhook.events.map((e) => (
                <li key={e.id}>
                  <div>
                    <span className={`pill ${e.status === 'processed' ? 'ok' : e.status === 'failed' ? 'bad' : 'info'}`}>{e.status}</span>
                    {' '}lead {e.leadgen_id ?? '—'}{e.attempts > 1 ? ` · ${e.attempts} deliveries` : ''}
                  </div>
                  <div className="muted">{stamp(e.received_at)}{e.error ? ` · ${e.error}` : ''}</div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
