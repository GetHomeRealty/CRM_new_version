import { useCallback, useEffect, useState } from 'react';
import { exportReviewHistory, listTransactionReviews, type ReviewHistoryQuery, type TransactionReview } from '../lib/api';
import ReviewThread from './ReviewThread';
import { apiErrorMessage } from '../lib/apiError';
import { useToast } from './toast';
import Icon from '../ui/Icon';

/**
 * The review history of one deal — every decision the office made about an agent's change, and what
 * became of it.
 *
 * Fetched on its own rather than arriving with the transaction: this list only grows, nobody needs
 * it before the deal can be read, and putting it in the main payload would make every transaction
 * load pay for it. It is also the reason the panel does its own paging and filtering.
 *
 * Read-only for everyone. Records are never edited or deleted here or anywhere else — the value of
 * the history is precisely that it cannot be tidied up afterwards.
 */

const DECISION_TONE: Record<string, string> = { Rejected: 'bad', Reviewed: 'ok' };
const RESOLUTION_TONE: Record<string, string> = { Open: 'warn', Corrected: 'info', Resolved: 'ok' };

/** Blank rather than a dash: an empty filter means "everything", and a dash reads like a value. */
const EMPTY: ReviewHistoryQuery = { resolution: '', decision: '', reviewer: '', agent: '', field: '', from: '', to: '', page: 1 };

const stamp = (iso: string | null): string => (iso ? iso.replace('T', ' ').slice(0, 16) : '—');

