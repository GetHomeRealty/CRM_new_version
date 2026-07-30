import { useNavigate } from 'react-router-dom';
import { crmPath } from './area';
import type { LeadShowingRow, LeadTaskRow } from '../types';

/**
 * The two lead panels from the original combined dashboard, moved here unchanged when it split in
 * two. They belong to the CRM dashboard; they are in their own module rather than inline so the
 * dashboard file is about which numbers it shows, not about rendering a task row.
 */

// -------------------------------------------------------------- lead tasks
const humanise = (v: string): string => v.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const priorityPill = (p: string): string => (p === 'high' ? 'bad' : p === 'low' ? 'ok' : 'warn');
const statusPill = (s: string): string => (s === 'completed' ? 'ok' : s === 'cancelled' ? 'bad' : 'info');

/**
 * Every task created against a lead, across all leads the user can see.
 *
 * The order comes from the server — open tasks first, then by due date — so anything overdue sits
 * at the top. Clicking a row opens the lead it belongs to, since the task is only editable there.
 */
export function LeadTasksPanel({ tasks }: { tasks: LeadTaskRow[] }) {
  const navigate = useNavigate();
  const todayIso = new Date().toISOString().slice(0, 10);
  const open = tasks.filter((t) => t.status === 'pending').length;

  return (
    <div className="card">
      <div className="modal-sub">Lead Tasks ({open} open of {tasks.length})</div>
      {tasks.length === 0 ? <p className="help">No tasks have been created on any lead yet.</p> : (
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
    </div>
  );
}

/**
 * Every showing scheduled against a lead, across all leads the user can see. Soonest first (server
 * ordered). Clicking a row opens the lead it belongs to, where the showing is editable.
 */
export function LeadShowingsPanel({ showings }: { showings: LeadShowingRow[] }) {
  const navigate = useNavigate();
  const todayIso = new Date().toISOString().slice(0, 10);
  const upcoming = showings.filter((s) => s.showing_date >= todayIso && s.status === 'scheduled').length;

  return (
    <div className="card">
      <div className="modal-sub">Lead Showings ({upcoming} upcoming of {showings.length})</div>
      {showings.length === 0 ? <p className="help">No showings have been scheduled on any lead yet.</p> : (
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
    </div>
  );
}
