import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getDashboardCommissions, getDeskDashboard } from '../lib/api';
import { deskPath } from './area';
import { formatCurrency } from './format';
import { useToast } from './toast';
import { useAuth } from '../context/AuthContext';
import { apiErrorMessage } from '../lib/apiError';
import TodoList from './TodoList';
import { Breakdown, TallyBreakdown, Tile } from './DashboardTiles';
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
        <Tile label="Validation" value={Object.keys(data.transactions.by_validation).length}
          sub={<TallyBreakdown by={data.transactions.by_validation} />} />
        <Tile label="Commission Status" value={Object.keys(data.transactions.by_commission).length}
          sub={<TallyBreakdown by={data.transactions.by_commission} />} />
        <Tile label="Closings Ahead" value={data.closings.next_30_days}
          color={data.closings.overdue > 0 ? '#b91c1c' : undefined}
          sub={<Breakdown parts={[
            { n: data.closings.this_month, label: 'this month', tone: 'info' },
            { n: data.closings.next_30_days, label: 'next 30 days' },
            { n: data.closings.overdue, label: 'past closing, unpaid', tone: 'bad' },
          ]} />} />
      </div>

      <div className="tiles">
        <Tile label="Documents Outstanding" value={data.documents.pending}
          color={data.documents.invalid > 0 ? '#b45309' : undefined}
          sub={<Breakdown parts={[
            { n: data.documents.pending, label: 'pending', tone: 'info' },
            { n: data.documents.invalid, label: 'invalid', tone: 'bad' },
            { n: data.documents.mandatory_missing, label: 'mandatory missing', tone: 'bad' },
          ]} />} />
        <Tile label="Invoices" value={data.invoices.total} sub={
          <Breakdown parts={[{ n: data.invoices.unpaid, label: 'unpaid', tone: 'bad' }]} />
        } />
        <Tile label="Billed" value={money(data.invoices.billed)} sub="invoiced in total" />
        <Tile label="Collected" value={money(data.invoices.collected)} sub="received against invoices" color="#166534" />
        <Tile label="Outstanding" value={money(data.invoices.outstanding)} sub="still to be collected" color="#92400e" />
      </div>

      {comm && (
        <div className="tiles">
          <Tile label="Pipeline" value={money(comm.t4a.closed_total)}
            sub={`${comm.t4a.closed_count} closed deal${comm.t4a.closed_count === 1 ? '' : 's'}`} />
          <Tile label="Paid" value={money(comm.t4a.closed_paid)}
            sub={`${comm.t4a.paid_count} deal${comm.t4a.paid_count === 1 ? '' : 's'}`} color="#166534" />
          <Tile label="Pending" value={money(comm.t4a.closed_pending)}
            sub={`${comm.t4a.pending_count} deal${comm.t4a.pending_count === 1 ? '' : 's'}`} color="#92400e" />
          <Tile label="Upcoming Commissions" value={money(comm.t4a.upcoming_total)}
            sub={`${comm.t4a.upcoming_count} open deal${comm.t4a.upcoming_count === 1 ? '' : 's'}`} color="#1d4ed8" />
          <Tile label="Overall Commission"
            value={money(isAgent ? comm.t4a.overall_total : comm.gross.overall_total)}
            sub={isAgent ? 'your total T4A' : 'brokerage gross (incl. HST)'} />
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

      <div className="tiles">
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

      {/* The Transaction Desk's own list. Tasks added here belong to this area and do not appear on
          the CRM's list — section 11. */}
      {can('calendar', 'view') && <TodoList onCounts={takeTodoCounts} />}
    </>
  );
}