export default function ReviewHistoryPanel({ txnId }: { txnId: number }) {
  const toast = useToast();
  const [rows, setRows] = useState<TransactionReview[]>([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, last_page: 1, open_count: 0 });
  const [query, setQuery] = useState<ReviewHistoryQuery>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(true);
  const [showFilters, setShowFilters] = useState(false);
  const [exporting, setExporting] = useState('');
  /** Which item's discussion is open. One at a time — a page of open threads is unreadable. */
  const [openThread, setOpenThread] = useState<number | null>(null);

  const load = useCallback(async (q: ReviewHistoryQuery) => {
    setLoading(true);
    try {
      const page = await listTransactionReviews(txnId, q);
      setRows(page.data);
      setMeta({ total: page.meta.total, page: page.meta.page, last_page: page.meta.last_page, open_count: page.meta.open_count });
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not load the review history'), 'bad');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txnId]);

  useEffect(() => { void load(query); }, [load, query]);

  const set = (k: keyof ReviewHistoryQuery, v: string) => setQuery((q) => ({ ...q, [k]: v, page: 1 }));

  /** Export what is on screen, filters and all — but every page of it, not just this one. */
  const exportAs = async (format: 'xlsx' | 'pdf') => {
    setExporting(format);
    try {
      const { page: _page, per_page: _perPage, ...filters } = query;
      await exportReviewHistory(txnId, format, filters);
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not export the review history'), 'bad');
    } finally {
      setExporting('');
    }
  };
  const filtered = Object.entries(query).some(([k, v]) => k !== 'page' && v !== '' && v !== undefined);

  // Nothing has ever been reviewed and nothing is being filtered for — say so once, quietly, rather
  // than showing an empty table with controls.
  if (!loading && rows.length === 0 && !filtered) {
    return (
      <div className="card">
        <div className="modal-h" style={{ fontSize: 14 }}><Icon name="clipboard" size={13} /> Review History</div>
        <div className="help">No review decisions have been recorded on this transaction yet.</div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="rev-head">
        <button type="button" className="rev-toggle" onClick={() => setOpen((v) => !v)}>
          <Icon name="clipboard" size={13} /> Review History
          <span className="sec-count">{meta.total}</span>
          {meta.open_count > 0 && <span className="pill warn" style={{ fontSize: 10 }}>{meta.open_count} open</span>}
          <span className="muted" style={{ fontSize: 11 }}>{open ? '▾' : '▸'}</span>
        </button>
        {open && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button type="button" className="btn ghost sm" onClick={() => setShowFilters((v) => !v)}>
              <Icon name="filter" size={12} /> {showFilters ? 'Hide filters' : 'Filters'}
            </button>
            {/* Exports carry the filters the panel currently has applied — a report that disagrees
                with the screen it was taken from is worse than no report. */}
            <button type="button" className="btn ghost sm" disabled={exporting !== ''}
              onClick={() => void exportAs('xlsx')}>
              <Icon name="download" size={12} /> {exporting === 'xlsx' ? 'Preparing…' : 'Excel'}
            </button>
            <button type="button" className="btn ghost sm" disabled={exporting !== ''}
              onClick={() => void exportAs('pdf')}>
              <Icon name="download" size={12} /> {exporting === 'pdf' ? 'Preparing…' : 'PDF'}
            </button>
          </div>
        )}
      </div>

      {open && showFilters && (
        <div className="rev-filters">
          <select value={query.resolution ?? ''} onChange={(e) => set('resolution', e.target.value)}>
            <option value="">All resolutions</option>
            <option value="Open">Open issues</option>
            <option value="Corrected">Corrected</option>
            <option value="Resolved">Resolved</option>
          </select>
          <select value={query.decision ?? ''} onChange={(e) => set('decision', e.target.value)}>
            <option value="">All decisions</option>
            <option value="Rejected">Rejected</option>
            <option value="Reviewed">Reviewed</option>
          </select>
          <input placeholder="Field" value={query.field ?? ''} onChange={(e) => set('field', e.target.value)} />
          <input placeholder="Reviewer" value={query.reviewer ?? ''} onChange={(e) => set('reviewer', e.target.value)} />
          <input placeholder="Agent" value={query.agent ?? ''} onChange={(e) => set('agent', e.target.value)} />
          <input type="date" title="From" value={query.from ?? ''} onChange={(e) => set('from', e.target.value)} />
          <input type="date" title="To" value={query.to ?? ''} onChange={(e) => set('to', e.target.value)} />
          {filtered && <button type="button" className="btn ghost sm" onClick={() => setQuery(EMPTY)}>Clear</button>}
        </div>
      )}

      {open && (loading ? (
        <div className="help">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="help">No review records match these filters.</div>
      ) : (
        <>
          <div className="rev-list">
            {rows.map((r) => (
              <div key={r.id} className="rev-row">
                <div className="rev-row-top">
                  <span className={`pill ${DECISION_TONE[r.decision] ?? 'info'}`} style={{ fontSize: 10 }}>{r.decision}</span>
                  <span className={`pill ${RESOLUTION_TONE[r.resolution_status] ?? 'info'}`} style={{ fontSize: 10 }}>{r.resolution_status}</span>
                  <strong className="rev-field">{r.field_label ?? 'All agent changes'}</strong>
                  <span className="rev-when">{stamp(r.created_at)}</span>
                </div>

                {(r.old_value || r.new_value) && (
                  <div className="rev-values">
                    <span className="rev-old">{r.old_value || '—'}</span>
                    <span className="rev-arrow">→</span>
                    <span className="rev-new">{r.new_value || '—'}</span>
                  </div>
                )}

                {r.reason && (
                  <div className="rev-reason">
                    <span className="muted">{r.decision === 'Rejected' ? 'Reason: ' : 'Note: '}</span>{r.reason}
                  </div>
                )}

                {/* Says whether the old value was put back, so nobody has to guess why the field
                    still shows the agent's number. */}
                {r.auto_revert_result && <div className="rev-note">{r.auto_revert_result}</div>}

                <div className="rev-meta">
                  <span>Reviewed by <strong>{r.actor_name ?? '—'}</strong></span>
                  {r.agent_name && <span>· Agent <strong>{r.agent_name}</strong></span>}
                  {r.corrected_at && <span>· Corrected by <strong>{r.corrected_by ?? '—'}</strong> on {stamp(r.corrected_at)}</span>}
                  {r.resolved_at && <span>· Resolved by <strong>{r.resolved_by ?? '—'}</strong> on {stamp(r.resolved_at)}</span>}
                  <button type="button" className="rev-thread-toggle" onClick={() => setOpenThread((t) => (t === r.id ? null : r.id))}>
                    <Icon name="message" size={11} /> {openThread === r.id ? 'Hide discussion' : 'Discuss'}
                  </button>
                </div>

                {/* The conversation about this item specifically — see ReviewThread. */}
                {openThread === r.id && <ReviewThread reviewId={r.id} />}
              </div>
            ))}
          </div>

          {meta.last_page > 1 && (
            <div className="rev-pager">
              <button type="button" className="btn ghost sm" disabled={meta.page <= 1}
                onClick={() => setQuery((q) => ({ ...q, page: (q.page ?? 1) - 1 }))}>‹ Newer</button>
              <span className="muted" style={{ fontSize: 12 }}>Page {meta.page} of {meta.last_page}</span>
              <button type="button" className="btn ghost sm" disabled={meta.page >= meta.last_page}
                onClick={() => setQuery((q) => ({ ...q, page: (q.page ?? 1) + 1 }))}>Older ›</button>
            </div>
          )}
        </>
      ))}
    </div>
  );
}
