// Commission calculation module.
//
// Implements the brokerage commission spec verbatim. The SAME logic applies to
// RESIDENTIAL_BUYING and RESIDENTIAL_LEASE — the transaction type is metadata
// only and does not affect any calculation.
//
// All currency is CAD. HST is configurable; default 13% (Ontario). Every "Total"
// that includes HST is `commission * (1 + HST_RATE)`, and the commission is
// back-solved as `total / (1 + HST_RATE)`.

import type {
  Adjustments,
  AdjustmentRow,
  CommissionAmounts,
  CommissionMember,
  NumericInput,
} from '../types';

export const HST_RATE = 0.13;

const ROUND = (x: number, n = 2): number => {
  const f = 10 ** n;
  return Math.round((x + Number.EPSILON) * f) / f;
};
// Number(v) is identical to the original unary `+v` for every value passed here
// (numbers, numeric strings, null → 0, undefined/non-numeric → NaN → 0).
const num = (v: NumericInput): number => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Per-transaction inputs for computeCommission (spec §1). */
export interface CommissionInput {
  price?: NumericInput;
  commissionPct?: NumericInput;
  commissionAmount?: NumericInput;
  adjBeforeHst?: NumericInput;
  adjAfterHst?: NumericInput;
  agentCommPct?: NumericInput;
  brokerageMin?: NumericInput;
  teamSplitPct?: NumericInput;
  adjustmentAmount?: NumericInput;
  advancePayment?: NumericInput;
  clientReferral?: NumericInput;
  extReferralPct?: NumericInput;
  extReferralFlat?: NumericInput;
}

/** Full commission breakdown returned by computeCommission (spec §3). */
export interface CommissionResult {
  dealCommission: number;
  dealCommissionHst: number;
  dealCommissionTotal: number;
  brokeragePct: number;
  agentComm: number;
  agentCommHst: number;
  agentCommTotal: number;
  t4aComm: number;
  t4aHst: number;
  t4aTotal: number;
  brokerageMin: number;
  brokerageMinHst: number;
  brokerageMinTotal: number;
  brokerageComm: number;
  brokerageHst: number;
  brokerageTotal: number;
  extReferralAmount: number;
  extReferralHst: number;
  extReferralTotal: number;
}

