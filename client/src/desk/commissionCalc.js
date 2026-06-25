// Commission calculation module.
//
// Implements the brokerage commission spec verbatim. The SAME logic applies to
// RESIDENTIAL_BUYING and RESIDENTIAL_LEASE — the transaction type is metadata
// only and does not affect any calculation.
//
// All currency is CAD. HST is configurable; default 13% (Ontario). Every "Total"
// that includes HST is `commission * (1 + HST_RATE)`, and the commission is
// back-solved as `total / (1 + HST_RATE)`.

export const HST_RATE = 0.13;

const ROUND = (x, n = 2) => {
  const f = 10 ** n;
  return Math.round((x + Number.EPSILON) * f) / f;
};
const num = (v) => (Number.isFinite(+v) ? +v : 0);

/**
 * @param {object} input  per-transaction inputs (see spec §1)
 * @param {number} hstRate configurable HST rate (default HST_RATE)
 * @returns {object} the commission breakdown (spec §3)
 */
export function computeCommission(input = {}, hstRate = HST_RATE) {
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
 *
 * @param {object} adjustments  transaction.adjustments JSON (or null)
 * @param {Array}  members      [{ name, split, ... }] aligned to the output
 * @param {number|null} term    1-based precon term, or null for the whole deal
 * @returns {Array<{total:number, agentAdjust:number, advance:number}>}
 *          per-member pre-HST deduction, broken down by source
 */
export function agentAdjustments(adjustments, members = [], term = null) {
  const a = adjustments || {};
  const out = members.map(() => ({ agentAdjust: 0, advance: 0 }));
  const idxByName = {};
  members.forEach((m, i) => { if (m && m.name) idxByName[m.name] = i; });

  const addNamed = (rows, enabled, key) => {
    if (!enabled) return;
    (rows || []).forEach((r) => {
      if (term != null && Number(r.term) !== Number(term)) return;
      const i = idxByName[r.agent];
      if (i != null) out[i][key] += num(r.amount);
    });
  };
  addNamed(a.adjustment_rows, a.agent_adjust === 'Yes', 'agentAdjust');
  addNamed(a.advance_rows, a.advance_payment === 'Yes', 'advance');

  return out.map((d) => ({
    agentAdjust: ROUND(d.agentAdjust),
    advance: ROUND(d.advance),
    total: ROUND(d.agentAdjust + d.advance),
  }));
}

/**
 * "Commissions after broker referral" section — Commission = full deal commission
 * − broker referral, HST = ×rate, Total = ×(1+rate). Also surfaces the referral
 * amounts and show flags. (The "Agent Commissions after client referral" section
 * is computed by agentCommissionsAfterClient.)
 *
 * @param {number} dealComm     full deal commission without HST (pre-referral)
 * @param {object} adjustments  transaction.adjustments JSON (or null)
 * @param {number} hstRate
 * @returns {{ brokerAmount:number, clientAmount:number, showBroker:boolean, showClient:boolean,
 *   afterBroker:{commission:number,hst:number,total:number} }}
 */
export function referralSections(dealComm, adjustments, hstRate = HST_RATE) {
  const a = adjustments || {};
  const showBroker = a.ext_referral === 'Yes';
  const showClient = a.client_referral === 'Yes';
  const brokerAmount = showBroker ? num(a.ext && a.ext.amount) : 0;
  const clientAmount = showClient ? (a.client_rows || []).reduce((s, r) => s + num(r.amount), 0) : 0;

  const fullComm = ROUND(num(dealComm));
  const afterBrokerComm = ROUND(fullComm - brokerAmount);
  const afterBroker = { commission: afterBrokerComm, hst: ROUND(afterBrokerComm * hstRate), total: ROUND(afterBrokerComm * (1 + hstRate)) };

  return { brokerAmount: ROUND(brokerAmount), clientAmount: ROUND(clientAmount), showBroker, showClient, afterBroker };
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
 *
 * @param {number} listingComm  listing-side commission without HST
 * @param {Array}  members      [{ agent_pct, brok_pct, split }]
 * @param {object} opts         { minBrokComm, adjBefore, adjAfter, clientReferral }
 * @param {number} hstRate
 */
export function agentCommissionsAfterClient(listingComm, members = [], opts = {}, hstRate = HST_RATE) {
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
 *
 * @param {object} member  { split }
 * @param {object} ctx     { acTotal }  Total from "Agent Commissions after client referral"
 * @param {number} deduction  this member's Adjustment + Advance amount (off the Total)
 * @param {number} hstRate
 */
export function agentCommissionLine(member, ctx, deduction = 0, hstRate = HST_RATE) {
  const g = 1 + hstRate;
  const split = num(member.split) / 100;
  const total = ROUND(num(ctx.acTotal) * split - num(deduction));
  const commission = ROUND(total / g);
  const hst = ROUND(total - commission);
  return { commission, hst, total };
}
