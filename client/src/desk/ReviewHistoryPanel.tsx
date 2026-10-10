import { useCallback, useEffect, useState } from 'react';
import { approveEditRequest, exportReviewHistory, listTransactionReviews, rejectEditRequest, type ReviewHistoryQuery, type TransactionReview } from '../lib/api';
import type { EditRequest } from '../types/transaction';
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

export default function ReviewHistoryPanel({
  txnId, editRequests = [], canDecide = false, onDecided,
}: {
  txnId: number;
  /**
   * The deal's edit requests, passed down rather than fetched here.
   *
   * The transaction payload already carries them, so a second request would be a second source of
   * truth for the same rows — and the page is what reloads after a decision anyway.
   */
  editRequests?: EditRequest[];
  /** Whether this person may approve. The server decides for real; this only hides a dead button. */
  canDecide?: boolean;
  /** Reload the deal AND this history: a decision changes both. */
  onDecided?: () => void | Promise<void>;
}) {
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
  const approvals = (
    <PendingCommissionApprovals requests={editRequests} canDecide={canDecide}
      onDecided={async () => { await onDecided?.(); await load(query); }} />
  );

  if (!loading && rows.length === 0 && !filtered) {
    // The approvals block is rendered here TOO. A deal with no review history is exactly the one
    // most likely to be carrying its first request, and returning early without it is why a
    // pending change appeared nowhere at all.
    return (
      <>
        {approvals}
        <div className="card">
          <div className="modal-h" style={{ fontSize: 14 }}><Icon name="clipboard" size={13} /> Review History</div>
          <div className="help">No review decisions have been recorded on this transaction yet.</div>
        </div>
      </>
    );
  }

  return (
    <>
    {approvals}
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
    </>
  );
}


/**
 * PENDING COMMISSION CHANGE REQUESTS, with the decision on them.
 *
 * WHY THIS LIVES HERE. Review History is where somebody goes to see what the office has decided
 * about a deal, so it is where they look for what is still waiting to be decided. It was not here
 * before, and neither was it anywhere else: the panel reads `transaction_reviews` (field-level
 * review decisions) and a change request is a `transaction_edit_requests` row — a different table
 * that this screen never asked for. The Financial modal's own approve/reject banner filters to
 * `scope === 'financial'`, so a commission request did not match that either. The result was a
 * workflow that could be raised from the UI and only decided through the API.
 *
 * IT RENDERS EVEN WITH NO REVIEW HISTORY. The panel returns early when a deal has never been
 * reviewed, which is exactly the deal most likely to be carrying its first request — so this is
 * drawn in both branches rather than inside the table below.
 *
 * NOT GATED ON VIEW MODE. Approving is a decision about somebody else's proposal, not an edit of
 * this screen's fields; a reviewer reading a deal in View Only is in the ordinary case, and
 * sending them to press Edit first would be asking them to do something unrelated to the choice
 * they are making. The server's own rule is unchanged and is the one that counts: Super Admin.
 */