export function computeCommission(input: CommissionInput = {}, hstRate: number = HST_RATE): CommissionResult {
  const HST = hstRate;
  const G1 = 1 + HST; // HST gross-up factor

  // Inputs (default missing values to 0).
  const price = num(input.price);
  const commissionPct = num(input.commissionPct);
  const commissionAmount = num(input.commissionAmount);
  const adjBeforeHst = num(input.adjBeforeHst);
  const adjAfterHst = num(input.adjAfterHst);
  const agentCommPct = num(input.agentCommPct);
  const brokerageMin = num(input.brokerageMin);
  const teamSplitPct = num(input.teamSplitPct);
  const adjustmentAmount = num(input.adjustmentAmount);
  const advancePayment = num(input.advancePayment);
  const clientReferral = num(input.clientReferral);
  const extReferralPct = num(input.extReferralPct);
  const extReferralFlat = num(input.extReferralFlat);

  // 2.1 External Brokerage Referral
  const extReferralAmount = extReferralPct > 0 ? price * extReferralPct : extReferralFlat;
  const extReferralHst = extReferralAmount * HST;
  const extReferralTotal = extReferralAmount + extReferralHst;

  // 2.2 Deal Commission (pre-HST), then HST + after-HST adjustment → G
  let dealCommission =
    commissionPct === 0 && commissionAmount === 0
      ? 0
      : price * commissionPct + adjBeforeHst + commissionAmount;
  dealCommission -= extReferralAmount; // subtract external referral
  const dealCommissionHst = dealCommission * HST;
  const dealCommissionTotal = dealCommission + dealCommissionHst + adjAfterHst; // G
  const G = dealCommissionTotal;

  // 2.3 Brokerage split percentage
  const brokeragePct = 1 - agentCommPct; // T

  // 2.4 Brokerage Minimum block
  const brokerageMinHst = brokerageMin * HST;
  const brokerageMinTotal = brokerageMin + brokerageMinHst;

  // 2.5 Agent (T4A) block — pre-team-split agent entitlement
  const agentBase = Math.min(G * agentCommPct, G - brokerageMin * G1);
  const t4aTotal = (agentBase - clientReferral) * teamSplitPct; // P
  const t4aComm = t4aTotal / G1; // N
  const t4aHst = t4aComm * HST; // O

  // 2.6 Agent Commission block (payable, includes adjustments/advances)
  const agentCommTotal = (agentBase + adjustmentAmount - advancePayment - clientReferral) * teamSplitPct; // M
  const agentComm = t4aComm; // K mirrors the T4A commission
  const agentCommHst = t4aHst; // L mirrors the T4A HST

  // 2.7 Brokerage Commission block (for the named agent)
  const brokerageTotal = ROUND(Math.max(G * (1 - agentCommPct), brokerageMin * G1) * teamSplitPct, 2); // W
  const brokerageComm = brokerageTotal / G1; // U
  const brokerageHst = brokerageComm * HST; // V

  return {
    // Deal commission — E, F, G
    dealCommission: ROUND(dealCommission),
    dealCommissionHst: ROUND(dealCommissionHst),
    dealCommissionTotal: ROUND(dealCommissionTotal),
    // Brokerage split % — T
    brokeragePct,
    // Agent Commission — K, L, M
    agentComm: ROUND(agentComm),
    agentCommHst: ROUND(agentCommHst),
    agentCommTotal: ROUND(agentCommTotal),
    // T4A — N, O, P
    t4aComm: ROUND(t4aComm),
    t4aHst: ROUND(t4aHst),
    t4aTotal: ROUND(t4aTotal),
    // Brokerage Minimum — Q, R, S
    brokerageMin: ROUND(brokerageMin),
    brokerageMinHst: ROUND(brokerageMinHst),
    brokerageMinTotal: ROUND(brokerageMinTotal),
    // Brokerage Commission — U, V, W
    brokerageComm: ROUND(brokerageComm),
    brokerageHst: ROUND(brokerageHst),
    brokerageTotal: ROUND(brokerageTotal),
    // External Referral — AC, AD, AE
    extReferralAmount: ROUND(extReferralAmount),
    extReferralHst: ROUND(extReferralHst),
    extReferralTotal: ROUND(extReferralTotal),
  };
}

/** Per-member pre-HST deduction, broken down by source. */
export interface AgentAdjustment {
  agentAdjust: number;
  advance: number;
  loan: number;
  total: number;
}

/**
 * Per-agent commission deductions from the Adjustment & Advance Payment module.
 *
 * Returns an array aligned to `members` of the pre-HST dollar amount to subtract
 * from each member's Agent Commission Total — only the per-agent categories:
 *   • Agent Adjust + Advance Payment rows → matched to the member by name
 * Client Referral and External Brokerage Referral are deal-level (see
 * referralSections / CommissionService::referralSections) and are NOT included
 * here. For preconstruction, pass the 1-based `term` to scope the rows. Status is
 * ignored — a row counts as soon as it is entered. Mirrors
 * CommissionService::memberDeduction() so the live preview matches the backend.
 */
export function agentAdjustments(
  adjustments: Adjustments | null | undefined,
  members: CommissionMember[] = [],
  term: number | null = null,
): AgentAdjustment[] {
  const a: Adjustments = adjustments || {};
  const out = members.map(() => ({ agentAdjust: 0, advance: 0, loan: 0 }));
  const idxByName: Record<string, number> = {};
  members.forEach((m, i) => { if (m && m.name) idxByName[m.name] = i; });

  const addNamed = (rows: AdjustmentRow[] | undefined, enabled: boolean, key: 'agentAdjust' | 'advance', trackLoan = false) => {
    if (!enabled) return;
    (rows || []).forEach((r) => {
      if (term != null && Number(r.term) !== Number(term)) return;
      const name = r.agent;
      if (name == null) return; // no named agent → idxByName lookup would miss (original: skip)
      const i = idxByName[name];
      if (i != null) {
        out[i][key] += num(r.amount);
        if (trackLoan && r.is_loan) out[i].loan += num(r.amount);
      }
    });
  };
  addNamed(a.adjustment_rows, a.agent_adjust === 'Yes', 'agentAdjust', true);
  addNamed(a.advance_rows, a.advance_payment === 'Yes', 'advance');

  return out.map((d) => ({
    agentAdjust: ROUND(d.agentAdjust),
    advance: ROUND(d.advance),
    loan: ROUND(d.loan),
    total: ROUND(d.agentAdjust + d.advance),
  }));
}

