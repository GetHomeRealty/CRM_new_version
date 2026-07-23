import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  disconnectMeta, metaAuthUrl, metaDiagnostics, metaForms, metaLeads, metaPages, metaStatus,
  refreshMetaPages, syncMetaLeads, toggleMetaForm,
} from '../lib/metaApi';
import { apiErrorMessage } from '../lib/apiError';
import { useToast } from './toast';
import { useAuth } from '../context/AuthContext';
import ConfirmDialog, { useConfirm } from './ConfirmDialog';
import type {
  MetaDiagnostics, MetaForm, MetaLeadRow, MetaPage as MetaPageInfo, MetaStatus,
} from '../types';

/** What each `meta_error` code from the OAuth callback means to a person. */
const OAUTH_ERRORS: Record<string, string> = {
  access_denied: 'You cancelled the Facebook sign-in, or declined a permission.',
  not_configured: 'Meta is not configured on this server yet.',
  missing_code: 'Facebook did not return an authorization code. Try again.',
  invalid_state: 'That sign-in link expired or was already used. Start the connection again.',
  connect_failed: 'Facebook accepted the sign-in but the connection could not be completed. Open Diagnostics for the reason.',
};

const stamp = (iso: string | null): string => (iso ? iso.replace('T', ' ').slice(0, 16) : '—');

