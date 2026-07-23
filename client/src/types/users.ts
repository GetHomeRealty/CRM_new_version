import type { Permissions, Role, ScreenLevel } from './auth';

/** A loan entry recorded against an agent. */
export interface LoanEntry { amount: number | string; date: string; remarks: string; }

/** A previous-brokerage commission-history row. */
export interface CommissionHistoryEntry { brokerage: string; agent_pct: number | string; brok_pct: number | string; remarks: string; }

/** Agent/user profile block (persisted under user.profile). */
export interface UserProfile {
  mobile?: string;
  gender?: string;
  onboard_date?: string | null;
  personal_email?: string;
  org_email?: string;
  experience?: string;
  prev_brokerage?: string;
  commission_structure?: string;
  agent_comm_pct?: number | string;
  brok_comm_pct?: number | string;
  lease_comm_pct?: number | string;
  completed_deals?: number | string;
  upgrade_agent_pct?: number | string;
  upgrade_brok_pct?: number | string;
  commission_history?: CommissionHistoryEntry[];
  has_loan?: string;
  loan_entries?: LoanEntry[];
  address?: string;
  [key: string]: unknown;
}

/** A user as returned by the users-admin endpoints (list + detail). */
export interface ManagedUser {
  id: number;
  name: string;
  username?: string;
  email: string;
  role: Role;
  status?: string;
  is_admin?: boolean;
  permissions?: Permissions;
  profile?: UserProfile;
  [key: string]: unknown;
}

/** A screen definition in the users catalog. */
export interface ScreenDef { key: string; label: string; }

/** GET /api/users/catalog response. */
export interface UsersCatalog {
  screens: ScreenDef[];
  roles: Role[];
  levels: ScreenLevel[];
  role_defaults: Record<string, Permissions>;
}

/** A derived previous-commission deal-history row (GET /api/users/:id/deal-history). */
export interface DealHistoryEntry {
  brokerage?: string;
  agent_pct?: number | string | null;
  brok_pct?: number | string | null;
  property?: string;
  closing_date?: string;
  [key: string]: unknown;
}

/** A loan repayment deducted from an agent's deal commissions. */
export interface LoanRepayment {
  property?: string;
  trade_no?: number | string;
  closing_date?: string;
  amount?: number | string;
  [key: string]: unknown;
}
