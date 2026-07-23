import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { exportHistory, downloadExport, deleteExport, sweepExports } from '../lib/exportCentreApi';
import { apiErrorMessage } from '../lib/apiError';
import { useToast } from './toast';
import { useAuth } from '../context/AuthContext';
import type { ExportJob } from '../types';

/** Jobs in these states are still moving, so the page keeps polling while any exist. */
const ACTIVE = ['Queued', 'Processing'];
const POLL_MS = 2000;

const pillFor = (s: string): string =>
  s === 'Completed' ? 'ok' : s === 'Partially Completed' ? 'warn' : s === 'Failed' ? 'bad' : s === 'Expired' ? '' : 'info';

const fmtSize = (n: number | null): string => {
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
};
const fmtWhen = (v: string | null): string => (v ? new Date(v).toLocaleString() : '—');

/** How long a live download link has left. */
function expiryText(job: ExportJob): string {
  if (!job.expires_at || job.status === 'Expired') return 'Expired';
  const ms = new Date(job.expires_at).getTime() - Date.now();
  if (ms <= 0) return 'Expired';
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  return h > 0 ? `Expires in ${h}h ${m}m` : `Expires in ${m}m`;
}

/**
 * Export & Download Centre. Bulk exports are generated in the background; this page tracks
 * their status and serves the finished files through their expiring links.
 */
export default function DownloadCentrePage() {
  const toast = useToast();
  const nav = useNavigate();
  const { isAdminOrAbove } = useAuth();
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (): Promise<ExportJob[]> => {
    const list = await exportHistory();
    setJobs(list);
    return list;
  }, []);

  // poll only while something is actually running
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const list = await load();
        if (cancelled) return;
        if (list.some((j) => ACTIVE.includes(j.status))) timer.current = setTimeout(tick, POLL_MS);
      } catch {
        /* transient — the next user action will refresh */
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void tick();
    return () => { cancelled = true; if (timer.current) clearTimeout(timer.current); };
  }, [load]);

  const download = async (job: ExportJob) => {
    if (!job.download_token) return;
    setBusy(job.export_id);
    try { await downloadExport(job.download_token, job.file_name ?? 'export'); await load(); }
    catch (e) { toast(apiErrorMessage(e, 'Download failed'), 'bad'); }
    finally { setBusy(''); }
  };

  const remove = async (job: ExportJob) => {
    setBusy(job.export_id);
    try { await deleteExport(job.export_id); await load(); toast('Export deleted', 'ok'); }
    catch (e) { toast(apiErrorMessage(e, 'Could not delete the export'), 'bad'); }
    finally { setBusy(''); }
  };

  const sweep = async () => {
    setBusy('sweep');
    try { const r = await sweepExports(); await load(); toast(`${r.swept} expired export(s) cleared`, 'ok'); }
    catch (e) { toast(apiErrorMessage(e, 'Cleanup failed'), 'bad'); }
    finally { setBusy(''); }
  };

  const active = jobs.filter((j) => ACTIVE.includes(j.status)).length;

  return (
    <>
      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn ghost sm" onClick={() => nav('/app/transactions')}>← Transactions</button>
          <div>
            <h2 style={{ margin: 0 }}>Export &amp; Download Centre</h2>
            <div className="muted" style={{ fontSize: 13 }}>
              Bulk exports are prepared in the background. Download links expire automatically.
            </div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            {active > 0 && <span className="pill info">{active} in progress</span>}
            <button className="btn ghost" onClick={() => void load()} disabled={!!busy}>Refresh</button>
            {isAdminOrAbove && <button className="btn ghost" onClick={sweep} disabled={!!busy}>Clear Expired</button>}
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="report-table-wrap">
          <table className="list-table">
            <thead>
              <tr>
                <th>Export</th><th>Type</th><th>Format</th><th>Deals</th><th>Files</th>
                <th>Size</th><th>Requested By</th><th>Requested</th><th>Status</th>
                <th>Link</th><th>Downloads</th><th />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={12} className="centered">Loading…</td></tr>
              ) : jobs.length === 0 ? (
                <tr><td colSpan={12} style={{ textAlign: 'center', color: 'var(--muted)', padding: 24 }}>
                  No exports yet. Select transactions and choose “Export Data” or “Download Documents”.
                </td></tr>
              ) : jobs.map((j) => (
                <tr key={j.export_id}>
                  <td style={{ fontFamily: 'monospace', fontSize: 12 }} title={j.filters.map((f) => `${f.label}: ${f.value}`).join('\n')}>
                    {j.export_id}
                  </td>
                  <td>{j.action_label}</td>
                  <td>{j.format}</td>
                  <td>{j.transaction_count}</td>
                  <td>
                    {j.document_count || j.skipped_count
                      ? <>{j.document_count}{j.skipped_count > 0 && <span className="muted" title={`${j.skipped_count} file(s) unavailable — see the ZIP manifest`}> (+{j.skipped_count} skipped)</span>}</>
                      : '—'}
                  </td>
                  <td>{fmtSize(j.file_size)}</td>
                  <td>{j.requested_by ?? '—'}</td>
                  <td className="col-date">{fmtWhen(j.requested_at)}</td>
                  <td>
                    <span className={`pill ${pillFor(j.status)}`}>{j.status}</span>
                    {j.status === 'Failed' && j.failure_reason && (
                      <div className="muted" style={{ fontSize: 11, marginTop: 2, maxWidth: 240 }}>{j.failure_reason}</div>
                    )}
                  </td>
                  <td className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                    {j.download_token ? expiryText(j) : j.status === 'Expired' ? 'Expired' : '—'}
                  </td>
                  <td>{j.download_count > 0 ? `${j.download_count}× · ${fmtWhen(j.downloaded_at)}` : 'Not downloaded'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {j.download_token && (
                      <button className="btn sm" disabled={busy === j.export_id} onClick={() => download(j)}>
                        {busy === j.export_id ? '…' : 'Download'}
                      </button>
                    )}
                    {isAdminOrAbove && j.status !== 'Expired' && (
                      <button className="btn ghost sm" style={{ marginLeft: 4 }} disabled={busy === j.export_id} onClick={() => remove(j)} title="Delete the generated file">
                        🗑️
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
