import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { listTransactions, getDashboardCommissions } from '../lib/api';
import { listAllLeadTasks, listAllLeadShowings, listLeads } from '../lib/leadsApi';
import { formatCurrency } from './format';
import { useToast } from './toast';
import { useAuth } from '../context/AuthContext';
import TodoList from './TodoList';
import type { DashboardCommissions, LeadStats, LeadShowingRow, LeadTaskRow, TodoCounts, Transaction } from '../types';

const EMPTY_TODO_COUNTS: TodoCounts = { total: 0, pending: 0, completed: 0, cancelled: 0, overdue: 0 };

// The "Deals by Year & Type" breakdown was removed from this screen on request. The equivalent
// filtering now lives on Transactions, which has a "Year (by closing date)" dropdown alongside
// the type, status and agent filters.

export default function DashboardPage() {
  const toast = useToast();
  const { user, can } = useAuth();
  const isAgent = user?.role === 'agent';
  const canSeeLeads = can('lead', 'view');
  const [rows, setRows] = useState<Transaction[]>([]);
  const [comm, setComm] = useState<DashboardCommissions | null>(null);     // backend commission/T4A aggregates
  const [tasks, setTasks] = useState<LeadTaskRow[]>([]);
  const [showings, setShowings] = useState<LeadShowingRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([listTransactions(), getDashboardCommissions().catch(() => null)])
      .then(([txns, c]) => { setRows(txns); setComm(c); })
      .catch(() => toast('Could not load dashboard data', 'bad'))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Lead data loads on its own so a user without the Leads screen still gets the rest of the
  // dashboard — the requests 403 for them and the lead cards simply do not appear.
  const [leadStats, setLeadStats] = useState<LeadStats | null>(null);
  useEffect(() => {
    listAllLeadTasks().then(setTasks).catch(() => setTasks([]));
    listAllLeadShowings().then(setShowings).catch(() => setShowings([]));
    // One row is enough: the header counters come back with every page of the list, and they are
    // scoped the same way, so an agent's totals count only their own leads.
    listLeads({}, 1, 1).then((r) => setLeadStats(r.stats)).catch(() => setLeadStats(null));
  }, []);

  // Reported up by the Todo List below, so the card and the list are always the same numbers.
  const [todoCounts, setTodoCounts] = useState<TodoCounts>(EMPTY_TODO_COUNTS);
  const takeTodoCounts = useCallback((c: TodoCounts) => setTodoCounts(c), []);

  const taskSummary = useMemo(() => {
    const todayIso = new Date().toISOString().slice(0, 10);
    const by = (s: string): number => tasks.filter((t) => t.status === s).length;
    return {
      total: tasks.length,
      pending: by('pending'),
      completed: by('completed'),
      cancelled: by('cancelled'),
      // Due today and not yet dealt with — what an agent actually has to work through.
      today: tasks.filter((t) => t.due_date === todayIso && t.status === 'pending').length,
      overdue: tasks.filter((t) => t.due_date < todayIso && t.status === 'pending').length,
    };
  }, [tasks]);

  const kpi = useMemo(() => {
    let paid = 0, pending = 0, paidN = 0, pendingN = 0;
    rows.forEach((t) => {
      const amt = t.commission?.amount || 0;
      if (t.commission?.paid) { paid += amt; paidN++; } else { pending += amt; pendingN++; }
    });
    return { paid, pending, paidN, pendingN, total: paid + pending };
  }, [rows]);

  if (loading) return <div className="centered">Loading dashboard…</div>;

  return (
    <>
      {/* Lead-and-todo summary, above the commission tiles. Each card is hidden when the user
          cannot see the module behind it, rather than showing a permanent zero. */}
      <div className="tiles">
        {canSeeLeads && (
          <>
            <Tile label="Total Tasks" value={taskSummary.total} sub={
              <Breakdown parts={[
                { n: taskSummary.pending, label: 'pending', tone: 'info' },
                { n: taskSummary.completed, label: 'completed', tone: 'ok' },
                { n: taskSummary.cancelled, label: 'cancelled', tone: 'bad' },
              ]} />
            } />
            <Tile label="Total Leads" value={leadStats?.total ?? '—'} sub={
              leadStats ? <SourceSplit by={leadStats.bySource} /> : 'leads you can see'
            } />
            <Tile label="Today's Tasks" value={taskSummary.today}
              color={taskSummary.today > 0 ? '#1d4ed8' : undefined}
              sub={taskSummary.overdue > 0
                ? <Breakdown parts={[
                    { n: taskSummary.today, label: 'due today', tone: 'info' },
                    { n: taskSummary.overdue, label: 'overdue', tone: 'bad' },
                  ]} />
                : 'lead tasks due today'} />
          </>
        )}
        {can('calendar', 'view') && (
          <Tile label="Todo List" value={todoCounts.total} sub={
            <Breakdown parts={[
              { n: todoCounts.pending, label: 'pending', tone: 'info' },
              { n: todoCounts.completed, label: 'completed', tone: 'ok' },
            ]} />
          } />
        )}
      </div>

      <div className="tiles">
        <Tile label="Total Deals" value={rows.length} sub="all transactions" />
        {comm ? (
          <>
            <Tile label="Pipeline" value={formatCurrency(comm.t4a.closed_total)}
              sub={`${comm.t4a.closed_count} closed deal${comm.t4a.closed_count === 1 ? '' : 's'}`} />
            <Tile label="Paid" value={formatCurrency(comm.t4a.closed_paid)}
              sub={`${comm.t4a.paid_count} deal${comm.t4a.paid_count === 1 ? '' : 's'}`} color="#166534" />
            <Tile label="Pending" value={formatCurrency(comm.t4a.closed_pending)}
              sub={`${comm.t4a.pending_count} deal${comm.t4a.pending_count === 1 ? '' : 's'}`} color="#92400e" />
            <Tile label="Upcoming Commissions" value={formatCurrency(comm.t4a.upcoming_total)}
              sub={`${comm.t4a.upcoming_count} open deal${comm.t4a.upcoming_count === 1 ? '' : 's'}`} color="#1d4ed8" />
            <Tile label="Overall Commission"
              value={formatCurrency(isAgent ? comm.t4a.overall_total : comm.gross.overall_total)}
              sub={isAgent ? 'your total T4A' : 'brokerage gross (incl. HST)'} />
            {!isAgent && (
              <Tile label="External Referral" value={formatCurrency(comm.referrals.external_total)}
                sub="paid to outside brokerages" />
            )}
            {!isAgent && (
              <Tile label="Client Referral" value={formatCurrency(comm.referrals.client_total)}
                sub="client referral payouts" />
            )}
          </>
        ) : (
          <>
            <Tile label="Pipeline Commission" value={formatCurrency(kpi.total)} sub="incl. paid + pending" />
            <Tile label="Paid" value={formatCurrency(kpi.paid)} sub={`${kpi.paidN} deal${kpi.paidN === 1 ? '' : 's'}`} color="#166534" />
            <Tile label="Pending" value={formatCurrency(kpi.pending)} sub={`${kpi.pendingN} deal${kpi.pendingN === 1 ? '' : 's'}`} color="#92400e" />
          </>
        )}
      </div>

      {canSeeLeads && <LeadTasksPanel tasks={tasks} />}

      {canSeeLeads && <LeadShowingsPanel showings={showings} />}

      {/* Moved here from the Calendar. Todos are still owned by the Calendar module — same
          endpoints, same `calendar` permission — so this only renders for someone who has it. */}
      {can('calendar', 'view') && <TodoList onCounts={takeTodoCounts} />}
    </>
  );
}

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
function LeadTasksPanel({ tasks }: { tasks: LeadTaskRow[] }) {
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
                  <tr key={t.id} className="clickable" onClick={() => navigate(`/app/lead/${t.lead_id}`)}
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
function LeadShowingsPanel({ showings }: { showings: LeadShowingRow[] }) {
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
                  <tr key={s.id} className="clickable" onClick={() => navigate(`/app/lead/${s.lead_id}`)}
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

/**
 * The status split under a card's headline number, e.g. "3 pending · 1 completed".
 * A zero is kept rather than hidden — "0 cancelled" is information, a missing line is not.
 */
function Breakdown({ parts }: { parts: { n: number; label: string; tone: 'ok' | 'info' | 'bad' }[] }) {
  return (
    <span className="tile-breakdown">
      {parts.map((p) => (
        <span key={p.label} className={`tile-part ${p.tone}`}>
          <strong>{p.n}</strong> {p.label}
        </span>
      ))}
    </span>
  );
}

/**
 * Where the leads came from, under the Total Leads figure.
 *
 * "Other" covers LinkedIn, YouTube and leads with no source recorded. It is shown only when it
 * is non-zero, but it is always counted — so the parts and the headline total always reconcile
 * rather than quietly disagreeing.
 */
function SourceSplit({ by }: { by: LeadStats['bySource'] }) {
  return (
    <span className="tile-breakdown">
      <span className="tile-part info"><strong>{by.google}</strong> google</span>
      <span className="tile-part info"><strong>{by.meta}</strong> meta</span>
      <span className="tile-part info"><strong>{by.website}</strong> website</span>
      <span className="tile-part info"><strong>{by.referral}</strong> referral</span>
      {by.other > 0 && <span className="tile-part"><strong>{by.other}</strong> other</span>}
    </span>
  );
}

interface TileProps { label: ReactNode; value: ReactNode; sub: ReactNode; color?: string; }

function Tile({ label, value, sub, color }: TileProps) {
  const valStyle: CSSProperties | undefined = color ? { color } : undefined;
  return (
    <div className="stat-card">
      <div className="lbl">{label}</div>
      <div className="val" style={valStyle}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{sub}</div>
    </div>
  );
}