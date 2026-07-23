import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  downloadImportTemplate, downloadImportErrors, fileToBase64,
  validateImport, confirmImport, importHistory,
} from '../lib/importApi';
import { apiErrorMessage } from '../lib/apiError';
import { useToast } from './toast';
import type { ImportPreview, ImportResult, ImportBatch, ImportIssue } from '../types';

const ACCEPT = '.xlsx,.csv';

/**
 * Bulk Transaction Import. Upload → validate → review → confirm.
 * Nothing is created until the user confirms, and invalid rows never block the valid ones.
 */
export default function BulkImportPage() {
  const toast = useToast();
  const nav = useNavigate();
  const fileInput = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [history, setHistory] = useState<ImportBatch[]>([]);
  const [dragging, setDragging] = useState(false);

  const loadHistory = useCallback(() => {
    importHistory().then(setHistory).catch(() => { /* history is informational */ });
  }, []);
  useEffect(loadHistory, [loadHistory]);

  const reset = () => { setFile(null); setPreview(null); setResult(null); setError(''); if (fileInput.current) fileInput.current.value = ''; };

  const validate = async (f: File) => {
    setBusy('validating'); setError(''); setPreview(null); setResult(null);
    try {
      const content = await fileToBase64(f);
      setPreview(await validateImport(f.name, content));
    } catch (e) {
      setError(apiErrorMessage(e, 'The file could not be validated'));
    } finally { setBusy(''); }
  };

  const pick = (f: File | null) => { if (!f) return; setFile(f); validate(f); };

  const confirm = async () => {
    if (!preview) return;
    setBusy('importing'); setError('');
    try {
      const r = await confirmImport(preview.batch_id);
      setResult(r);
      loadHistory();
      toast(`${r.imported_rows} transaction${r.imported_rows === 1 ? '' : 's'} imported`
        + (r.failed_rows ? ` · ${r.failed_rows} rejected` : ''), r.imported_rows ? 'ok' : 'bad');
    } catch (e) {
      setError(apiErrorMessage(e, 'The import could not be completed'));
    } finally { setBusy(''); }
  };

  return (
    <>
      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn ghost sm" onClick={() => nav('/app/transactions')}>← Transactions</button>
          <div>
            <h2 style={{ margin: 0 }}>Bulk Transaction Import</h2>
            <div className="muted" style={{ fontSize: 13 }}>Create many transactions at once from a spreadsheet.</div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button className="btn ghost" onClick={() => downloadImportTemplate().catch((e) => toast(apiErrorMessage(e, 'Download failed'), 'bad'))}>
              Download Template
            </button>
          </div>
        </div>
      </div>

      {/* step 1 — upload */}
      <div className="card" style={{ marginBottom: 12 }}>
        <h3 style={{ marginTop: 0 }}>1. Upload your file</h3>
        <div
          className={`import-drop${dragging ? ' over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); pick(e.dataTransfer.files?.[0] ?? null); }}
          onClick={() => fileInput.current?.click()}
        >
          <input ref={fileInput} type="file" accept={ACCEPT} style={{ display: 'none' }} onChange={(e) => pick(e.target.files?.[0] ?? null)} />
          {file ? (
            <>
              <strong>{file.name}</strong>
              <div className="muted">{(file.size / 1024).toFixed(1)} KB · click to choose a different file</div>
            </>
          ) : (
            <>
              <strong>Drop your .xlsx or .csv file here</strong>
              <div className="muted">or click to browse. Use the import template so the column headings match.</div>
            </>
          )}
        </div>
        {busy === 'validating' && <div className="muted" style={{ marginTop: 10 }}>Validating…</div>}
        {error && <div className="import-error" style={{ marginTop: 10 }}>{error}</div>}
      </div>

      {/* step 2 — preview */}
      {preview && !result && (
        <div className="card" style={{ marginBottom: 12 }}>
          <h3 style={{ marginTop: 0 }}>2. Review before importing</h3>
          <div className="import-summary">
            <div><strong>{preview.total_rows}</strong><span>rows detected</span></div>
            <div className="good"><strong>{preview.valid_rows}</strong><span>valid</span></div>
            <div className="bad"><strong>{preview.invalid_rows}</strong><span>invalid</span></div>
            <div className="warn"><strong>{preview.duplicate_rows}</strong><span>duplicates</span></div>
            <div className="warn"><strong>{preview.warning_rows}</strong><span>warnings</span></div>
          </div>

          {preview.issues.length > 0 && <IssueTable issues={preview.issues} />}

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 14, flexWrap: 'wrap' }}>
            <button className="btn" disabled={busy !== '' || preview.valid_rows === 0} onClick={confirm}>
              {busy === 'importing' ? 'Importing…' : `Import ${preview.valid_rows} transaction${preview.valid_rows === 1 ? '' : 's'}`}
            </button>
            {preview.issues.length > 0 && (
              <button className="btn ghost" onClick={() => downloadImportErrors(preview.batch_id).catch((e) => toast(apiErrorMessage(e, 'Download failed'), 'bad'))}>
                Download Validation Report
              </button>
            )}
            <button className="btn ghost" onClick={reset}>Cancel</button>
            {preview.valid_rows === 0 && <span className="muted" style={{ fontSize: 13 }}>No row passed validation — fix the file and upload it again.</span>}
            {preview.valid_rows > 0 && preview.invalid_rows + preview.duplicate_rows > 0 && (
              <span className="muted" style={{ fontSize: 13 }}>
                The {preview.invalid_rows + preview.duplicate_rows} rejected row(s) will be skipped.
              </span>
            )}
          </div>
        </div>
      )}

      {/* step 3 — result */}
      {result && (
        <div className="card" style={{ marginBottom: 12 }}>
          <h3 style={{ marginTop: 0 }}>3. Import {result.status.toLowerCase()}</h3>
          <div className="import-summary">
            <div className="good"><strong>{result.imported_rows}</strong><span>imported</span></div>
            <div className="bad"><strong>{result.failed_rows}</strong><span>rejected</span></div>
            <div className="warn"><strong>{result.duplicate_rows}</strong><span>duplicates</span></div>
          </div>
          {result.created.length > 0 && (
            <div className="import-created">
              <strong>Created:</strong>{' '}
              {result.created.map((c) => (
                <span key={c.trade_no} className="pill ok" style={{ marginRight: 6 }}>{c.trade_no}</span>
              ))}
            </div>
          )}
          {result.issues.length > 0 && <IssueTable issues={result.issues} />}
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button className="btn" onClick={() => nav('/app/transactions')}>Go to Transactions</button>
            {result.issues.length > 0 && (
              <button className="btn ghost" onClick={() => downloadImportErrors(result.batch_id).catch((e) => toast(apiErrorMessage(e, 'Download failed'), 'bad'))}>
                Download Validation Report
              </button>
            )}
            <button className="btn ghost" onClick={reset}>Import Another File</button>
          </div>
        </div>
      )}

      {/* history */}
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Import History</h3>
        {history.length === 0 ? <div className="muted">No imports yet.</div> : (
          <div className="report-table-wrap">
            <table className="list-table">
              <thead>
                <tr>
                  <th>Batch</th><th>File</th><th>Uploaded By</th><th>Uploaded</th>
                  <th>Rows</th><th>Imported</th><th>Rejected</th><th>Duplicates</th><th>Status</th><th />
                </tr>
              </thead>
              <tbody>
                {history.map((b) => (
                  <tr key={b.batch_id}>
                    <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{b.batch_id}</td>
                    <td>{b.file_name ?? '—'}</td>
                    <td>{b.uploaded_by ?? '—'}</td>
                    <td className="col-date">{b.uploaded_at ? new Date(b.uploaded_at).toLocaleString() : '—'}</td>
                    <td>{b.total_rows}</td>
                    <td>{b.imported_rows}</td>
                    <td>{b.failed_rows}</td>
                    <td>{b.duplicate_rows}</td>
                    <td><span className={`pill ${b.status === 'Imported' ? 'ok' : b.status === 'Failed' ? 'bad' : 'warn'}`}>{b.status}</span></td>
                    <td>
                      <button className="btn ghost sm" onClick={() => downloadImportErrors(b.batch_id).catch((e) => toast(apiErrorMessage(e, 'Download failed'), 'bad'))}>
                        Report
                      </button>
                    </td>
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

/** The per-row validation problems, grouped so errors are addressed before warnings. */
function IssueTable({ issues }: { issues: ImportIssue[] }) {
  const order = { error: 0, duplicate: 1, warning: 2 } as const;
  const sorted = [...issues].sort((a, b) => order[a.severity] - order[b.severity] || a.row - b.row);
  const shown = sorted.slice(0, 100);
  return (
    <>
      <div className="report-table-wrap" style={{ marginTop: 12, maxHeight: 340, overflowY: 'auto' }}>
        <table className="list-table">
          <thead>
            <tr><th>Row</th><th>Reference</th><th>Field</th><th>Value</th><th>Problem</th><th>Suggested Correction</th></tr>
          </thead>
          <tbody>
            {shown.map((i, n) => (
              <tr key={n} className={`import-issue ${i.severity}`}>
                <td>{i.row}</td>
                <td>{i.reference}</td>
                <td>{i.field}</td>
                <td>{i.value || '—'}</td>
                <td>{i.message}</td>
                <td className="muted">{i.fix}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sorted.length > shown.length && (
        <div className="muted" style={{ marginTop: 6, fontSize: 13 }}>
          Showing the first {shown.length} of {sorted.length} issues — download the validation report for the full list.
        </div>
      )}
    </>
  );
}
