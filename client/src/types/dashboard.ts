/** Shape of GET /api/dashboard/commissions (see DashboardController::commissions). */
export interface DashboardCommissions {
  role: 'agent' | 'admin';
  /**
   * TD-047 — what the `_count` fields below count: one row per commission line (a team member's
   * share of a deal) for the office, one per deal for an agent. The server derives it from the
   * query it actually ran; the tiles caption themselves from it rather than guessing from the
   * signed-in role.
   */
  count_basis: 'deals' | 'commission_lines';
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
  /** `scheduled` = committed to a future send and not yet started. */
  campaigns: { total: number; sent: number; opened: number; failed: number; scheduled: number };
  inbox: { unread: number };
  calendar: { upcoming: number; today: number };
  todos: { total: number; pending: number; overdue: number };
}

export interface DeskDashboard {
  transactions: { total: number; by_validation: Record<string, number>; by_commission: Record<string, number> };
  closings: { next_30_days: number; overdue: number; this_month: number };
  documents: { pending: number; invalid: number; mandatory_missing: number };
  /**
   * `null` unless the signed-in user may open the Invoice module — a brokerage financial role
   * (Super Admin, Admin, Accounting) AND the `invoice` screen permission. Invoices are brokerage
   * records rather than an agent's own work, so there is no per-agent scope: the tiles are omitted.
   */
  invoices: { total: number; unpaid: number; billed: number; collected: number; outstanding: number } | null;
  calendar: { upcoming: number; today: number };
  todos: { total: number; pending: number; overdue: number };
}

/**
 * The Transaction Desk Analytics screen, aggregated server-side.
 *
 * `GET /api/dashboard/analytics`. The screen used to download the whole transaction list and reduce
 * it in the browser; these are the same figures computed where the data is.
 */
export interface DeskAnalytics {
  /** Money before HST, and the number of deals behind each figure. */
  totals: { total: number; paid: number; pending: number; paid_count: number; pending_count: number };
  /** Ascending by `YYYY-MM`. Deals with neither a closing nor an offer date are omitted. */
  by_month: { month: string; total: number }[];
  /** Descending by commission. `Unassigned` covers deals with no agent. */
  by_agent: { agent: string; count: number; total: number }[];
  by_type: { type: string; count: number; total: number }[];
}
