import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getDashboardCommissions, getDeskDashboard } from '../lib/api';
import { deskPath } from './area';
import { formatCurrency } from './format';
import { useToast } from './toast';
import { useAuth } from '../context/AuthContext';
import { apiErrorMessage } from '../lib/apiError';
import TodoList from './TodoList';
import ReviewWidgets from './ReviewWidgets';
import ReviewErrorCharts from './ReviewErrorCharts';
import { Breakdown, TallyBreakdown, Tile, tallyTotal } from './DashboardTiles';
import type { DashboardCommissions, DeskDashboard } from '../types';

/**
 * The Transaction Management dashboard.
 *
 * The counts come from `/api/dashboard/desk`, which reads transactions, documents, invoices and the
 * Transaction Desk calendar — and nothing else. The commission figures still come from the existing
 * `/api/dashboard/commissions`, unchanged: it already computes the T4A and gross aggregates
 * correctly for each role, and re-deriving them here would be two implementations of the same
 * money.
 *
 * What this screen no longer does is download the entire transactions list to count it in the
 * browser. Both requests return summaries.
 */
/*
 * TD-047 — THE CAPTION UNDER A COMMISSION TILE SAYS WHAT THE TILE COUNTED.
 *
 * All four of these read "N deals", and on an administrator's screen that was untrue: the counts
 * are of COMMISSION LINES — one per team member per deal — which is what the dollar figure above
 * them is a sum of. A brokerage with fourteen deals carrying twenty-one agent lines showed
 * "20 open deals" beside a Total Deals tile reading 14, and the two cards looked like they
 * disagreed about the same fact. They were answering different questions; only one of them said so.
 *
 * The count is not the thing to change. Counting deals here would leave the money and the count on
 * one tile describing different sets, which is a worse defect and a silent one.
 *
 * An AGENT genuinely sees one row per deal — their own line on each visible deal, zero where they
 * are not a member — so their caption is unchanged. `count_basis` comes from the server, derived
 * from the query it ran, rather than from the role in this browser: the wording follows the numbers
 * even if who-gets-which-query ever changes.
 */
function commissionCount(comm: DashboardCommissions, n: number, qualifier?: 'closed' | 'open'): string {
  const noun = comm.count_basis === 'deals' ? 'deal' : 'commission line';
  return `${n} ${qualifier ? qualifier + ' ' : ''}${noun}${n === 1 ? '' : 's'}`;
}

