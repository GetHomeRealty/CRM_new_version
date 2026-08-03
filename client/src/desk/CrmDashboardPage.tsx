import { useCallback, useEffect, useState } from 'react';
import { getCrmDashboard } from '../lib/api';
import { listAllLeadTasks, listAllLeadShowings, type LeadFeedPage } from '../lib/leadsApi';
import { useToast } from './toast';
import { useAuth } from '../context/AuthContext';
import { apiErrorMessage } from '../lib/apiError';
import TodoList from './TodoList';
import { Breakdown, TallyBreakdown, Tile } from './DashboardTiles';
import { LeadShowingsPanel, LeadTasksPanel } from './LeadPanels';
import type { CrmDashboard, LeadShowingRow, LeadTaskRow } from '../types';
import type { TodoCounts } from '../types/todo';

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
  const { can } = useAuth();
  const canSeeLeads = can('lead', 'view');

  const [data, setData] = useState<CrmDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  /*
   * The two feeds are paged now, so each carries its page number, its total and its own summary.
   *
   * The summary is the part worth keeping separate: the panel headings read "N open of M" and
   * "N upcoming of M", and those counts come from the server across the whole set. Deriving them
   * from the twenty-five rows currently on screen would quietly turn them into a different number.
   */
  const [tasks, setTasks] = useState<LeadFeedPage<LeadTaskRow> | null>(null);
  const [taskPage, setTaskPage] = useState(1);
  const [showings, setShowings] = useState<LeadFeedPage<LeadShowingRow> | null>(null);
  const [showingPage, setShowingPage] = useState(1);

  useEffect(() => {
    getCrmDashboard()
      .then(setData)
      .catch((e) => toast(apiErrorMessage(e, 'Could not load the CRM dashboard'), 'bad'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!canSeeLeads) return;
    listAllLeadTasks(taskPage).then(setTasks).catch(() => setTasks(null));
  }, [canSeeLeads, taskPage]);

  useEffect(() => {
    if (!canSeeLeads) return;
    listAllLeadShowings(showingPage).then(setShowings).catch(() => setShowings(null));
  }, [canSeeLeads, showingPage]);

  // Reported up by the To-Do list so the card and the list are always the same numbers. The whole
  // count object is kept, not just the total: the tile shows a breakdown, and taking the headline
  // from here while leaving the parts on the page-load payload is exactly how the two drifted.
  const [todoCounts, setTodoCounts] = useState<TodoCounts | null>(null);
  const takeTodoCounts = useCallback((c: TodoCounts) => setTodoCounts(c), []);

  if (loading) return <div className="centered">Loading dashboard…</div>;
  if (!data) {
    return (
      <div className="card stub">
        <h2>Nothing to show</h2>
        <p className="help">The CRM dashboard could not be loaded.</p>
        {/* The message used to end "Try Refresh" while the only Refresh button on the screen
            belonged to the To-Do list — which this error state replaces. It named a control that
            was not there to press. */}
        <button className="btn primary sm" type="button" onClick={() => window.location.reload()}>↻ Refresh</button>
      </div>
    );
  }

  // Live counts once the list has reported; the page-load payload until then.
  const todos = todoCounts ?? data.todos;
  const followUpsDue = data.tasks.due_today + data.tasks.overdue;

  return (
    <>
      <div className="tiles">
        <Tile label="Total Leads" value={data.leads.total}
          sub={<Breakdown parts={[{ n: data.leads.new_this_week, label: 'new this week', tone: 'info' }]} />} />
        <Tile label="Leads by Stage" value={Object.keys(data.leads.by_status).length}
          sub={<TallyBreakdown by={data.leads.by_status} />} />
        <Tile label="Lead Sources" value={Object.keys(data.leads.by_source).length}
          sub={<TallyBreakdown by={data.leads.by_source} />} />
        {/* A card, like every other tile on this row — the sub-line describes the number rather
            than being a link out. It was the one tile carrying a button, which made it read as a
            control rather than a figure. */}
        <Tile label="Unread Mail" value={data.inbox.unread}
          color={data.inbox.unread > 0 ? 'var(--info-700)' : undefined}
          sub={<span className="tile-breakdown"><span className="tile-part info">
            {data.inbox.unread > 0 ? 'waiting in the CRM inbox' : 'nothing unread'}
          </span></span>} />
      </div>

      <div className="tiles">
        <Tile label="Lead Tasks" value={data.tasks.total} sub={
          <Breakdown parts={[
            { n: data.tasks.pending, label: 'pending', tone: 'info' },
            { n: data.tasks.completed, label: 'completed', tone: 'ok' },
            { n: data.tasks.cancelled, label: 'cancelled', tone: 'bad' },
          ]} />
        } />
        {/* Overdue counts as due. The headline was `due_today` alone, so a user with one task due
            today and two a week late read "1" — the two that most needed chasing were the ones the
            number left out. */}
        <Tile label="Follow-ups Due" value={followUpsDue}
          color={followUpsDue > 0 ? 'var(--info-700)' : undefined}
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
        {/* Headline and breakdown from ONE object. They used to come from two: the headline from
            the live list, the parts from the page-load payload — so adding a to-do gave "1" beside
            "0 pending" until the page was reloaded. */}
        <Tile label="Todo List" value={todos.total} sub={
          <Breakdown parts={[
            { n: todos.pending, label: 'pending', tone: 'info' },
            { n: todos.overdue, label: 'overdue', tone: 'bad' },
          ]} />
        } />
      </div>

      {canSeeLeads && <LeadTasksPanel feed={tasks} onPage={setTaskPage} />}
      {canSeeLeads && <LeadShowingsPanel feed={showings} onPage={setShowingPage} />}

      {/* The CRM's own list. Tasks added here belong to the CRM and do not appear on the
          Transaction Desk's list — section 11. */}
      {can('calendar', 'view') && <TodoList onCounts={takeTodoCounts} />}
    </>
  );
}
