/** Normalized inputs for CommissionService (all Decimals converted to numbers). */

export interface CommMember {
  name: string;
  split: number;
  agent_pct: number;
  brok_pct: number;
  scope: string;
  terms: number[];
}

export interface CommPreconTerm {
  term_no: number;
  pct: number | null;
  closing_date: Date | null;
}

/** The transaction fields + relations the commission math reads. */
export interface CommissionTxn {
  type: string;
  price: number;
  deposit: number;
  comm_type: string;
  comm_value: number;
  comm_pct: number | null;
  comm_amt: number | null;
  comm_adjust_enabled: boolean;
  comm_adjust_before: number;
  comm_adjust_after: number;
  listing_comm_pct: number | null;
  coop_comm_pct: number | null;
  listing_comm_flat: number | null;
  coop_comm_flat: number | null;
  listing_adj_enabled: boolean;
  listing_adj_before: number;
  listing_adj_after: number;
  coop_adj_enabled: boolean;
  coop_adj_before: number;
  coop_adj_after: number;
  precon_net_of_hst: boolean;
  precon_comm_pct: number | null;
  precon_comm_amt_manual: number | null;
  precon_term_count: number | null;
  comm_paid_status: string | null;
  comm_status: string | null;
  agent: string | null;
  /** Parsed `adjustments` JSON blob (or null). */
  adjustments: Record<string, unknown> | null;
  teamMembers: CommMember[];
  preconTerms: CommPreconTerm[];
}

export interface CommissionSummary {
  amount: number;
  hst: number;
  total: number;
  paid: boolean;
}

/** HST/commission triple. */
export interface Triple {
  commission: number;
  hst: number;
  total: number;
}
