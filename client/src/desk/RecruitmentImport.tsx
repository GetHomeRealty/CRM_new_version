import { useState } from 'react';
import {
  importCandidates, importTemplate, previewCandidateImport,
  type ImportPreview, type ImportResult,
} from '../lib/recruitmentApi';
import { apiErrorMessage } from '../lib/apiError';
import { useToast } from './toast';

const MAX_BYTES = 2 * 1024 * 1024;

/** Base64 of a file, without the data-URL prefix. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.readAsDataURL(file);
  });
}

function download(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** One CSV cell — quoted, and with a leading formula character neutralised so the report is safe to open. */
const csvCell = (v: unknown): string => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

const statusPill = (s: string): string => (s === 'valid' || s === 'added' ? 'pill ok' : s === 'duplicate' || s === 'skipped' ? 'pill warn' : 'pill bad');
const statusLabel: Record<string, string> = { valid: 'Valid', duplicate: 'Duplicate', error: 'Error', added: 'Added', skipped: 'Skipped', failed: 'Failed' };

/**
 * IMPORT CANDIDATES FROM EXCEL OR CSV — template, upload, preview, import, report.
 *
 * Nothing is saved until "Import valid candidates", and the server checks the whole file again then
 * (the preview is a picture, not a promise). Duplicates are skipped, never merged; every imported
 * candidate starts at New; no emails are sent. The button is pressed once: it locks while the import
 * runs, and the server would skip anything already created if it were pressed again.
 */