function PendingCommissionApprovals({
  requests, canDecide, onDecided,
}: {
  requests: EditRequest[];
  /** Whether this person may decide. The server enforces it regardless; this hides a dead button. */
  canDecide: boolean;
  onDecided: () => void | Promise<void>;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState('');

  // Only what is still waiting. A decided request belongs to the history below, not here, which is
  // also what hides the buttons once somebody has pressed one.
  const pending = requests.filter((r) => r.status === 'pending' && r.proposed);
  if (!pending.length) return null;

  const decide = async (req: EditRequest, accept: boolean) => {
    if (busy) return;
    setBusy(req.id);
    setError('');
    try {
      await (accept ? approveEditRequest(req.id) : rejectEditRequest(req.id));
      toast(accept ? 'Commission change approved and applied.' : 'Commission change rejected.', 'ok');
      // Both the request and the history move on a decision, so the caller reloads both.
      await onDecided();
    } catch (e) {
      /*
       * On the card rather than only as a toast. The likeliest refusal here is a stale proposal —
       * the commission moved after it was raised — and that message tells the reviewer what to do
       * next, so it must stay on screen rather than fade.
       */
      setError(apiErrorMessage(e, accept ? 'The change could not be approved' : 'The change could not be rejected'));
    } finally {
      setBusy(0);
    }
  };

  return (
    <div className="card" style={{ borderLeft: '4px solid #d97706', marginBottom: 12 }} data-testid="pending-commission-approvals">
      <div className="modal-h" style={{ fontSize: 14 }}>
        <Icon name="clock" size={13} /> Awaiting approval
        <span className="sec-count">{pending.length}</span>
      </div>

      {pending.map((r) => (
        <div key={r.id} data-testid={`commission-request-${r.id}`}
          style={{ border: '1px solid var(--line-2)', borderRadius: 8, padding: 10, marginTop: 8 }}>
          <div className="muted" style={{ fontSize: 12 }}>
            Requested by <strong>{r.requested_by_name || 'someone'}</strong>
            {r.stamp ? ` · ${stamp(r.stamp)}` : ''}
          </div>
          {r.reason && <div style={{ fontSize: 12.5, marginTop: 4 }}>“{r.reason}”</div>}

          <table className="tbl" style={{ marginTop: 8 }}>
            <thead><tr><th>Field</th><th>Current</th><th>Requested</th></tr></thead>
            <tbody>
              {commissionRows(r).map((row) => (
                <tr key={row.label}>
                  <td>{row.label}</td>
                  <td data-testid={`req-${r.id}-current`}>{row.from}</td>
                  <td data-testid={`req-${r.id}-proposed`}><strong>{row.to}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>

          {error && <p className="help bad" role="alert" style={{ margin: '6px 0 0' }}>{error}</p>}

          {canDecide && (
            <div className="toolbar-row" style={{ gap: 8, marginTop: 10 }}>
              <button type="button" className="btn ok-btn" data-testid={`accept-${r.id}`}
                disabled={busy !== 0} onClick={() => void decide(r, true)}>
                <Icon name="check" size={13} /> {busy === r.id ? 'Working…' : 'Accept'}
              </button>
              <button type="button" className="btn" data-testid={`reject-${r.id}`}
                style={{ background: 'var(--bad)', borderColor: 'var(--bad)', color: '#fff' }}
                disabled={busy !== 0} onClick={() => void decide(r, false)}>
                <Icon name="close" size={13} /> Reject
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** Human labels for the keys a commission proposal can carry. */
const COMMISSION_LABELS: Record<string, string> = {
  comm_pct: 'Commission %',
  comm_amt: 'Commission Amount',
  precon_comm_pct: 'Commission %',
  precon_comm_amt_manual: 'Commission Amount',
  precon_comm_bonus: 'Bonus',
};

/**
 * One row per thing being changed — old beside new.
 *
 * `team` and `precon_terms` are lists, so they are flattened to the entries that actually differ:
 * a reviewer wants "Agent Comm % — Dana: 80 → 85", not two JSON blobs to compare by eye.
 */
function commissionRows(r: EditRequest): { label: string; from: string; to: string }[] {
  const proposed = (r.proposed ?? {}) as Record<string, unknown>;
  const baseline = (r.baseline ?? {}) as Record<string, unknown>;
  const show = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : String(v));
  const out: { label: string; from: string; to: string }[] = [];

  for (const [k, v] of Object.entries(proposed)) {
    if (k === 'team') {
      const was = (baseline.team ?? []) as Record<string, unknown>[];
      for (const m of (v as Record<string, unknown>[])) {
        const before = was.find((x) => x.name === m.name) ?? {};
        for (const f of ['agent_pct', 'brok_pct', 'split'] as const) {
          if (m[f] === undefined) continue;
          out.push({ label: `${f === 'agent_pct' ? 'Agent Comm %' : f === 'brok_pct' ? 'Brok Comm %' : 'Split %'} — ${String(m.name ?? '')}`,
            from: show(before[f]), to: show(m[f]) });
        }
      }
    } else if (k === 'precon_terms') {
      const was = (baseline.precon_terms ?? []) as Record<string, unknown>[];
      for (const t of (v as Record<string, unknown>[])) {
        const before = was.find((x) => Number(x.term_no) === Number(t.term_no)) ?? {};
        for (const f of ['pct', 'amt'] as const) {
          if (t[f] === undefined) continue;
          out.push({ label: `Term ${String(t.term_no)} ${f === 'pct' ? 'Commission %' : 'Commission Amount'}`,
            from: show(before[f]), to: show(t[f]) });
        }
      }
    } else {
      out.push({ label: COMMISSION_LABELS[k] ?? k, from: show(baseline[k]), to: show(v) });
    }
  }
  return out;
}
