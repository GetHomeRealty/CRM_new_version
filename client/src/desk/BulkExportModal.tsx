import { deskPath } from './area';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  bulkSummary, exportTransactionsXlsx, exportTransactionsCsv, exportTransactionsPdf,
  exportCompleteXlsx, exportCompleteCsv, downloadDocumentsZip,
} from '../lib/bulkApi';
import { queueExport, type ExportAction } from '../lib/exportCentreApi';
import { apiErrorMessage } from '../lib/apiError';
import { useToast } from './toast';
import type { BulkSummary, BulkDocFilter } from '../types';

/** Which documents to include in a ZIP download. */
const DOC_FILTERS: { value: BulkDocFilter; label: string }[] = [
  { value: 'all', label: 'All documents' },
  { value: 'pending', label: 'Pending documents only' },
  { value: 'invalid', label: 'Invalid documents only' },
  { value: 'valid', label: 'Valid documents only' },
  { value: 'mandatory', label: 'Mandatory documents only' },
];

/**
 * Bulk export / download. Always shows a confirmation summary — how many transactions, how
 * many documents are available, how many are unavailable and what the ZIP will contain —
 * before anything is generated.
 */
export default function BulkExportModal({ mode, transactionIds, onClose }: {
  mode: 'data' | 'documents';
  transactionIds: number[];
  onClose: () => void;
}) {
  const toast = useToast();
  const nav = useNavigate();
  const [docFilter, setDocFilter] = useState<BulkDocFilter>('all');
  const [categories, setCategories] = useState<string[]>([]);
  const [uploadedFrom, setUploadedFrom] = useState('');
  const [uploadedTo, setUploadedTo] = useState('');
  const [summary, setSummary] = useState<BulkSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const selection = {
    transaction_ids: transactionIds,
    documents: docFilter,
    categories,
    uploaded_from: uploadedFrom || undefined,
    uploaded_to: uploadedTo || undefined,
  };

  // re-summarise whenever the document filters change
  useEffect(() => {
    setLoading(true); setError('');
    bulkSummary(selection)
      .then(setSummary)
      .catch((e) => setError(apiErrorMessage(e, 'Could not prepare the export')))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docFilter, categories.join(','), uploadedFrom, uploadedTo]);

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    try { await fn(); toast('Download started', 'ok'); onClose(); }
    catch (e) { toast(apiErrorMessage(e, 'The export failed'), 'bad'); setBusy(''); }
  };

  /**
   * Queue the export instead of downloading it inline. Large selections are generated in the
   * background so the browser never waits on a long request.
   */
  const queue = async (action: ExportAction) => {
    setBusy('queue');
    try {
      const job = await queueExport(action, selection);
      toast(`Export ${job.export_id} queued — track it in the Download Centre`, 'ok');
      onClose();
      nav(deskPath('transactions/downloads'));
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not queue the export'), 'bad');
      setBusy('');
    }
  };

  /** Above this many transactions an inline download is a bad idea — queue it instead. */
  const shouldQueue = (summary?.transactions ?? 0) > 25;

  const toggleCategory = (name: string) =>
    setCategories((c) => (c.includes(name) ? c.filter((x) => x !== name) : [...c, name]));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
        <h3>{mode === 'data' ? 'Export transaction data' : 'Download transaction documents'}</h3>

        {mode === 'documents' && (
          <div className="bulk-options">
            <label className="report-field"><span>Include</span>
              <select value={docFilter} onChange={(e) => setDocFilter(e.target.value as BulkDocFilter)}>
                {DOC_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
            </label>
            <label className="report-field"><span>Uploaded from</span>
              <input type="date" value={uploadedFrom} onChange={(e) => setUploadedFrom(e.target.value)} />
            </label>
            <label className="report-field"><span>Uploaded to</span>
              <input type="date" value={uploadedTo} onChange={(e) => setUploadedTo(e.target.value)} />
            </label>
          </div>
        )}

        {loading ? <div className="muted">Checking what will be exported…</div> : error ? <div className="import-error">{error}</div> : summary && (
          <>
            <div className="import-summary">
              <div><strong>{summary.transactions}</strong><span>transactions</span></div>
              {mode === 'documents' ? (
                <>
                  <div className="good"><strong>{summary.documents_available}</strong><span>files available</span></div>
                  <div className="bad"><strong>{summary.documents_unavailable}</strong><span>unavailable</span></div>
                  <div className="warn"><strong>{summary.estimated_files}</strong><span>files in ZIP</span></div>
                </>
              ) : (
                <div className="good"><strong>{summary.documents_selected}</strong><span>documents described</span></div>
              )}
            </div>

            {mode === 'documents' && summary.categories.length > 0 && (
              <div className="bulk-categories">
                <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                  Categories {categories.length ? `(${categories.length} selected)` : '(all)'}
                </div>
                <div className="bulk-chiprow">
                  {summary.categories.map((c) => (
                    <button
                      key={c.name}
                      className={`bulk-chip${categories.includes(c.name) ? ' on' : ''}`}
                      onClick={() => toggleCategory(c.name)}
                    >
                      {c.name} <em>{c.count}</em>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {mode === 'documents' && summary.documents_unavailable > 0 && (
              <div className="reminder-warn">
                {summary.documents_unavailable} document{summary.documents_unavailable === 1 ? ' has' : 's have'} no
                usable file and will be skipped — each one is listed in the ZIP manifest with the reason.
              </div>
            )}
            {mode === 'documents' && summary.transactions_without_documents > 0 && (
              <div className="muted" style={{ fontSize: 12 }}>
                {summary.transactions_without_documents} transaction(s) have no files; each still gets a folder with a note.
              </div>
            )}
            {mode === 'data' && (
              <p className="muted" style={{ fontSize: 12 }}>
                Includes all structured transaction, financial, commission, condition and documentation data.
                The uploaded document files themselves are not included — use “Download Documents” for those.
                {' '}<strong>Download All Transactions</strong> gives one worksheet per transaction type, each with
                only the fields that apply to it. <strong>Export XLSX</strong> is the older layout with a sheet per
                area (deals, agents, clients, conditions, documents).
              </p>
            )}

            <div className="bulk-filters">
              {summary.filters.map((f, i) => <span key={i} className="pill">{f.label}: {f.value}</span>)}
            </div>
          </>
        )}

        {shouldQueue && (
          <p className="muted" style={{ fontSize: 12 }}>
            This selection is large, so it will be prepared in the background — you’ll be taken to the
            Download Centre to collect it.
          </p>
        )}

        <div className="modal-actions" style={{ flexWrap: 'wrap' }}>
          <button className="btn ghost" onClick={onClose} disabled={!!busy}>Cancel</button>
          {mode === 'data' ? (
            <>
              <button className="btn primary" disabled={!!busy || loading || !summary?.transactions}
                title="One worksheet per transaction type, grouped headers, only the fields that apply to each type"
                onClick={() => (shouldQueue ? queue('transaction-complete-xlsx') : run('complete', () => exportCompleteXlsx(selection)))}>
                {busy ? 'Preparing…' : 'Download All Transactions (XLSX)'}
              </button>
              <button className="btn ghost" disabled={!!busy || loading || !summary?.transactions}
                title="A single flat table across all types — for pivot tables and re-import, not the grouped layout"
                onClick={() => (shouldQueue ? queue('transaction-complete-csv') : run('completecsv', () => exportCompleteCsv(selection)))}>
                {busy ? 'Preparing…' : 'Flat CSV (all types, one table)'}
              </button>
              <button className="btn" disabled={!!busy || loading || !summary?.transactions}
                onClick={() => (shouldQueue ? queue('transaction-data-xlsx') : run('xlsx', () => exportTransactionsXlsx(selection)))}>
                {busy ? 'Preparing…' : 'Export XLSX'}
              </button>
              <button className="btn" disabled={!!busy || loading || !summary?.transactions}
                title="One flat table, one row per transaction — opens in any spreadsheet"
                onClick={() => (shouldQueue ? queue('transaction-data-csv') : run('csv', () => exportTransactionsCsv(selection)))}>
                {busy ? 'Preparing…' : 'Export CSV'}
              </button>
              <button className="btn" disabled={!!busy || loading || !summary?.transactions}
                onClick={() => (shouldQueue ? queue('transaction-data-pdf') : run('pdf', () => exportTransactionsPdf(selection)))}>
                {busy ? 'Preparing…' : 'Export PDF (one file)'}
              </button>
              <button className="btn ghost" disabled={!!busy || loading || !summary?.transactions}
                onClick={() => (shouldQueue ? queue('transaction-pdf-zip') : run('pdfzip', () => exportTransactionsPdf(selection, 'zip')))}>
                {busy ? 'Preparing…' : 'Export PDF (ZIP of separate files)'}
              </button>
            </>
          ) : (
            <button className="btn" disabled={!!busy || loading || !summary?.documents_available}
              onClick={() => (shouldQueue ? queue('documents-zip') : run('zip', () => downloadDocumentsZip(selection)))}>
              {busy ? 'Preparing…' : `Download ZIP (${summary?.documents_available ?? 0} file${(summary?.documents_available ?? 0) === 1 ? '' : 's'})`}
            </button>
          )}
          {!shouldQueue && (
            <button className="btn ghost" disabled={!!busy || loading || !summary?.transactions}
              onClick={() => queue(mode === 'documents' ? 'documents-zip' : 'transaction-data-xlsx')}
              title="Prepare in the background and collect it from the Download Centre">
              Queue in background
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