export default function RecruitmentImport({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const toast = useToast();
  const [file, setFile] = useState<{ filename: string; content_base64: string } | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState<'' | 'template' | 'preview' | 'import'>('');
  const [error, setError] = useState('');

  const getTemplate = async () => {
    setBusy('template');
    try {
      const t = await importTemplate();
      const bytes = Uint8Array.from(atob(t.content_base64), (c) => c.charCodeAt(0));
      download(t.filename, new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not download the template'), 'bad');
    } finally {
      setBusy('');
    }
  };

  const choose = async (f: File | null) => {
    setPreview(null); setResult(null); setError(''); setFile(null);
    if (!f) return;
    const name = f.name.toLowerCase();
    if (!name.endsWith('.xlsx') && !name.endsWith('.csv')) { setError('Choose an Excel .xlsx file or a .csv file.'); return; }
    if (f.size > MAX_BYTES) { setError('The file is larger than 2 MB. Split it into smaller files.'); return; }
    setBusy('preview');
    try {
      const payload = { filename: f.name, content_base64: await fileToBase64(f) };
      setPreview(await previewCandidateImport(payload));
      setFile(payload);
    } catch (ex) {
      setError(apiErrorMessage(ex, 'The file could not be checked'));
    } finally {
      setBusy('');
    }
  };

  const runImport = async () => {
    if (!file || busy || result) return;
    setBusy('import');
    setError('');
    try {
      const r = await importCandidates(file);
      setResult(r);
      onImported();
      toast(`Imported ${r.added} candidate${r.added === 1 ? '' : 's'}.`, r.failed ? 'info' : 'ok');
    } catch (ex) {
      // Nothing is lost by trying again: rows already created are found and skipped.
      setError(apiErrorMessage(ex, 'The import did not complete. Try again — anything already added will be skipped.'));
    } finally {
      setBusy('');
    }
  };

  const report = () => {
    if (!result) return;
    const lines = [['Row', 'Name', 'Email', 'Result', 'Reason'], ...result.results.map((r) => [r.row, r.name, r.email, statusLabel[r.outcome] ?? r.outcome, r.reason])];
    const text = `\uFEFF${lines.map((l) => l.map(csvCell).join(',')).join('\r\n')}`;
    download('recruitment-import-report.csv', new Blob([text], { type: 'text/csv;charset=utf-8' }));
  };

  const valid = preview?.counts.valid ?? 0;

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget && busy !== 'import') onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="recruitment-import-title" style={{ maxWidth: 980, width: '96vw' }}>
        <button className="close" type="button" onClick={onClose} disabled={busy === 'import'} aria-label="Close">✕</button>
        <div className="modal-h" id="recruitment-import-title">Import candidates</div>
        <p className="help" style={{ marginTop: 0 }}>
          Columns: Name and Email (required), Phone, Source, Recruiter Email, Note. Up to 500 rows and 2 MB, .xlsx or .csv.
          New candidates start at New; duplicates are skipped; no emails are sent.
        </p>

        <div className="toolbar-row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn ghost sm" type="button" disabled={busy !== ''} onClick={() => void getTemplate()}>
            {busy === 'template' ? 'Preparing…' : 'Download template (.xlsx)'}
          </button>
          <label className="btn ghost sm" style={{ cursor: busy ? 'default' : 'pointer' }}>
            {preview ? 'Choose a different file' : 'Choose file (.xlsx or .csv)'}
            <input type="file" accept=".xlsx,.csv" data-testid="import-file" style={{ display: 'none' }} disabled={busy !== '' || !!result}
              onChange={(e) => { void choose(e.target.files?.[0] ?? null); e.target.value = ''; }} />
          </label>
          {busy === 'preview' && <span className="help" style={{ margin: 0 }}>Checking the file…</span>}
          {file && <span className="muted">{file.filename}</span>}
        </div>

        {error && <p className="help bad" role="alert" data-testid="import-error">{error}</p>}

        {preview && !result && (
          <>
            <p className="help" data-testid="import-counts">
              {preview.counts.total} row{preview.counts.total === 1 ? '' : 's'}: {preview.counts.valid} valid,{' '}
              {preview.counts.duplicate} duplicate, {preview.counts.error} with errors. Nothing has been saved yet.
            </p>
            <div className="lead-scroll" style={{ maxHeight: 360, overflow: 'auto' }}>
              <table className="list-table" data-testid="import-preview">
                <thead><tr><th>Row</th><th>Name</th><th>Email</th><th>Phone</th><th>Source</th><th>Recruiter</th><th>Note</th><th>Result</th><th>Reason</th></tr></thead>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr key={r.row} data-row={r.row}>
                      <td>{r.row}</td>
                      <td>{r.name || '—'}</td>
                      <td>{r.email || '—'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{r.phone || '—'}</td>
                      <td>{r.source || '—'}</td>
                      <td>{r.recruiter_email || '—'}</td>
                      <td title={r.note}>{r.note ? (r.note.length > 40 ? `${r.note.slice(0, 40)}…` : r.note) : '—'}</td>
                      <td><span className={statusPill(r.status)}>{statusLabel[r.status]}</span></td>
                      <td className="muted">{r.reasons.join(' ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="toolbar-row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
              <button className="btn ghost" type="button" onClick={onClose} disabled={busy === 'import'}>Cancel</button>
              <button className="btn primary" type="button" disabled={valid === 0 || busy !== ''} onClick={() => void runImport()}>
                {busy === 'import' ? 'Importing…' : `Import valid candidates (${valid})`}
              </button>
            </div>
          </>
        )}

        {result && (
          <div data-testid="import-result" style={{ marginTop: 10 }}>
            <p style={{ margin: '0 0 8px' }}>
              <strong>{result.added}</strong> added · <strong>{result.skipped}</strong> skipped · <strong>{result.failed}</strong> failed
            </p>
            <div className="lead-scroll" style={{ maxHeight: 300, overflow: 'auto' }}>
              <table className="list-table">
                <thead><tr><th>Row</th><th>Name</th><th>Email</th><th>Result</th><th>Reason</th></tr></thead>
                <tbody>
                  {result.results.map((r) => (
                    <tr key={r.row} data-row={r.row}>
                      <td>{r.row}</td><td>{r.name || '—'}</td><td>{r.email || '—'}</td>
                      <td><span className={statusPill(r.outcome)}>{statusLabel[r.outcome]}</span></td>
                      <td className="muted">{r.reason || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="toolbar-row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
              <button className="btn ghost" type="button" onClick={report}>Download report (.csv)</button>
              <button className="btn primary" type="button" onClick={onClose}>Done</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