/** Result of referralSections. */
export interface ReferralSections {
  brokerAmount: number;
  clientAmount: number;
  showBroker: boolean;
  showClient: boolean;
  afterBroker: CommissionAmounts;
}

/**
 * "Commissions after broker referral" section — Commission = full deal commission
 * − broker referral, HST = ×rate, Total = ×(1+rate). Also surfaces the referral
 * amounts and show flags. (The "Agent Commissions after client referral" section
 * is computed by agentCommissionsAfterClient.)
 */
export function referralSections(dealComm: NumericInput, adjustments: Adjustments | null | undefined, hstRate: number = HST_RATE): ReferralSections {
  const a: Adjustments = adjustments || {};
  const showBroker = a.ext_referral === 'Yes';
  const showClient = a.client_referral === 'Yes';
  const brokerAmount = showBroker ? num(a.ext && a.ext.amount) : 0;
  const clientAmount = showClient ? (a.client_rows || []).reduce((s, r) => s + num(r.amount), 0) : 0;

  const fullComm = ROUND(num(dealComm));
  const afterBrokerComm = ROUND(fullComm - brokerAmount);
  const afterBroker = { commission: afterBrokerComm, hst: ROUND(afterBrokerComm * hstRate), total: ROUND(afterBrokerComm * (1 + hstRate)) };

  return { brokerAmount: ROUND(brokerAmount), clientAmount: ROUND(clientAmount), showBroker, showClient, afterBroker };
}

/** Options for agentCommissionsAfterClient. */
export interface AfterClientOpts {
  minBrokComm?: NumericInput;
  adjBefore?: NumericInput;
  adjAfter?: NumericInput;
  clientReferral?: NumericInput;
}

/**
 * "Agent Commissions after client referral" section. Sums, across team members,
 * each member's brokerage-floor-capped agent commission off the listing-side
 * commission (Agent% and Brokerage% are both weighted by the member's Split %),
 * then subtracts the client referral:
 *
 *   floor_i  = (lc == 0) ? 0 : max(lc × brok%_i × split_i, minBrokComm × 1.13) − (adjBefore×1.13 − adjAfter)
 *   capped_i = max(0, min(lc × agent%_i × split_i, lc − floor_i))
 *   pool     = Σ capped_i
 *   Total    = pool × 1.13 − Client Referral   (client referral comes off the Total, with HST)
 *   Commission = Total / 1.13 ;  HST = Total − Commission
 */
export function agentCommissionsAfterClient(listingComm: NumericInput, members: CommissionMember[] = [], opts: AfterClientOpts = {}, hstRate: number = HST_RATE): CommissionAmounts {
  const { minBrokComm = 0, adjBefore = 0, adjAfter = 0, clientReferral = 0 } = opts;
  const g = 1 + hstRate;
  const lc = num(listingComm);
  const minBrokTotal = num(minBrokComm) * g;

  let pool = 0;
  members.forEach((m) => {
    const a = num(m.agent_pct) / 100;
    const b = num(m.brok_pct) / 100;
    const split = num(m.split) / 100;
    const brokRaw = Math.max(lc * b * split, minBrokTotal);
    const floor = lc === 0 ? 0 : brokRaw - (num(adjBefore) * g - num(adjAfter));
    pool += Math.max(0, Math.min(lc * a * split, lc - floor));
  });

  const total = ROUND(pool * g - num(clientReferral));
  const commission = ROUND(total / g);
  const hst = ROUND(total - commission);
  return { commission, hst, total };
}

