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
