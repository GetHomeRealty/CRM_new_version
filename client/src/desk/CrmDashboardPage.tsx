import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getCrmDashboard } from '../lib/api';
import { listAllLeadTasks, listAllLeadShowings } from '../lib/leadsApi';
import { crmPath } from './area';
import { useToast } from './toast';
import { useAuth } from '../context/AuthContext';
import { apiErrorMessage } from '../lib/apiError';
import TodoList from './TodoList';
import { Breakdown, TallyBreakdown, Tile } from './DashboardTiles';
import { LeadShowingsPanel, LeadTasksPanel } from './LeadPanels';
import type { CrmDashboard, LeadShowingRow, LeadTaskRow } from '../types';

/**
 * The Customer Relationship Management dashboard.
 *
 * Every number here comes from one request to `/api/dashboard/crm`, which reads leads, lead tasks,
 * campaigns, the CRM mailbox and the CRM calendar — and nothing else. The old combined screen
 * fetched the entire transactions list into the browser and summed it here alongside the whole lead
 * list, then hid cards by permission; this asks the database for counts and receives numbers.
 *
 * The panels below the tiles still fetch their own rows, because they show individual tasks and
 * showings rather than totals. They fail independently: a user without the Leads screen gets 403s
 * for them and simply sees the tiles.
 */
export default function CrmDashboardPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const { can } = useAuth();
  const canSeeLeads = can('lead', 'view');

  const [data, setData] = useState<CrmDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [tasks, setTasks] = useState<LeadTaskRow[]>([]);
  const [showings, setShowings] = useState<LeadShowingRow[]>([]);

  useEffect(() => {
    getCrmDashboard()
      .then(setData)
      .catch((e) => toast(apiErrorMessage(e, 'Could not load the CRM dashboard'), 'bad'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!canSeeLeads) return;
    listAllLeadTasks().then(setTasks).catch(() => setTasks([]));
    listAllLeadShowings().then(setShowings).catch(() => setShowings([]));
  }, [canSeeLeads]);

  // Reported up by the To-Do list so the card and the list are always the same numbers.
  const [todoTotal, setTodoTotal] = useState<number | null>(null);
  const takeTodoCounts = useCallback((c: { total: number }) => setTodoTotal(c.total), []);

  if (loading) return <div className="centered">Loading dashboard…</div>;
  if (!data) return <div className="card stub"><h2>Nothing to show</h2><p className="help">The CRM dashboard could not be loaded. Try Refresh.</p></div>;

  return (
    <>
      <div className="tiles">
        <Tile label="Total Leads" value={data.leads.total}
          sub={<Breakdown parts={[{ n: data.leads.new_this_week, label: 'new this week', tone: 'info' }]} />} />
        <Tile label="Leads by Stage" value={Object.keys(data.leads.by_status).length}
          sub={<TallyBreakdown by={data.leads.by_status} />} />
        <Tile label="Lead Sources" value={Object.keys(data.leads.by_source).length}
          sub={<TallyBreakdown by={data.leads.by_source} />} />
        <Tile label="Unread Mail" value={data.inbox.unread}
          color={data.inbox.unread > 0 ? 'var(--info-700)' : undefined}
          sub={<button className="prop-link" type="button" onClick={() => navigate(crmPath('inbox'))}>open the CRM inbox</button>} />
      </div>

      <div className="tiles">
        <Tile label="Lead Tasks" value={data.tasks.total} sub={
          <Breakdown parts={[
            { n: data.tasks.pending, label: 'pending', tone: 'info' },
            { n: data.tasks.completed, label: 'completed', tone: 'ok' },
            { n: data.tasks.cancelled, label: 'cancelled', tone: 'bad' },
          ]} />
        } />
        <Tile label="Follow-ups Due" value={data.tasks.due_today}
          color={data.tasks.due_today > 0 ? 'var(--info-700)' : undefined}
          sub={<Breakdown parts={[
            { n: data.tasks.due_today, label: 'due today', tone: 'info' },
            { n: data.tasks.overdue, label: 'overdue', tone: 'bad' },
          ]} />} />
        <Tile label="Campaigns" value={data.campaigns.total} sub={
          <Breakdown parts={[
            { n: data.campaigns.sent, label: 'sent', tone: 'info' },
            { n: data.campaigns.opened, label: 'opened', tone: 'ok' },
            { n: data.campaigns.failed, label: 'failed', tone: 'bad' },
          ]} />
        } />
        <Tile label="CRM Calendar" value={data.calendar.upcoming} sub={
          <Breakdown parts={[
            { n: data.calendar.today, label: 'today', tone: 'info' },
            { n: data.calendar.upcoming, label: 'next 30 days' },
          ]} />
        } />
        <Tile label="Todo List" value={todoTotal ?? data.todos.total} sub={
          <Breakdown parts={[
            { n: data.todos.pending, label: 'pending', tone: 'info' },
            { n: data.todos.overdue, label: 'overdue', tone: 'bad' },
          ]} />
        } />
      </div>

      {canSeeLeads && <LeadTasksPanel tasks={tasks} />}
      {canSeeLeads && <LeadShowingsPanel showings={showings} />}

      {/* The CRM's own list. Tasks added here belong to the CRM and do not appear on the
          Transaction Desk's list — section 11. */}
      {can('calendar', 'view') && <TodoList onCounts={takeTodoCounts} />}
    </>
  );
}
