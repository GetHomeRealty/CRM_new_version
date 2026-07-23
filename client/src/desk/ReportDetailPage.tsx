import { useEffect, useMemo, useState, useCallback, Fragment } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { reportColumns, reportFilterOptions, runReport, exportReport, reportDocuments } from '../lib/reportsApi';
import { apiErrorMessage } from '../lib/apiError';
import { formatCurrency } from './format';
import { useToast } from './toast';
import { useAuth } from '../context/AuthContext';
import type {
  ReportMeta, ReportResult, ReportFilterOptions, ReportFilterValues, ReportColumn,
  ReportSearchBody, ReportDocuments, ReminderScope, ReminderPreview,
} from '../types';
import { previewReminders, sendReminders } from '../lib/reportsApi';

const PER_PAGE_OPTIONS = [25, 50, 100, 200];

export default function ReportDetailPage() {
  const { reportType = '' } = useParams();
  const toast = useToast();
  const nav = useNavigate();
  const { user } = useAuth();
  const isAgent = (user?.role ?? 'agent') === 'agent';

  const [meta, setMeta] = useState<ReportMeta | null>(null);
  const [options, setOptions] = useState<ReportFilterOptions | null>(null);
  const [draft, setDraft] = useState<ReportFilterValues>({});
  const [applied, setApplied] = useState<ReportFilterValues>({});
  const [selectedCols, setSelectedCols] = useState<string[] | null>(null);
  const [sections, setSections] = useState<string[] | null>(null);
  const [result, setResult] = useState<ReportResult | null>(null);
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(25);
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [showCustomize, setShowCustomize] = useState(false);
  const [exporting, setExporting] = useState('');
  // expanded deal → its documents (documentation reports only)
  const [expanded, setExpanded] = useState<number | null>(null);
  const [docs, setDocs] = useState<ReportDocuments | null>(null);
  const [docsLoading, setDocsLoading] = useState(false);

  // ---- row selection + bulk reminder actions (documentation reports) ----
  const [selected, setSelected] = useState<number[]>([]);
  const [reminder, setReminder] = useState<{ scope: ReminderScope; ids: number[]; docIds: number[] } | null>(null);

  /** Reports whose rows represent documentation and therefore support reminders. */
  const selectable = !!meta?.columns.some((c) => c.key === 'txn_id') && meta?.custom !== 'reminders';
  const pageTxnIds = useMemo(
    () => [...new Set((result?.rows ?? []).map((r) => Number(r.txn_id)).filter((n) => Number.isInteger(n) && n > 0))],
    [result],
  );
  const allPageSelected = pageTxnIds.length > 0 && pageTxnIds.every((id) => selected.includes(id));
  const toggleRowSel = (id: number) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const togglePageSel = () => setSelected((s) => (allPageSelected ? s.filter((id) => !pageTxnIds.includes(id)) : [...new Set([...s, ...pageTxnIds])]));

  const toggleExpand = useCallback((txnId: number) => {
    if (expanded === txnId) { setExpanded(null); setDocs(null); return; }
    setExpanded(txnId); setDocs(null); setDocsLoading(true);
    reportDocuments(txnId)
      .then(setDocs)
      .catch((e) => toast(apiErrorMessage(e, 'Could not load documents'), 'bad'))
      .finally(() => setDocsLoading(false));
  }, [expanded, toast]);

  // load report metadata + filter options whenever the report changes
  useEffect(() => {
    setLoading(true); setError(''); setMeta(null); setResult(null);
    setDraft({}); setApplied({}); setSelectedCols(null); setSections(null); setSort(null); setPage(1);
    Promise.all([reportColumns(reportType), reportFilterOptions()])
      .then(([m, o]) => { setMeta(m); setOptions(o); })
      .catch((e) => setError(apiErrorMessage(e, 'Could not load report')))
      .finally(() => setLoading(false));
  }, [reportType]);

  const body = useMemo<ReportSearchBody>(() => ({
    filters: { ...applied, ...(sections ? { sections } : {}) },
    page, per_page: perPage,
    sort: sort?.key, dir: sort?.dir,
    columns: selectedCols ?? undefined,
  }), [applied, sections, page, perPage, sort, selectedCols]);

  // run only on explicit changes (Apply/Reset/page/sort/customize) — never on draft edits
  const run = useCallback(() => {
    if (!meta) return;
    setRunning(true); setError('');
    runReport(reportType, body)
      .then(setResult)
      .catch((e) => { const m = apiErrorMessage(e, 'Could not run report'); setError(m); toast(m, 'bad'); })
      .finally(() => setRunning(false));
  }, [meta, reportType, body]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { run(); }, [run]);

  const setD = (k: keyof ReportFilterValues, v: unknown) => setDraft((p) => ({ ...p, [k]: v === '' || v == null ? undefined : v }));

  const apply = () => { setApplied(draft); setPage(1); };
  const reset = () => { setDraft({}); setApplied({}); setSelectedCols(null); setSections(null); setSort(null); setPage(1); };
  const toggleSort = (c: ReportColumn) => { if (!c.sortable) return; setSort((s) => (s?.key === c.key ? { key: c.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: c.key, dir: 'asc' })); setPage(1); };

  const doExport = async (fmt: 'xlsx' | 'pdf') => {
    setExporting(fmt);
    try { await exportReport(reportType, fmt, { ...body, page: undefined, per_page: undefined }); toast(`${fmt.toUpperCase()} exported`, 'ok'); }
    catch (e) { toast(apiErrorMessage(e, 'Export failed'), 'bad'); }
    finally { setExporting(''); }
  };

  if (loading) return <div className="centered">Loading report…</div>;
  if (error && !meta) return <div className="card"><button className="btn ghost sm" onClick={() => nav('/app/reports')}>← Reports</button><div style={{ color: 'var(--bad)', marginTop: 10 }}>{error}</div></div>;
  if (!meta) return null;

  const cols = result?.columns ?? meta.columns.filter((c) => c.default);
  const totals = result?.totals ?? {};

  /** Column count including the selection checkbox column, for full-width cells. */
  const span = cols.length + (selectable ? 1 : 0);

  /** Per-row selection checkbox (selects the deal the row belongs to). */
  const selBox = (row: Record<string, string | number | null>) => {
    const id = Number(row.txn_id);
    if (!Number.isInteger(id) || id <= 0) return null;
    return <input type="checkbox" checked={selected.includes(id)} onChange={() => toggleRowSel(id)} onClick={(e) => e.stopPropagation()} />;
  };

  /** Column header row — rendered once in <thead>, or once per section for grouped reports. */
  const headerRow = (key?: string) => (
    <tr key={key} className={key ? 'report-head-row' : undefined}>{[
      ...(selectable ? [(
        <th key="__sel" className="report-sel-col">
          <input type="checkbox" checked={allPageSelected} onChange={togglePageSel} title="Select all rows on this page" />
        </th>
      )] : []),
      ...cols.map((c) => {
      const canSort = c.sortable && !meta.noSort;
      const active = sort?.key === c.key;
      return (
        <th key={c.key} className={`${canSort ? 'sortable ' : ''}${cellClass(c)}`} onClick={() => canSort && toggleSort(c)} title={canSort ? 'Sort' : undefined}>
          {c.label}
          {canSort && <span className={`sort-ind${active ? ' on' : ''}`}>{active ? (sort!.dir === 'asc' ? '▲' : '▼') : '⇅'}</span>}
        </th>
      );
    })]}</tr>
  );

  return (
    <>
      {/* header */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn ghost sm" onClick={() => nav('/app/reports')}>← Reports</button>
          <div className="modal-h" style={{ fontSize: 14, margin: 0, flex: 1 }}>{meta.name}</div>
        </div>
        <div className="modal-sub" style={{ marginTop: 4 }}>{meta.description}</div>
        {result && result.applied_filters.length > 0 && (
          <div className="report-chips">
            {result.applied_filters.map((f, i) => <span key={i} className="pill info">{f.label}: {f.value}</span>)}
          </div>
        )}
      </div>

      {/* filters */}
      <div className="card report-filters">
        <div className="toolbar-row">
          <label className="report-field" style={{ flex: '1 1 220px' }}><span>Search</span>
            <input placeholder="Property, trade no., agent…" value={draft.search ?? ''} onChange={(e) => setD('search', e.target.value)} />
          </label>
          <div className="report-field"><span>Deal Type</span>
            <MultiSelect label="All" options={options?.deal_type ?? []} value={draft.deal_type ?? []} onChange={(v) => setD('deal_type', v)} />
          </div>
          {!isAgent && <div className="report-field"><span>Agent</span>
            <MultiSelect label="All" options={options?.agent ?? []} value={draft.agent ?? []} onChange={(v) => setD('agent', v)} />
          </div>}
          <div className="report-field"><span>Payment Type</span>
            <MultiSelect label="All" options={options?.payment_type ?? []} value={draft.payment_type ?? []} onChange={(v) => setD('payment_type', v)} />
          </div>
          <div className="report-actions">
            <button className="btn primary sm" onClick={apply}>Apply Filters</button>
            <button className="btn ghost sm" onClick={reset}>Reset</button>
            <button className="btn ghost sm" onClick={() => setShowCustomize(true)}>⚙ Customize Fields</button>
            <button className="btn ghost sm" disabled={!!exporting || !result?.total_count} onClick={() => doExport('xlsx')}>{exporting === 'xlsx' ? '…' : '⬇ XLSX'}</button>
            <button className="btn ghost sm" disabled={!!exporting || !result?.total_count} onClick={() => doExport('pdf')}>{exporting === 'pdf' ? '…' : '⬇ PDF'}</button>
          </div>
        </div>
        <div className="toolbar-row report-row2">
          <label className="report-field"><span>Offer From</span><input type="date" value={draft.offer_date_from ?? ''} onChange={(e) => setD('offer_date_from', e.target.value)} /></label>
          <label className="report-field"><span>Offer To</span><input type="date" value={draft.offer_date_to ?? ''} onChange={(e) => setD('offer_date_to', e.target.value)} /></label>
          <label className="report-field"><span>Closing From</span><input type="date" value={draft.closing_date_from ?? ''} onChange={(e) => setD('closing_date_from', e.target.value)} /></label>
          <label className="report-field"><span>Closing To</span><input type="date" value={draft.closing_date_to ?? ''} onChange={(e) => setD('closing_date_to', e.target.value)} /></label>
          <label className="report-field"><span>Closing Year</span>
            <select value={String(draft.year ?? '')} onChange={(e) => setD('year', e.target.value)}>
              <option value="">All</option>
              {(options?.year ?? []).map((y) => <option key={y.value} value={y.value}>{y.label}</option>)}
            </select>
          </label>
          <label className="report-field"><span>Payout Status</span>
            <select value={draft.payout_status ?? ''} onChange={(e) => setD('payout_status', e.target.value)}>
              <option value="">Any</option>
              {(options?.payout_status ?? []).map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
          {/* report-specific filters */}
          {meta.filters.map((f) => <ReportFilter key={f.key} def={f} options={options} value={draft} setD={setD} />)}
        </div>
      </div>

      {/* bulk action bar — appears once rows are selected */}
      {selectable && selected.length > 0 && (
        <div className="report-bulkbar">
          <strong>{selected.length}</strong> deal{selected.length === 1 ? '' : 's'} selected
          <span className="spacer" />
          <button className="btn sm" onClick={() => setReminder({ scope: 'pending', ids: selected, docIds: [] })}>Send Pending Reminders</button>
          <button className="btn sm" onClick={() => setReminder({ scope: 'invalid', ids: selected, docIds: [] })}>Send Invalid Reminders</button>
          <button className="btn sm" onClick={() => setReminder({ scope: 'all', ids: selected, docIds: [] })}>Send All Reminders</button>
          <button className="btn ghost sm" onClick={() => setSelected([])}>Clear</button>
        </div>
      )}

      {/* results */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="report-table-wrap">
          <table className="list-table report-table">
            {/* section-grouped reports repeat the headers inside each section instead */}
            {!result?.sections && <thead>{headerRow()}</thead>}
            <tbody>
              {running && !result ? (
                <tr><td colSpan={span} className="centered">Loading…</td></tr>
              ) : !result || result.rows.length === 0 ? (
                <tr><td colSpan={span} style={{ textAlign: 'center', color: 'var(--muted)', padding: 24 }}>No records found for the selected filters.</td></tr>
              ) : result.sections ? (
                // section-grouped: a heading row per section, its rows, then its subtotal
                result.sections.map((s) => (
                  <Fragment key={s.key}>
                    <tr className="report-section-row"><td colSpan={span}>{s.label}<span className="sec-count">{s.count ?? 0} record{(s.count ?? 0) === 1 ? '' : 's'}</span></td></tr>
                    {headerRow('head-' + s.key)}
                    {result.rows.filter((r) => r.section === s.key).map((row, ri) => (
                      <tr key={s.key + ri}>
                        {selectable && <td className="report-sel-col">{selBox(row)}</td>}
                        {cols.map((c) => <td key={c.key} className={cellClass(c)} title={tooltip(row[c.key], c)}>{fmt(row[c.key], c)}</td>)}
                      </tr>
                    ))}
                    {(s.count ?? 0) > 0 && s.totals && (
                      <tr className="report-subtotal-row">
                        {selectable && <td className="report-sel-col" />}
                        {cols.map((c, i) => <td key={c.key} className={cellClass(c)}>{footer(c, s.totals!, i === 0, s.count ?? 0, s.label + ' total')}</td>)}
                      </tr>
                    )}
                  </Fragment>
                ))
              ) : result.rows.map((row, ri) => {
                const txnId = meta.expandable ? Number(row.txn_id) : 0;
                const isOpen = !!txnId && expanded === txnId;
                return (
                  <Fragment key={ri}>
                    <tr
                      className={`${meta.expandable ? 'report-expandable' : ''}${isOpen ? ' open' : ''}`}
                      onClick={meta.expandable && txnId ? () => toggleExpand(txnId) : undefined}
                      title={meta.expandable ? 'Show this deal’s documents' : undefined}
                    >
                      {selectable && <td className="report-sel-col" onClick={(e) => e.stopPropagation()}>{selBox(row)}</td>}
                      {cols.map((c, ci) => (
                        <td key={c.key} className={cellClass(c)} title={tooltip(row[c.key], c)}>
                          {meta.expandable && ci === 0 && <span className="report-expand-ind">{isOpen ? '▾' : '▸'}</span>}
                          {fmt(row[c.key], c)}
                        </td>
                      ))}
                    </tr>
                    {isOpen && (
                      <tr className="report-detail-row">
                        <td colSpan={span}>
                          {docsLoading ? <div className="muted">Loading documents…</div>
                            : <DocumentPanel data={docs} onRemind={(docIds, scope) => setReminder({ scope, ids: [txnId], docIds })} />}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
            {result && result.rows.length > 0 && (
              <tfoot>
                <tr className="report-totals">
                  {selectable && <td className="report-sel-col" />}
                  {cols.map((c, i) => <td key={c.key} className={cellClass(c)}>{footer(c, totals, i === 0, result.total_count)}</td>)}
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        <div className="report-pager">
          <div className="pg-left"><strong>{result?.total_count ?? 0}</strong> record{(result?.total_count ?? 0) === 1 ? '' : 's'}{running && <span className="muted"> · loading…</span>}</div>
          <div className="pg-mid">
            <button className="btn ghost sm" disabled={page <= 1 || !!result?.sections} onClick={() => setPage((p) => Math.max(1, p - 1))}>← Prev</button>
            <span>Page {result?.page ?? 1} of {result?.last_page ?? 1}</span>
            <button className="btn ghost sm" disabled={!result || page >= result.last_page} onClick={() => setPage((p) => p + 1)}>Next →</button>
          </div>
          <div className="pg-right"><span>Rows</span>
            <select value={perPage} onChange={(e) => { setPerPage(Number(e.target.value)); setPage(1); }} disabled={!!result?.sections}>{PER_PAGE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}</select>
          </div>
        </div>
      </div>

      {showCustomize && (
        <CustomizeModal
          meta={meta}
          selected={selectedCols ?? meta.columns.filter((c) => c.default).map((c) => c.key)}
          sections={sections ?? meta.sections?.map((s) => s.key) ?? []}
          onCancel={() => setShowCustomize(false)}
          onApply={(newCols, newSections) => { setSelectedCols(newCols); if (meta.sections) setSections(newSections); setPage(1); setShowCustomize(false); }}
        />
      )}

      {reminder && (
        <ReminderModal
          request={{ transaction_ids: reminder.ids, document_ids: reminder.docIds, scope: reminder.scope }}
          onClose={() => setReminder(null)}
          onSent={(r) => {
            setReminder(null);
            toast(`${r.sent} reminder${r.sent === 1 ? '' : 's'} sent (${r.documents} document${r.documents === 1 ? '' : 's'})`
              + (r.failed ? ` · ${r.failed} failed` : '') + (r.skipped ? ` · ${r.skipped} skipped` : ''), r.failed ? 'bad' : 'ok');
            run();
          }}
        />
      )}
    </>
  );
}

/**
 * Reminder confirmation. Always previews first so the user sees the applicable document
 * count, the recipients, anything that will be skipped, and any document that was already
 * reminded about recently — nothing is sent until they confirm.
 */
function ReminderModal({ request, onClose, onSent }: {
  request: { transaction_ids: number[]; document_ids: number[]; scope: ReminderScope };
  onClose: () => void;
  onSent: (r: { sent: number; failed: number; skipped: number; documents: number }) => void;
}) {
  const toast = useToast();
  const [preview, setPreview] = useState<ReminderPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    setLoading(true);
    previewReminders(request)
      .then(setPreview)
      .catch((e) => setErr(apiErrorMessage(e, 'Could not prepare the reminder')))
      .finally(() => setLoading(false));
    // the request is fixed for the lifetime of the modal
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const label = request.scope === 'invalid' ? 'invalid' : request.scope === 'pending' ? 'pending' : 'outstanding';
  const send = async () => {
    setSending(true);
    try { onSent(await sendReminders(request)); }
    catch (e) { toast(apiErrorMessage(e, 'Could not send reminders'), 'bad'); setSending(false); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 620 }} onClick={(e) => e.stopPropagation()}>
        <h3>Send {label} documentation reminders</h3>
        {loading ? <div className="muted">Checking what will be sent…</div> : err ? <div style={{ color: 'var(--bad)' }}>{err}</div> : preview && (
          <>
            <div className="reminder-summary">
              <div><strong>{preview.deals}</strong><span>deal{preview.deals === 1 ? '' : 's'}</span></div>
              <div><strong>{preview.documents}</strong><span>document{preview.documents === 1 ? '' : 's'}</span></div>
              <div><strong>{preview.pending}</strong><span>pending</span></div>
              <div><strong>{preview.invalid}</strong><span>invalid</span></div>
            </div>
            {preview.recipients.length > 0 && (
              <p className="muted" style={{ fontSize: 13 }}>To: {preview.recipients.join(', ')}</p>
            )}
            {preview.duplicate_warnings.length > 0 && (
              <div className="reminder-warn">
                <strong>Already reminded in the last 24 hours:</strong>
                <ul>{preview.duplicate_warnings.slice(0, 6).map((d, i) => <li key={i}>{d.trade_no} — {d.document}</li>)}</ul>
                {preview.duplicate_warnings.length > 6 && <div className="muted">…and {preview.duplicate_warnings.length - 6} more</div>}
              </div>
            )}
            {preview.missing_recipients.length > 0 && (
              <div className="reminder-skip">
                <strong>Will be skipped:</strong>
                <ul>{preview.missing_recipients.slice(0, 6).map((m, i) => <li key={i}>{m.trade_no} — {m.reason}</li>)}</ul>
                {preview.missing_recipients.length > 6 && <div className="muted">…and {preview.missing_recipients.length - 6} more</div>}
              </div>
            )}
            <p className="muted" style={{ fontSize: 12 }}>One message is sent per deal — documents from different deals are never combined.</p>
          </>
        )}
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose} disabled={sending}>Cancel</button>
          <button className="btn" onClick={send} disabled={sending || loading || !preview || preview.deals === 0}>
            {sending ? 'Sending…' : `Send ${preview?.documents ?? 0} reminder${(preview?.documents ?? 0) === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- cell formatting ----
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "2026-07-21" → "July 21, 2026" (app-wide report date format). */
export function longDate(v: unknown): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ''));
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : String(v ?? '');
}
function fmt(v: string | number | null, c: ReportColumn): string {
  if (v === null || v === undefined || v === '') return '—';
  if (c.type === 'currency') return formatCurrency(Number(v));
  if (c.type === 'percent') return Number(v).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%';
  if (c.type === 'date' || c.type === 'datetime') return longDate(v);
  return String(v);
}
function tooltip(v: string | number | null, c: ReportColumn): string | undefined { return c.type === 'text' && v ? String(v) : undefined; }
/** Everything is left-aligned; property + date columns don't wrap (property sized to its text). */
function cellClass(c: ReportColumn): string {
  if (c.key === 'property') return 'col-property';
  if (c.type === 'date' || c.type === 'datetime') return 'col-date';
  return '';
}
function footer(c: ReportColumn, totals: Record<string, number>, first: boolean, count: number, label?: string): string {
  if (first) return label ? `${label} (${count})` : `Totals (${count})`;
  if (c.total && totals[c.key] !== undefined) return formatCurrency(totals[c.key]);
  if (c.average && totals[c.key] !== undefined) return 'Avg ' + Number(totals[c.key]).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%';
  return '';
}

// ---- report-specific filter renderer ----
/**
 * The documents of one expanded deal. Pending, invalid and valid are rendered as separate
 * blocks — never merged into one list — so outstanding items are unambiguous.
 */
function DocumentPanel({ data, onRemind }: {
  data: ReportDocuments | null;
  /** documentIds: specific documents, or [] for every document in that status on this deal. */
  onRemind?: (documentIds: number[], scope: ReminderScope) => void;
}) {
  if (!data) return <div className="muted">No documents to show.</div>;
  const groups = data.groups.filter((g) => g.documents.length > 0);
  if (!groups.length) return <div className="muted">This deal has no documents on file.</div>;
  return (
    <div className="report-docs">
      {groups.map((g) => (
        <div key={g.key} className={`report-docs-group ${g.key}`}>
          <div className="report-docs-head">
            {g.label}<span className="sec-count">{g.documents.length}</span>
            {/* consolidated reminder for every document in this status, on this deal only */}
            {onRemind && g.key !== 'valid' && (
              <button
                className="btn ghost sm"
                style={{ marginLeft: 10 }}
                onClick={() => onRemind([], g.key as ReminderScope)}
                title={`Send one reminder covering all ${g.label.toLowerCase()} in this deal`}
              >
                Remind for all {g.documents.length}
              </button>
            )}
          </div>
          <table className="report-docs-table">
            <thead>
              <tr>
                <th>Document</th><th>Category</th><th>Status</th><th>Required</th>
                <th>Uploaded</th><th>Reviewed</th>
                {g.key === 'invalid' && <th>Invalid Reason</th>}
                <th>Reminder</th>
                {onRemind && g.key !== 'valid' && <th />}
              </tr>
            </thead>
            <tbody>
              {g.documents.map((d) => (
                <tr key={d.id}>
                  <td>{d.name}</td>
                  <td>{d.category}</td>
                  <td><span className={`doc-pill ${d.status.toLowerCase()}`}>{d.status}</span></td>
                  <td>{d.required}</td>
                  <td className="col-date">{longDate(d.uploaded_at) || '—'}</td>
                  <td className="col-date">{longDate(d.reviewed_at) || '—'}</td>
                  {g.key === 'invalid' && <td>{d.invalid_reason ?? '—'}</td>}
                  <td>{d.reminder_status}</td>
                  {onRemind && g.key !== 'valid' && (
                    <td><button className="btn ghost sm" onClick={() => onRemind([d.id], g.key as ReminderScope)}>Send Reminder</button></td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function ReportFilter({ def, options, value, setD }: { def: ReportMeta['filters'][number]; options: ReportFilterOptions | null; value: ReportFilterValues; setD: (k: keyof ReportFilterValues, v: unknown) => void }) {
  const key = def.key as keyof ReportFilterValues;
  if (def.type === 'year') return <label className="report-field"><span>{def.label}</span><input type="number" placeholder="YYYY" value={(value[key] as number) ?? ''} onChange={(e) => setD(key, e.target.value)} /></label>;
  if (def.type === 'select') return <label className="report-field"><span>{def.label}</span><select value={(value[key] as string) ?? ''} onChange={(e) => setD(key, e.target.value)}>{(def.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>;
  if (def.type === 'multiselect') {
    const opts = def.dynamic && options ? (options as unknown as Record<string, { value: string; label: string }[]>)[def.key] ?? [] : def.options ?? [];
    return <div className="report-field"><span>{def.label}</span><MultiSelect label="All" options={opts} value={(value[key] as string[]) ?? []} onChange={(v) => setD(key, v)} /></div>;
  }
  return null;
}

// ---- compact multiselect (button + checkbox dropdown) ----
function MultiSelect({ label, options, value, onChange }: { label: string; options: { value: string; label: string }[]; value: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <div className="report-ms">
      <button type="button" className="report-ms-btn" onClick={() => setOpen((o) => !o)} title={value.join(', ') || label}>
        {value.length === 0 ? label : value.length === 1 ? value[0] : `${value.length} selected`}
      </button>
      {open && (
        <>
          <div className="report-ms-backdrop" onClick={() => setOpen(false)} />
          <div className="report-ms-menu">
            {options.length === 0 ? <div className="muted" style={{ padding: 6 }}>No options</div> : options.map((o) => (
              <label key={o.value} className="report-ms-item" title={o.label}>
                <input type="checkbox" checked={value.includes(o.value)} onChange={() => toggle(o.value)} />
                <span>{o.label}</span>
              </label>
            ))}
            {value.length > 0 && <button className="btn ghost sm" style={{ margin: 6 }} onClick={() => onChange([])}>Clear</button>}
          </div>
        </>
      )}
    </div>
  );
}

// ---- customize-fields modal ----
function CustomizeModal({ meta, selected, sections, onCancel, onApply }: { meta: ReportMeta; selected: string[]; sections: string[]; onCancel: () => void; onApply: (cols: string[], sections: string[]) => void }) {
  const [cols, setCols] = useState<string[]>(selected);
  const [secs, setSecs] = useState<string[]>(sections);
  const toggle = (k: string) => setCols((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));
  const toggleSec = (k: string) => setSecs((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));
  const orderKeys = meta.columns.map((c) => c.key);
  const ordered = () => orderKeys.filter((k) => cols.includes(k));
  return (
    <div className="overlay open" onClick={onCancel}>
      <div className="modal lg" onClick={(e) => e.stopPropagation()}>
        <div className="modal-h">Customize Fields — {meta.name}</div>
        <button className="close" onClick={onCancel}>×</button>
        <div className="report-cz-actions">
          <button className="btn ghost sm" onClick={() => setCols(orderKeys)}>Select All</button>
          <button className="btn ghost sm" onClick={() => setCols(meta.columns.filter((c) => c.mandatory).map((c) => c.key))}>Clear All</button>
          <button className="btn ghost sm" onClick={() => setCols(meta.columns.filter((c) => c.default).map((c) => c.key))}>Restore Defaults</button>
        </div>
        <div className="report-cz-grid">
          {meta.columns.map((c) => (
            <label key={c.key} className={`report-cz-item${c.mandatory ? ' mand' : ''}`} title={c.label}>
              <input type="checkbox" checked={cols.includes(c.key)} disabled={c.mandatory} onChange={() => toggle(c.key)} />
              <span>{c.label}{c.mandatory ? ' *' : ''}</span>
            </label>
          ))}
        </div>
        {meta.sections && meta.sections.length > 0 && (
          <>
            <div className="modal-sub" style={{ marginTop: 12 }}>Report Sections / Categories</div>
            <div className="report-cz-grid">
              {meta.sections.map((s) => (
                <label key={s.key} className="report-cz-item" title={s.label}>
                  <input type="checkbox" checked={secs.includes(s.key)} onChange={() => toggleSec(s.key)} />
                  <span>{s.label}</span>
                </label>
              ))}
            </div>
          </>
        )}
        <div className="actions" style={{ marginTop: 14 }}>
          <button className="btn ghost" onClick={onCancel}>Cancel</button>
          <button className="btn primary" onClick={() => onApply(ordered(), secs)}>Apply</button>
        </div>
      </div>
    </div>
  );
}
