/** Shape of GET /api/dashboard/commissions (see DashboardController::commissions). */
export interface DashboardCommissions {
  role: 'agent' | 'admin';
  t4a: {
    closed_total: number;
    closed_paid: number;
    closed_pending: number;
    closed_count: number;
    paid_count: number;
    pending_count: number;
    upcoming_total: number;
    upcoming_count: number;
    overall_total: number;
  };
  gross: {
    overall_total: number;
  };
  referrals: {
    external_total: number;
    client_total: number;
  };
}

/**
 * The two area dashboards. Two separate shapes because they are two separate endpoints reading two
 * separate sets of tables — see the server's AreaDashboardService.
 */
export interface CrmDashboard {
  leads: { total: number; by_status: Record<string, number>; by_source: Record<string, number>; new_this_week: number };
  tasks: { total: number; pending: number; completed: number; cancelled: number; due_today: number; overdue: number };
  campaigns: { total: number; sent: number; opened: number; failed: number };
  inbox: { unread: number };
  calendar: { upcoming: number; today: number };
  todos: { total: number; pending: number; overdue: number };
}

export interface DeskDashboard {
  transactions: { total: number; by_validation: Record<string, number>; by_commission: Record<string, number> };
  closings: { next_30_days: number; overdue: number; this_month: number };
  documents: { pending: number; invalid: number; mandatory_missing: number };
  /** `null` when the signed-in user does not hold the `invoice` screen — the tiles are omitted. */
  invoices: { total: number; unpaid: number; billed: number; collected: number; outstanding: number } | null;
  calendar: { upcoming: number; today: number };
  todos: { total: number; pending: number; overdue: number };
}
