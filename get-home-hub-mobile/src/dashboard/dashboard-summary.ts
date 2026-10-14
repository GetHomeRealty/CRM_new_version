import type { HubDashboard } from './dashboard-api';

export function dashboardSummary(data: HubDashboard | undefined, pending: boolean, failed: boolean) {
  if (!data) return {
    title: pending ? 'Loading your work…' : 'Dashboard unavailable',
    detail: pending ? 'Fetching your latest totals.' : 'Refresh to try again. Totals are not available.',
  };
  if (!data.crm && !data.desk) return {
    title: 'No dashboard access',
    detail: 'Your account does not currently have access to either dashboard.',
  };
  const attention = (data.crm?.tasks.due_today ?? 0) + (data.crm?.tasks.overdue ?? 0) + (data.desk?.closings.overdue ?? 0);
  const parts = [];
  if (data.crm) parts.push(`${data.crm.tasks.overdue} overdue tasks`);
  if (data.desk) parts.push(`${data.desk.closings.overdue} overdue closings`);
  return {
    title: `${attention} ${attention === 1 ? 'item needs' : 'items need'} your attention`,
    detail: `${failed ? 'Last loaded totals — refresh failed. ' : ''}${parts.join(' · ')}`,
  };
}
