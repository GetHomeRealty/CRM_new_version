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
/**
 * The dashboard lists a person can switch off, and the key their choice is stored under.
 *
 * Scoped to the CRM in the key name because the Transaction Desk dashboard is a different screen
 * with different sections — sharing one key would have one dashboard's preference silently apply
 * to the other.
 */
const DASH_SECTIONS = [
  { key: 'tasks', label: 'Lead Tasks list' },
  { key: 'showings', label: 'Lead Showings list' },
  { key: 'todos', label: 'Todo List' },
] as const;
const DASH_SECTIONS_KEY = 'crm.dashboard.hiddenSections';

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

  /**
   * Which of the three lists this person wants on their dashboard.
   *
   * Kept in `localStorage` rather than on the server, deliberately: it is a per-browser view
   * preference with no bearing on what anyone is ALLOWED to see — the permission checks below are
   * untouched and still decide whether a section can be rendered at all. Hiding one here changes
   * only this person's screen, so it needs no API, no migration and no audit entry.
   *
   * Defaults to everything shown, so nobody's dashboard changes until they ask it to. An unreadable
   * or corrupt value falls back to that same default rather than throwing on a private-mode browser
   * where `localStorage` can be unavailable.
   */
  const [hidden, setHidden] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(DASH_SECTIONS_KEY);
      return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
    } catch { return new Set<string>(); }
  });

  const toggleSection = useCallback((key: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      try { localStorage.setItem(DASH_SECTIONS_KEY, JSON.stringify([...next])); } catch { /* nothing to do */ }
      return next;
    });
  }, []);

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
        {/* The count of campaigns, and only that. The sub-line used to carry sent/opened/failed,
            which are delivery statistics rather than a campaign count and made the card read as a
            performance summary. Those figures are unchanged and still on the Campaigns screen. */}
        <Tile label="Campaigns" value={data.campaigns.total} sub={
          <span className="tile-breakdown"><span className="tile-part">
            {data.campaigns.total === 1 ? 'campaign' : 'campaigns'} created
          </span></span>
        } />
        {/* Two counts that do not overlap: today, and the thirty days after it. The headline is
            today's, because that is the one that changes what somebody does this morning. */}
        <Tile label="CRM Calendar" value={data.calendar.today} sub={
          <Breakdown parts={[
            { n: data.calendar.today, label: "today's events", tone: 'info' },
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

      {/*
        Show/hide, for the three long lists only. The tiles above stay put: they are a fixed-height
        summary, and it is the lists underneath that make the dashboard a scroll for somebody who
        does not use them. Each control is rendered only when the person could see that section
        anyway, so this never advertises a list their permissions would refuse.
      */}
      <div className="card" style={{ padding: '10px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span className="muted" style={{ fontSize: 12 }}>Sections</span>
          {DASH_SECTIONS.filter((sec) => (sec.key === 'todos' ? can('calendar', 'view') : canSeeLeads)).map((sec) => (
            <label key={sec.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
              <input type="checkbox" checked={!hidden.has(sec.key)} onChange={() => toggleSection(sec.key)} />
              {sec.label}
            </label>
          ))}
        </div>
      </div>

      {canSeeLeads && !hidden.has('tasks') && <LeadTasksPanel feed={tasks} onPage={setTaskPage} />}
      {canSeeLeads && !hidden.has('showings') && <LeadShowingsPanel feed={showings} onPage={setShowingPage} />}

      {/* The CRM's own list. Tasks added here belong to the CRM and do not appear on the
          Transaction Desk's list — section 11. */}
      {can('calendar', 'view') && !hidden.has('todos') && <TodoList onCounts={takeTodoCounts} />}
    </>
  );
}