export default function DeskDashboardPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const { user, can } = useAuth();
  const isAgent = user?.role === 'agent';

  const [data, setData] = useState<DeskDashboard | null>(null);
  const [comm, setComm] = useState<DashboardCommissions | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // The commission read is allowed to fail on its own — the deal, document and invoice counts are
    // still worth showing if the aggregate cannot be computed.
    Promise.all([getDeskDashboard(), getDashboardCommissions().catch(() => null)])
      .then(([d, c]) => { setData(d); setComm(c); })
      .catch((e) => toast(apiErrorMessage(e, 'Could not load the dashboard'), 'bad'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [todoTotal, setTodoTotal] = useState<number | null>(null);
  const takeTodoCounts = useCallback((c: { total: number }) => setTodoTotal(c.total), []);

  if (loading) return <div className="centered">Loading dashboard…</div>;
  if (!data) return <div className="card stub"><h2>Nothing to show</h2><p className="help">The dashboard could not be loaded. Try Refresh.</p></div>;

  const money = (n: number) => formatCurrency(n);

  return (
    <>
      <div className="tiles">
        <Tile label="Total Deals" value={data.transactions.total}
          sub={<button className="prop-link" type="button" onClick={() => navigate(deskPath('transactions'))}>open transactions</button>} />
        {/*
          * Both headlines are the number of DEALS in the breakdown, not the number of statuses in
          * it. They counted `Object.keys(...).length`, so a brokerage whose deals were all Pending
          * read "Validation 1" over a sub-line saying "8 pending" — the card contradicting itself,
          * in the row where "Total Deals" and "Closings Ahead" are genuine quantities. The count
          * also moved the wrong way: validating a deal split one group into two and pushed the
          * headline UP to 2.
          *
          * The CRM's "Leads by Stage" and "Lead Sources" keep counting keys, and are not the same
          * mistake — those labels name the categories, so "5 sources" is what the number means.
          * These two label a property of deals and sit beside deal counts.
        */}
        <Tile label="Validation" value={tallyTotal(data.transactions.by_validation)}
          sub={<TallyBreakdown by={data.transactions.by_validation} />} />
        <Tile label="Commission Status" value={tallyTotal(data.transactions.by_commission)}
          sub={<TallyBreakdown by={data.transactions.by_commission} />} />
        <Tile label="Closings Ahead" value={data.closings.next_30_days}
          color={data.closings.overdue > 0 ? 'var(--bad-700)' : undefined}
          sub={<Breakdown parts={[
            { n: data.closings.this_month, label: 'this month', tone: 'info' },
            { n: data.closings.next_30_days, label: 'next 30 days' },
            { n: data.closings.overdue, label: 'past closing, unpaid', tone: 'bad' },
          ]} />} />
        {/* Beside Closings Ahead: both answer "what is about to need attention on a deal". */}
        <Tile label="Documents Outstanding" value={data.documents.pending}
          color={data.documents.invalid > 0 ? 'var(--warn-700)' : undefined}
          sub={<Breakdown parts={[
            { n: data.documents.pending, label: 'pending', tone: 'info' },
            { n: data.documents.invalid, label: 'invalid', tone: 'bad' },
            { n: data.documents.mandatory_missing, label: 'mandatory missing', tone: 'bad' },
          ]} />} />
      </div>

      <div className="tiles">
        {/*
          * Four tiles that only appear for somebody who may read invoices.
          *
          * They used to render unconditionally off figures the API sent to everybody, so an agent —
          * who holds `invoice: 'none'` — opened this screen to the brokerage's total billed and
          * outstanding money. `/api/dashboard/desk` now sends `invoices: null` to anyone without the
          * screen, and an agent who does hold it gets their own deals' invoices rather than the
          * brokerage's.
          *
          * Absent rather than blanked: the four tiles are about a module this person cannot open, so
          * a row of dashes would only raise a question with nowhere to go and answer it.
          */}
        {data.invoices && <>
          <Tile label="Invoices" value={data.invoices.total} sub={
            <Breakdown parts={[{ n: data.invoices.unpaid, label: 'unpaid', tone: 'bad' }]} />
          } />
          <Tile label="Billed" value={money(data.invoices.billed)} sub="invoiced in total" />
          <Tile label="Collected" value={money(data.invoices.collected)} sub="received against invoices" color="var(--ok-ink)" />
          <Tile label="Outstanding" value={money(data.invoices.outstanding)} sub="still to be collected" color="var(--warn-ink)" />
        </>}
        {/* Calendar and to-dos sit beside Outstanding rather than on a row of their own — two tiles
            alone left a near-empty band under the commission figures. */}
        <Tile label="Desk Calendar" value={data.calendar.upcoming} sub={
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

      {comm && (
        <div className="tiles">
          <Tile label="Pipeline" value={money(comm.t4a.closed_total)}
            sub={commissionCount(comm, comm.t4a.closed_count, 'closed')} />
          <Tile label="Paid" value={money(comm.t4a.closed_paid)}
            sub={commissionCount(comm, comm.t4a.paid_count)} color="var(--ok-ink)" />
          <Tile label="Pending" value={money(comm.t4a.closed_pending)}
            sub={commissionCount(comm, comm.t4a.pending_count)} color="var(--warn-ink)" />
          <Tile label="Upcoming Commissions" value={money(comm.t4a.upcoming_total)}
            sub={commissionCount(comm, comm.t4a.upcoming_count, 'open')} color="var(--info-700)" />
          {/* Before HST on both sides: HST is collected and remitted, not earned. */}
          <Tile label="Overall Commission"
            value={money(isAgent ? comm.t4a.overall_total : comm.gross.overall_total)}
            sub={isAgent ? 'your commission, before HST' : 'brokerage gross, before HST'} />
          {!isAgent && (
            <Tile label="External Referral" value={money(comm.referrals.external_total)}
              sub="paid to outside brokerages" />
          )}
          {!isAgent && (
            <Tile label="Client Referral" value={money(comm.referrals.client_total)}
              sub="client referral payouts" />
          )}
        </div>
      )}

      {/* Review figures and the recurring-error charts, each fetched after the dashboard. */}
      <ReviewWidgets />
      <ReviewErrorCharts />

      {/* The Transaction Desk's own list. Tasks added here belong to this area and do not appear on
          the CRM's list — section 11. */}
      {can('calendar', 'view') && <TodoList onCounts={takeTodoCounts} />}
    </>
  );
}
