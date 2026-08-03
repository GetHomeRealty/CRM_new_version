import { useNavigate } from 'react-router-dom';
import { crmPath } from './area';
import type { LeadFeedPage } from '../lib/leadsApi';
import type { LeadShowingRow, LeadTaskRow } from '../types';

/**
 * The two lead panels from the original combined dashboard, moved here when it split in two. They
 * belong to the CRM dashboard; they are in their own module rather than inline so the dashboard
 * file is about which numbers it shows, not about rendering a task row.
 *
 * BOTH TAKE A PAGE NOW, not a full array. Unpaginated, the tasks feed alone measured 1.67 MB in a
 * single response against a brokerage-sized database, and it grows for as long as the product is
 * used — every task ever created on every lead in the book, downloaded before an agent could see
 * the first row. The counts in the headings still describe the WHOLE set, because they come from
 * the server's own `summary`; deriving them from the rows on screen would silently make them a
 * different number.
 */

// -------------------------------------------------------------- lead tasks
const humanise = (v: string): string => v.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const priorityPill = (p: string): string => (p === 'high' ? 'bad' : p === 'low' ? 'ok' : 'warn');
const statusPill = (s: string): string => (s === 'completed' ? 'ok' : s === 'cancelled' ? 'bad' : 'info');

/** Prev / next for a feed panel. Renders nothing when there is only one page. */
function Pager({ meta, onPage }: { meta: LeadFeedPage<unknown>['meta']; onPage: (p: number) => void }) {
  if (meta.last_page <= 1) return null;
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, marginTop: 10 }}>
      <button className="btn ghost sm" type="button" disabled={meta.page <= 1} onClick={() => onPage(meta.page - 1)}>← Prev</button>
      <span className="muted" style={{ fontSize: 12 }}>
        Page {meta.page} of {meta.last_page} · {meta.total.toLocaleString()} in total
      </span>
      <button className="btn ghost sm" type="button" disabled={meta.page >= meta.last_page} onClick={() => onPage(meta.page + 1)}>Next →</button>
    </div>
  );
}

/**
 * Every task created against a lead, across all leads the user can see.
 *
 * The order comes from the server — open tasks first, then by due date — so anything overdue sits
 * at the top. Clicking a row opens the lead it belongs to, since the task is only editable there.
 */
export function LeadTasksPanel({ feed, onPage }: { feed: LeadFeedPage<LeadTaskRow> | null; onPage: (p: number) => void }) {
  const navigate = useNavigate();
  const todayIso = new Date().toISOString().slice(0, 10);

  if (!feed) return <div className="card"><div className="modal-sub">Lead Tasks</div><p className="help">Loading…</p></div>;
  const tasks = feed.data;
  // From the server, across every task in the book — not from this page of twenty-five.
  const { open, overdue, total } = feed.summary;

  return (
    <div className="card">
      <div className="modal-sub">
        Lead Tasks ({open} open of {total})
        {overdue > 0 && <span className="pill bad" style={{ marginLeft: 8 }}>{overdue} overdue</span>}
      </div>
      {total === 0 ? <p className="help">No tasks have been created on any lead yet.</p> : (
        <div className="lead-scroll">
          <table className="list-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Title</th>
                <th>Due Date</th>
                <th>Priority</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => {
                const overdue = t.status === 'pending' && t.due_date < todayIso;
                return (
                  <tr key={t.id} className="clickable" onClick={() => navigate(crmPath(`lead/${t.lead_id}`))}
                    title={`Open ${t.lead_name}`}>
                    <td><span className={`pill ${statusPill(t.status)}`}>{humanise(t.status)}</span></td>
                    <td>
                      {t.title}
                      <div className="muted" style={{ fontSize: 11 }}>{t.lead_name}</div>
                    </td>
                    <td className={overdue ? 'due-overdue' : undefined}>
                      {t.due_date}{overdue && <span className="pill bad" style={{ marginLeft: 6 }}>Overdue</span>}
                    </td>
                    <td><span className={`pill ${priorityPill(t.priority)}`}>{humanise(t.priority)}</span></td>
                    <td>{t.description ? t.description : <span className="muted">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Pager meta={feed.meta} onPage={onPage} />
    </div>
  );
}

/**
 * Every showing scheduled against a lead, across all leads the user can see. Soonest first (server
 * ordered). Clicking a row opens the lead it belongs to, where the showing is editable.
 */
export function LeadShowingsPanel({ feed, onPage }: { feed: LeadFeedPage<LeadShowingRow> | null; onPage: (p: number) => void }) {
  const navigate = useNavigate();
  const todayIso = new Date().toISOString().slice(0, 10);

  if (!feed) return <div className="card"><div className="modal-sub">Lead Showings</div><p className="help">Loading…</p></div>;
  const showings = feed.data;
  const { upcoming, total } = feed.summary;

  return (
    <div className="card">
      <div className="modal-sub">Lead Showings ({upcoming} upcoming of {total})</div>
      {total === 0 ? <p className="help">No showings have been scheduled on any lead yet.</p> : (
        <div className="lead-scroll">
          <table className="list-table">
            <thead>
              <tr>
                <th>Lead</th>
                <th>Status</th>
                <th>Property</th>
                <th>Date</th>
                <th>Time</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {showings.map((s) => {
                const past = s.showing_date < todayIso;
                return (
                  <tr key={s.id} className="clickable" onClick={() => navigate(crmPath(`lead/${s.lead_id}`))}
                    title={`Open ${s.lead_name}`}>
                    <td><strong>{s.lead_name || <span className="muted">—</span>}</strong></td>
                    <td><span className={`pill ${statusPill(s.status)}`}>{humanise(s.status)}</span></td>
                    <td>{s.property || <span className="muted">—</span>}</td>
                    <td className={past && s.status === 'scheduled' ? 'due-overdue' : undefined}>{s.showing_date}</td>
                    <td>{s.time || <span className="muted">—</span>}</td>
                    <td>{s.notes ? s.notes : <span className="muted">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Pager meta={feed.meta} onPage={onPage} />
    </div>
  );
}
