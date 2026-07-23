/**
 * Shared commission/financial primitive types. These back both the client-side
 * commission calculator (commissionCalc.ts) and the backend `financial` block
 * rendered by the Financial UI. Money math stays byte-for-byte identical to
 * CommissionService.php — do not change semantics here.
 */

/** A value that may arrive as a number, a numeric string, or be absent. */
export type NumericInput = number | string | null | undefined;

/** The commission / HST / total triple used throughout the money math. */
export interface CommissionAmounts {
  commission: number;
  hst: number;
  total: number;
}

/** A team member's split configuration (as consumed by the calculator). */
export interface CommissionMember {
  name?: string;
  split?: NumericInput;
  agent_pct?: NumericInput;
  brok_pct?: NumericInput;
}

/** A single Agent Adjust / Advance Payment row. */
export interface AdjustmentRow {
  agent?: string;
  amount?: NumericInput;
  term?: NumericInput;
  is_loan?: boolean;
}

/** A single Client Referral row. */
export interface ClientReferralRow {
  amount?: NumericInput;
}

/** The transaction.adjustments JSON blob (Adjustment & Advance Payment module). */
export interface Adjustments {
  agent_adjust?: string;      // 'Yes' | 'No'
  advance_payment?: string;   // 'Yes' | 'No'
  ext_referral?: string;      // 'Yes' | 'No'
  client_referral?: string;   // 'Yes' | 'No'
  adjustment_rows?: AdjustmentRow[];
  advance_rows?: AdjustmentRow[];
  client_rows?: ClientReferralRow[];
  ext?: { amount?: NumericInput } | null;
}