/**
 * Per-team-member "Agent Commission" (payable, with HST). The Agent% and
 * brokerage-floor cap are already applied in agentCommissionsAfterClient, so each
 * member simply takes their Split % of that section's Total, then subtracts that
 * member's Adjustment + Advance amounts:
 *
 *   Total      = (acTotal × split) − deduction
 *   Commission = Total / 1.13 ;  HST = Total − Commission
 *
 * Pass deduction = 0 for the gross (T4A) line.
 */
export function agentCommissionLine(member: { split?: NumericInput }, ctx: { acTotal?: NumericInput }, deduction: NumericInput = 0, hstRate: number = HST_RATE): CommissionAmounts {
  const g = 1 + hstRate;
  const split = num(member.split) / 100;
  const total = ROUND(num(ctx.acTotal) * split - num(deduction));
  const commission = ROUND(total / g);
  const hst = ROUND(total - commission);
  return { commission, hst, total };
}

/** Inputs for the listing-variant breakdown. */
export interface ListingInput {
  price?: NumericInput;
  deposit?: NumericInput;
  isLease?: boolean;
  listPct?: NumericInput;
  coopPct?: NumericInput;
  listFlat?: NumericInput;
  coopFlat?: NumericInput;
  lAdjBefore?: NumericInput;
  lAdjAfter?: NumericInput;
  cAdjBefore?: NumericInput;
  cAdjAfter?: NumericInput;
  extAmt?: NumericInput;
  clientReferral?: NumericInput;
  members?: CommissionMember[];
  deductions?: NumericInput[];
}

/** Per-member row in the listing breakdown. */
export interface ListingMemberRow {
  name?: string;
  teamShare: number;
  commission: number;
  hst: number;
  earned: number;
  deduction: number;
  cashToPay: number;
  brokerageFromMember: number;
}

/** Full listing-variant report sections. */
export interface ListingBreakdown {
  dealType: 'Lease' | 'Sale';
  listing: { pct: number; commission: number; hst: number; total: number };
  coop: { pct: number; commission: number; hst: number; total: number };
  totals: CommissionAmounts;
  extReferral: { amount: number; hst: number; total: number };
  trust: { deposit: number; payableToClient: number; receivableFromLawyer: number };
  coopPayout: number;
  split: { agentSplit: number; brokerageSplit: number; agentPool: number; brokerageKeep: number; brokerageFloor: number };
  clientReferral: number;
  members: ListingMemberRow[];
  brokerageKeep: number;
  minBrok: { commission: number; hst: number; total: number };
  balanceCheck: { expected: number; reconcile: number; pass: boolean };
}

/**
 * Listing variant (Sale Listing / Lease Listing) — full client spec (2026-06-26).
 * GHR is the listing brokerage: members split the LISTING commission; the CO-OP
 * commission is paid in full to the external co-op brokerage. Mirrors
 * CommissionService::breakdownListing(). Returns the report sections.
 */