export default function MetaPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const { can } = useAuth();
  const canEdit = can('meta', 'edit');
  const { confirm, askDelete, closeConfirm } = useConfirm();
  const [params, setParams] = useSearchParams();

  const [status, setStatus] = useState<MetaStatus | null>(null);
  const [pages, setPages] = useState<MetaPageInfo[]>([]);
  const [selectedPage, setSelectedPage] = useState('');
  const [forms, setForms] = useState<MetaForm[]>([]);
  const [leads, setLeads] = useState<MetaLeadRow[]>([]);
  const [leadStats, setLeadStats] = useState({ total: 0, today: 0, week: 0 });
  const [diagnostics, setDiagnostics] = useState<MetaDiagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');

  const loadStatus = useCallback(async () => {
    try { setStatus(await metaStatus()); } catch (ex) { toast(apiErrorMessage(ex, 'Could not read Meta status'), 'bad'); }
  }, [toast]);

  const loadLeads = useCallback(async () => {
    try {
      const res = await metaLeads(50);
      setLeads(res.data);
      setLeadStats(res.stats);
    } catch { /* the lead list is secondary to the connection panel */ }
  }, []);

  useEffect(() => {
    void (async () => {
      await Promise.all([loadStatus(), loadLeads()]);
      setLoading(false);
    })();
  }, [loadStatus, loadLeads]);

  // The OAuth callback redirects back here with the outcome in the query string.
  useEffect(() => {
    const connected = params.get('meta_connected');
    const error = params.get('meta_error');
    const warning = params.get('meta_warning');
    if (!connected && !error) return;

    if (connected) {
      toast(warning === 'no_pages'
        ? 'Connected, but no Facebook Pages were found. Sign in with an account that administers a Page.'
        : 'Meta connected. Pick a Page and choose which lead forms to read.', warning ? 'info' : 'ok');
      void loadStatus();
    } else if (error) {
      toast(OAUTH_ERRORS[error] ?? `Connection failed (${error}).`, 'bad');
    }
    // Clear the params so a refresh doesn't replay the toast.
    setParams({}, { replace: true });
  }, [params, setParams, toast, loadStatus]);

  useEffect(() => {
    if (!status?.is_connected) return;
    metaPages().then((p) => {
      setPages(p);
      setSelectedPage((cur) => cur || p[0]?.id || '');
    }).catch(() => setPages([]));
  }, [status?.is_connected]);

  useEffect(() => {
    if (!selectedPage) { setForms([]); return; }
    metaForms(selectedPage)
      .then((r) => setForms(r.forms))
      .catch((ex) => { setForms([]); toast(apiErrorMessage(ex, 'Could not load lead forms'), 'bad'); });
  }, [selectedPage, toast]);

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

  const connect = () => run('connect', async () => {
    const url = await metaAuthUrl();
    window.location.assign(url);
  });

  const sync = () => run('sync', async () => {
    const res = await syncMetaLeads();
    toast(res.message, res.errors.length && !res.imported ? 'info' : 'ok');
    await Promise.all([loadStatus(), loadLeads()]);
  });

  const disconnect = () => askDelete({
    title: 'Disconnect Meta?',
    message: 'New leads will stop arriving. Leads already synced stay in the Lead module.',
    note: 'The stored Facebook access tokens are erased immediately.',
    onConfirm: async () => {
      await run('disconnect', async () => {
        await disconnectMeta();
        setPages([]); setForms([]); setSelectedPage('');
        await loadStatus();
      }, 'Meta disconnected.');
      closeConfirm();
    },
  });

  const toggle = (form: MetaForm) => run(`form-${form.id}`, async () => {
    const res = await toggleMetaForm(selectedPage, form.id, form.name, !form.is_connected);
    setForms((f) => f.map((x) => (x.id === form.id ? { ...x, is_connected: !form.is_connected } : x)));
    toast(res.message, 'ok');
  });

  if (loading) return <div className="card"><p className="help">Loading Meta…</p></div>;

  const connectedForms = forms.filter((f) => f.is_connected).length;

  return (
    <>
      {status && !status.configured && (
        <div className="card meta-alert bad">
          <strong>Meta is not configured on this server.</strong>
          <p>
            Connecting requires a Meta app. Set <code>META_APP_ID</code>, <code>META_APP_SECRET</code>,
            {' '}<code>META_LOGIN_CONFIG_ID</code> and <code>META_PUBLIC_URL</code> in the API environment
            and restart it. Everything below stays read-only until then.
          </p>
        </div>
      )}
      {status && status.configured && !status.token_storage_secure && (
        <div className="card meta-alert warn">
          <strong>APP_KEY is not set.</strong>
          <p>Facebook access tokens would be stored without encryption. Set <code>APP_KEY</code> before connecting.</p>
        </div>
      )}

      <div className="toolbar">
        <div className="toolbar-row" style={{ justifyContent: 'space-between' }}>
          <div>
            <h2 className="meta-title">Meta</h2>
            <p className="help" style={{ marginTop: 2 }}>
              Facebook and Instagram lead ads. Synced leads land in <button className="prop-link" type="button" onClick={() => navigate('/app/lead')}>Lead</button> with the source “Meta”.
            </p>
          </div>
          <div className="toolbar-row">
            {status?.is_connected && canEdit && (
              <button className="btn ghost" type="button" disabled={busy !== ''} onClick={sync}>
                {busy === 'sync' ? 'Syncing…' : '↻ Sync Now'}
              </button>
            )}
            {canEdit && (
              <button className="btn ghost" type="button" disabled={busy !== ''}
                onClick={() => void run('diag', async () => setDiagnostics(await metaDiagnostics()))}>
                Diagnostics
              </button>
            )}
            {status?.is_connected
              ? canEdit && <button className="btn ghost" type="button" disabled={busy !== ''} onClick={disconnect}>Disconnect</button>
              : canEdit && (
                <button className="btn primary" type="button" disabled={busy !== '' || !status?.configured} onClick={connect}>
                  {busy === 'connect' ? 'Opening Facebook…' : 'Connect Facebook'}
                </button>
              )}
          </div>
        </div>
      </div>

      <div className="stat-grid">
        <Stat label="Meta leads" value={leadStats.total} />
        <Stat label="Today" value={leadStats.today} />
        <Stat label="This week" value={leadStats.week} />
      </div>

      <div className="g2">
        <div className="card">
          <div className="modal-sub">Connection</div>
          {!status?.is_connected ? (
            <>
              <p className="help">Not connected.</p>
              <p className="help">
                Connect with a Facebook account that administers the Page running your lead ads.
                You'll then choose which lead forms to read — nothing is pulled until you opt a form in.
              </p>
            </>
          ) : (
            <dl className="lead-dl">
              <dt>Account</dt><dd>{status.facebook_user_name ?? '—'}</dd>
              <dt>Pages</dt><dd>{status.pages_count} {status.page_name ? `· ${status.page_name}` : ''}</dd>
              <dt>Connected</dt><dd>{stamp(status.connected_at)}</dd>
              <dt>Last sync</dt><dd>{stamp(status.last_sync)}</dd>
              <dt>Leads synced</dt><dd>{status.leads_count}</dd>
            </dl>
          )}

          {status?.is_connected && (
            <>
              <div className="modal-sub">Pages</div>
              <div className="toolbar-row">
                <select value={selectedPage} onChange={(e) => setSelectedPage(e.target.value)}>
                  {pages.length === 0 && <option value="">No pages available</option>}
                  {pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                {canEdit && (
                  <button className="btn ghost sm" type="button" disabled={busy !== ''}
                    onClick={() => void run('pages', async () => {
                      const r = await refreshMetaPages();
                      setPages(await metaPages());
                      toast(r.message, 'ok');
                    })}>
                    Refresh
                  </button>
                )}
              </div>
              {pages.length === 0 && (
                <p className="help">
                  No Pages came back from Facebook. The signed-in account must be a Page admin, and
                  <code> pages_show_list</code> must be granted.
                </p>
              )}
            </>
          )}
        </div>

        <div className="card">
          <div className="modal-sub">Lead Forms{status?.is_connected ? ` (${connectedForms} connected)` : ''}</div>
          {!status?.is_connected ? (
            <p className="help">Connect Meta to choose lead forms.</p>
          ) : forms.length === 0 ? (
            <p className="help">No lead forms found on this Page.</p>
          ) : (
            <ul className="meta-forms">
              {forms.map((f) => (
                <li key={f.id}>
                  <div>
                    <strong>{f.name}</strong>
                    <div className="muted">
                      {f.leads_count} lead{f.leads_count === 1 ? '' : 's'} on Meta
                      {f.status ? ` · ${f.status.toLowerCase()}` : ''}
                    </div>
                  </div>
                  <div className="toolbar-row">
                    <span className={`pill ${f.is_connected ? 'ok' : ''}`}>{f.is_connected ? 'Connected' : 'Off'}</span>
                    {canEdit && (
                      <button className="btn ghost sm" type="button" disabled={busy !== ''} onClick={() => toggle(f)}>
                        {f.is_connected ? 'Disconnect' : 'Connect'}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="help">
            Only connected forms are read. Leads also arrive instantly by webhook once the
            subscription is configured in Meta.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="modal-sub">Recent Meta Leads</div>
        {leads.length === 0 ? (
          <p className="help">No Meta leads yet.</p>
        ) : (
          <div className="lead-scroll">
            <table className="list-table">
              <thead>
                <tr><th>Name</th><th>Contact</th><th>Enquiry</th><th>Status</th><th>Received</th><th></th></tr>
              </thead>
              <tbody>
                {leads.map((l) => (
                  <tr key={l.id}>
                    <td>{l.name}</td>
                    <td className="muted">
                      <div>{l.email.endsWith('@meta.invalid') ? <em>No email provided</em> : l.email}</div>
                      <div>{l.phone || '—'}</div>
                    </td>
                    <td className="muted">{l.message || l.property || '—'}</td>
                    <td>{l.lead_status ? <span className="pill info">{l.lead_status}</span> : '—'}</td>
                    <td>{stamp(l.created_at)}</td>
                    <td><button className="btn ghost sm" type="button" onClick={() => navigate(`/app/lead/${l.id}`)}>Open</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {diagnostics && <DiagnosticsModal d={diagnostics} onClose={() => setDiagnostics(null)} />}
      <ConfirmDialog confirm={confirm} onClose={closeConfirm} />
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="card meta-stat">
      <div className="meta-stat-n">{value}</div>
      <div className="muted">{label}</div>
    </div>
  );
}

function DiagnosticsModal({ d, onClose }: { d: MetaDiagnostics; onClose: () => void }) {
  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal lg">
        <button className="close" type="button" onClick={onClose} aria-label="Close">✕</button>
        <div className="modal-h">Meta Diagnostics</div>

        {d.blockers.length === 0
          ? <p className="help">No configuration problems found.</p>
          : (
            <>
              <div className="modal-sub">What's blocking a connection</div>
              <ul className="meta-list bad">{d.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
            </>
          )}

        <div className="modal-sub">Server configuration</div>
        <dl className="lead-dl">
          <dt>App</dt><dd>{d.app_name ? `${d.app_name} (${d.app_id})` : d.app_id ?? 'Not set'}</dd>
          <dt>Redirect URI</dt><dd><code>{d.redirect_uri}</code></dd>
          <dt>OAuth strategy</dt><dd>{d.oauth_strategy}</dd>
          <dt>Login config ID</dt><dd>{d.login_config_id ?? 'Not set'}</dd>
          <dt>Token encryption</dt><dd>{d.token_storage_secure ? 'On (APP_KEY)' : 'Off — APP_KEY missing'}</dd>
          <dt>Live permissions</dt><dd>{d.live_permissions.length ? d.live_permissions.join(', ') : 'None reported'}</dd>
          <dt>Required</dt><dd>{d.required_permissions.join(', ')}</dd>
        </dl>

        <div className="modal-sub">Setup checklist</div>
        <ol className="meta-list">{d.fix_steps.map((s) => <li key={s}>{s}</li>)}</ol>

        <div className="actions">
          <button className="btn ghost" type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