export function listingBreakdown(input: ListingInput, hstRate: number = HST_RATE): ListingBreakdown {
  const g = 1 + hstRate;
  const price = num(input.price);
  const deposit = num(input.deposit);
  const isLease = !!input.isLease;
  const minBrok = isLease ? 250 : 499;
  const listPct = num(input.listPct);
  const coopPct = num(input.coopPct);
  const listFlat = num(input.listFlat);
  const coopFlat = num(input.coopFlat);
  const lAdjBefore = num(input.lAdjBefore);
  const lAdjAfter = num(input.lAdjAfter);
  const cAdjBefore = num(input.cAdjBefore);
  const cAdjAfter = num(input.cAdjAfter);
  const extAmt = num(input.extAmt);
  const clientReferral = num(input.clientReferral);
  const members = input.members || [];
  const deductions = input.deductions || [];
  const first = members[0];
  const agentSplit = first ? num(first.agent_pct) / 100 : (isLease ? 0.95 : 0.90);
  const brokerageSplit = 1 - agentSplit;
  const listBasePct = price * listPct / 100;
  const coopBasePct = price * coopPct / 100;
  const extHst = extAmt * hstRate;
  const extTotal = extAmt + extHst;
  const allZero = listPct === 0 && listFlat === 0 && coopPct === 0 && coopFlat === 0;

  // Sale & Lease share the same listing/co-op/split math — adjustments apply to their own
  // sides (listing adj → listing, co-op adj → co-op). Lease differs ONLY in the min
  // brokerage floor ($250) and the trust floor (payable not floored at 0). The external
  // broker referral never touches the Listing Commission (handled in referralSections).
  const listComm = listBasePct + listFlat + lAdjBefore;
  const listHst = listComm * hstRate;
  const listTotal = (listComm + listHst) + lAdjAfter;
  const coopComm = coopBasePct + coopFlat + cAdjBefore;
  const coopHst = coopComm * hstRate;
  const coopTotal = (coopComm + coopHst) + cAdjAfter;
  const totalComm = allZero ? 0 : listBasePct + coopBasePct + listFlat + coopFlat + lAdjBefore + cAdjBefore;
  const totalHst = totalComm * hstRate;
  const totalWithHst = (totalComm + totalHst) + lAdjAfter + cAdjAfter;
  const payableToClient = isLease ? (deposit - totalWithHst) : Math.max(deposit - totalWithHst, 0);
  const receivableFromLawyer = Math.min(deposit - totalWithHst, 0);
  // The agent/brokerage split (and agent commissions) are computed on the commission
  // AFTER the external broker referral; the external broker is paid out separately.
  const splitTotal = ROUND(listTotal - extAmt * g);
  const brokerageFloor = Math.max(splitTotal * brokerageSplit, minBrok * g);
  const agentPool = Math.max(Math.min(splitTotal * agentSplit, splitTotal - brokerageFloor), 0);
  const brokerageKeep = splitTotal - agentPool;

  const memberRows: ListingMemberRow[] = members.map((m, i) => {
    const teamShare = num(m.split) / 100;
    const earned = (agentPool - clientReferral) * teamShare;
    const commission = earned / g;
    const deduction = num(deductions[i]); // Agent Adjust + Advance for this member
    return {
      name: m.name, teamShare,
      commission: ROUND(commission), hst: ROUND(commission * hstRate), earned: ROUND(earned),
      deduction: ROUND(deduction), cashToPay: ROUND(earned - deduction),
      brokerageFromMember: ROUND(brokerageKeep * teamShare),
    };
  });
  const sumCash = memberRows.reduce((s, r) => s + r.cashToPay, 0);
  const sumDeduction = memberRows.reduce((s, r) => s + r.deduction, 0);
  const reconcile = coopTotal + ROUND(extAmt * g) + clientReferral + sumCash + brokerageKeep + sumDeduction;

  return {
    dealType: isLease ? 'Lease' : 'Sale',
    listing: { pct: listPct, commission: ROUND(listComm), hst: ROUND(listHst), total: ROUND(listTotal) },
    coop: { pct: coopPct, commission: ROUND(coopComm), hst: ROUND(coopHst), total: ROUND(coopTotal) },
    totals: { commission: ROUND(totalComm), hst: ROUND(totalHst), total: ROUND(totalWithHst) },
    extReferral: { amount: ROUND(extAmt), hst: ROUND(extHst), total: ROUND(extTotal) },
    trust: { deposit: ROUND(deposit), payableToClient: ROUND(payableToClient), receivableFromLawyer: ROUND(receivableFromLawyer) },
    coopPayout: ROUND(coopTotal),
    split: { agentSplit, brokerageSplit, agentPool: ROUND(agentPool), brokerageKeep: ROUND(brokerageKeep), brokerageFloor: ROUND(brokerageFloor) },
    clientReferral: ROUND(clientReferral),
    members: memberRows,
    brokerageKeep: ROUND(brokerageKeep),
    minBrok: { commission: minBrok, hst: ROUND(minBrok * hstRate), total: ROUND(minBrok * g) },
    balanceCheck: { expected: ROUND(totalWithHst), reconcile: ROUND(reconcile), pass: Math.abs(reconcile - totalWithHst) < 0.05 },
  };
}
