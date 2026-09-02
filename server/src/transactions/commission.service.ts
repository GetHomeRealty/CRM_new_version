import { Injectable } from '@nestjs/common';
import { PersonResolver } from '../core/person-resolver.service';
import { parseJsonObject, phpFloat, round2 } from '../common/serialize';
import { isListingType } from '../reference/transaction.constants';
import type { CommMember, CommissionSummary, CommissionTxn, Triple } from './commission.types';

const HST_RATE = 0.13;
const isPrecon = (type: string): boolean => type === 'Preconstruction';
const isListingFinancial = (type: string): boolean => isListingType(type) || type === 'Business Sale';

/**
 * Backend-authoritative commission math — a faithful port of Laravel's
 * App\Services\CommissionService. PHP is the source of truth; all rounding uses
 * PHP's round() semantics (see round2 / phpRound).
 */
@Injectable()
export class CommissionService {
  constructor(private readonly people: PersonResolver) {}

  /**
   * The resolver this engine resolves names with.
   *
   * Exposed so a bulk caller can PRE-LOAD profiles through the same rule rather than inventing its
   * own — see `ReportDataService.profileCache`, which got a different answer for a namesake by
   * building its map with a plain `findMany` and letting the last row win.
   */
  get personResolver(): PersonResolver { return this.people; }

  private readonly r = round2;
  /** PHP is_numeric($v) ? (float)$v : 0 (used for adjustment amounts). */
  private num(v: unknown): number {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  }
  private toInt(v: unknown): number {
    const n = parseInt(String(v ?? 0), 10);
    return Number.isFinite(n) ? n : 0;
  }
  private rows(adj: Record<string, unknown>, key: string): Record<string, unknown>[] {
    const v = adj[key];
    return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
  }

  /** Gross commission summary for the list / analytics tiles. */
  summarize(t: CommissionTxn): CommissionSummary {
    const amount = this.r(this.grossCommission(t));
    const hst = this.r(amount * HST_RATE);
    const total = this.r(amount + hst);
    const paid = t.comm_paid_status === 'Yes' || t.comm_status === 'Received';
    return { amount, hst, total, paid };
  }

  private grossCommission(t: CommissionTxn): number {
    const price = t.price;

    if (isPrecon(t.type)) {
      const manual = t.precon_comm_amt_manual;
      if (manual !== null && manual > 0) return manual;
      return (price * (t.precon_comm_pct ?? 0)) / 100;
    }

    if (isListingFinancial(t.type)) {
      const list = (price * (t.listing_comm_pct ?? 0)) / 100 + (t.listing_comm_flat ?? 0);
      const coop = (price * (t.coop_comm_pct ?? 0)) / 100 + (t.coop_comm_flat ?? 0);
      return list + coop;
    }

    if (t.comm_amt !== null && t.comm_amt > 0) return t.comm_amt;
    if (t.comm_pct !== null && t.comm_pct > 0) return (price * t.comm_pct) / 100;
    if (t.comm_type === '%' && t.comm_value > 0) return (price * t.comm_value) / 100;
    if (t.comm_type === 'Fixed' && t.comm_value > 0) return t.comm_value;
    return 0;
  }

  private grossBase(t: CommissionTxn): number {
    const price = t.price;
    if (t.comm_amt !== null && t.comm_amt > 0) return this.r(t.comm_amt);
    if (t.comm_pct !== null && t.comm_pct > 0) return this.r((price * t.comm_pct) / 100);
    if (t.comm_type === '%' && t.comm_value > 0) return this.r((price * t.comm_value) / 100);
    if (t.comm_type === 'Fixed' && t.comm_value > 0) return this.r(t.comm_value);
    return 0;
  }

  /** Full Financial breakdown, dispatched by transaction type. */
  /**
   * `profileCache` (optional) lets a bulk caller (e.g. the Reports engine) pre-load every
   * agent's profile once and avoid a per-transaction `users` lookup in agentDefaultSplit.
   * When omitted the behaviour is byte-identical to before (falls back to the DB query).
   */
  async breakdown(t: CommissionTxn, profileCache?: Map<string, Record<string, unknown>>): Promise<Record<string, unknown>> {
    const members = await this.resolveMembers(t, profileCache);
    if (isPrecon(t.type)) return this.breakdownPrecon(t, members);
    if (isListingFinancial(t.type)) return this.breakdownListing(t, members);
    return this.breakdownStandard(t, members);
  }

  private breakdownStandard(t: CommissionTxn, members: CommMember[]): Record<string, unknown> {
    const base = this.grossBase(t);
    const adjBefore = t.comm_adjust_enabled ? t.comm_adjust_before : 0;
    const adjAfter = t.comm_adjust_enabled ? t.comm_adjust_after : 0;

    const commission = this.r(base - adjBefore);
    const hst = this.r(commission * HST_RATE);
    const total = this.r(commission + hst - adjAfter);

    const adj = t.adjustments ?? {};
    const splitBase = this.r(commission - this.brokerReferralAmount(adj));
    const afterClient = this.agentCommissionsAfterClient(
      splitBase,
      members,
      200,
      adjBefore,
      adjAfter,
      this.clientReferralAmount(adj),
    );
    const agentCtx = { acComm: afterClient.commission, acTotal: afterClient.total, minBrokComm: 200, adjBefore, adjAfter, pool: afterClient.pool, entitlements: afterClient.entitlements };

    return {
      variant: 'standard',
      base_commission: base,
      commission,
      hst,
      total,
      adjust: { enabled: t.comm_adjust_enabled, before: t.comm_adjust_before, after: t.comm_adjust_after },
      referrals: this.referralSections(base, adj, afterClient),
      agents: this.agentLines(members, splitBase, adj, null, agentCtx),
      min_brokerage: { commission: 200, hst: 26, total: 226 },
    };
  }

  private breakdownPrecon(t: CommissionTxn, members: CommMember[]): Record<string, unknown> {
    const price = t.price;
    const netHst = t.precon_net_of_hst;

    const manual = t.precon_comm_amt_manual;
    let amount: number;
    if (manual !== null) {
      amount = this.r(manual);
    } else {
      const pct = t.precon_comm_pct ?? 0;
      amount = this.r((price * pct) / 100);
    }

    let commission: number;
    let hst: number;
    let total: number;
    if (netHst) {
      commission = this.r(amount / 1.13);
      hst = this.r(amount - commission);
      total = amount;
    } else {
      commission = amount;
      hst = this.r(amount * HST_RATE);
      total = this.r(amount + hst);
    }

    if (t.comm_adjust_enabled) {
      const adjB = t.comm_adjust_before;
      const adjA = t.comm_adjust_after;
      if (adjB !== 0) {
        commission = this.r(commission - adjB);
        hst = this.r(commission * HST_RATE);
        total = this.r(commission + hst);
      }
      if (adjA !== 0) {
        total = this.r(total - adjA);
      }
    }

    let count = t.precon_term_count ?? 0;
    if (count < 1) count = 0;
    const termRows = new Map<number, { pct: number | null; closing_date: Date | null }>();
    for (const p of t.preconTerms) termRows.set(p.term_no, { pct: p.pct, closing_date: p.closing_date });

    const adj = t.adjustments ?? {};
    const terms: Record<string, unknown>[] = [];
    let sumPct = 0;
    for (let k = 1; k <= count; k++) {
      const row = termRows.get(k);
      const tpct = row ? row.pct ?? 0 : 0;
      sumPct += tpct;
      const tAmt = this.r((price * tpct) / 100);
      const tHst = this.r(tAmt * HST_RATE);
      const tTotal = netHst ? tAmt : this.r(tAmt + tHst);
      const visible = members.filter((m) => this.visibleAtTerm(m, k));
      terms.push({
        term_no: k,
        pct: tpct,
        closing_date: row && row.closing_date ? row.closing_date.toISOString().slice(0, 10) : null,
        commission: tAmt,
        hst: tHst,
        total: tTotal,
        agents: this.agentLines(visible, tAmt, adj, k, null),
      });
    }

    const masterPct = t.precon_comm_pct ?? 0;
    const termsPctValid = masterPct <= 0 ? true : sumPct <= masterPct + 1e-9;

    return {
      variant: 'precon',
      net_of_hst: netHst,
      master: { pct: masterPct, amount, commission, hst, total },
      adjust: { enabled: t.comm_adjust_enabled, before: t.comm_adjust_before, after: t.comm_adjust_after },
      term_count: count,
      terms,
      terms_pct_valid: termsPctValid,
      min_brokerage: { commission: 200, hst: 26, total: 226 },
    };
  }

  private visibleAtTerm(m: CommMember, k: number): boolean {
    if ((m.scope ?? 'Entire') === 'Entire') return true;
    return m.terms.includes(k);
  }

  private breakdownListing(t: CommissionTxn, members: CommMember[]): Record<string, unknown> {
    const hst = HST_RATE;
    const g = 1 + hst;
    const price = t.price;
    const deposit = t.deposit;
    const isLease = /lease/i.test(t.type);
    const minBrok = isLease ? 250 : 499;

    const listPct = t.listing_comm_pct ?? 0;
    const coopPct = t.coop_comm_pct ?? 0;
    const listFlat = t.listing_comm_flat ?? 0;
    const coopFlat = t.coop_comm_flat ?? 0;
    const lAdjBefore = t.listing_adj_enabled ? t.listing_adj_before : 0;
    const lAdjAfter = t.listing_adj_enabled ? t.listing_adj_after : 0;
    const cAdjBefore = t.coop_adj_enabled ? t.coop_adj_before : 0;
    const cAdjAfter = t.coop_adj_enabled ? t.coop_adj_after : 0;

    const adj = t.adjustments ?? {};
    const extAmt = this.brokerReferralAmount(adj);
    const clientReferral = this.clientReferralAmount(adj);
    const first = members[0];
    const agentSplit = first ? first.agent_pct / 100 : isLease ? 0.95 : 0.9;
    const brokerageSplit = 1 - agentSplit;

    const listBasePct = (price * listPct) / 100;
    const coopBasePct = (price * coopPct) / 100;

    const extHst = extAmt * hst;
    const extTotal = extAmt + extHst;

    const allZero = listPct === 0 && listFlat === 0 && coopPct === 0 && coopFlat === 0;

    const listComm = listBasePct + listFlat + lAdjBefore;
    const listHst = listComm * hst;
    const listTotal = listComm + listHst + lAdjAfter;
    const coopComm = coopBasePct + coopFlat + cAdjBefore;
    const coopHst = coopComm * hst;
    const coopTotal = coopComm + coopHst + cAdjAfter;
    const totalComm = allZero ? 0 : listBasePct + coopBasePct + listFlat + coopFlat + lAdjBefore + cAdjBefore;
    const totalHst = totalComm * hst;
    const totalWithHst = totalComm + totalHst + lAdjAfter + cAdjAfter;
    const payableToClient = isLease ? deposit - totalWithHst : Math.max(deposit - totalWithHst, 0);
    const receivableFromLawyer = Math.min(deposit - totalWithHst, 0);
    const splitTotal = this.r(listTotal - extAmt * g);
    /*
     * TD-025 - EACH MEMBER IS PAID AT THEIR OWN RATE.
     *
     * This took members[0].agent_pct as one deal-level rate, built a single pool from it and sliced
     * that pool by each member's share - so two agents on a listing could never be on different
     * plans, and the per-member agent_pct in the response was reported but never used. Buying deals
     * have always paid per member. The brokerage confirmed on 2026-08-31 that rates may differ.
     *
     * IDENTICAL RESULTS WHERE EVERY MEMBER IS ON THE SAME RATE, which is every deal on this system
     * today: sum(slice x rate) equals splitTotal x rate. The client referral is still taken
     * pro-rata by share AFTER the rate, exactly as the pool version did, so that matches too.
     *
     * THE OLD PERCENTAGE FLOOR WAS A NO-OP: splitTotal minus splitTotal x (1 - agentSplit) IS
     * splitTotal x agentSplit, so the Math.min compared a value with itself. Only the absolute
     * minimum ever bound, and that is what is kept here.
     */
    const brokerageFloor = this.r(minBrok * g);
    const memberEarn = members.map((m) => {
      const share = m.split / 100;
      const rate = this.num(m.agent_pct) / 100;
      return { m, share, raw: splitTotal * share * rate - clientReferral * share };
    });
    const rawAgentTotal = memberEarn.reduce((s, x) => s + x.raw, 0);
    const maxAgentTotal = Math.max(splitTotal - brokerageFloor, 0);
    const floorScale = rawAgentTotal > maxAgentTotal && rawAgentTotal > 0 ? maxAgentTotal / rawAgentTotal : 1;
    const agentPool = Math.max(rawAgentTotal * floorScale, 0);
    const brokerageKeep = splitTotal - agentPool;
    const agentSplitEffective = splitTotal > 0 ? agentPool / splitTotal : agentSplit;

    const line = (wo: number): Triple => ({ commission: this.r(wo), hst: this.r(wo * hst), total: this.r(wo * g) });
    const memberRows: Record<string, unknown>[] = [];
    const agents: Record<string, unknown>[] = [];
    for (const m of members) {
      const teamShare = m.split / 100;
      const earned = Math.max((memberEarn.find((x) => x.m === m)?.raw ?? 0) * floorScale, 0);
      const commission = earned / g;
      const mHst = commission * hst;
      const advance = this.memberAdvance(adj, m.name);
      const deduction = this.memberDeduction(adj, m, null);
      const cashToPay = earned - deduction;
      const brokFromMember = splitTotal * teamShare - earned;

      memberRows.push({
        name: m.name,
        team_share: teamShare,
        commission: this.r(commission),
        hst: this.r(mHst),
        earned: this.r(earned),
        advance: this.r(advance),
        deduction: this.r(deduction),
        cash_to_pay: this.r(cashToPay),
        brokerage_from_member: this.r(brokFromMember),
      });
      agents.push({
        name: m.name,
        split: m.split,
        agent_pct: m.agent_pct,
        brok_pct: m.brok_pct,
        agent: { commission: this.r(commission), hst: this.r(mHst), total: this.r(earned) },
        brokerage: line(brokFromMember / g),
        t4a: { commission: this.r(commission), hst: this.r(mHst), total: this.r(earned) },
      });
    }

    const sumCash = memberRows.reduce((s, m) => s + (m.cash_to_pay as number), 0);
    const sumDeduction = memberRows.reduce((s, m) => s + (m.deduction as number), 0);
    const coopPayout = coopTotal;
    const reconcile = coopPayout + this.r(extAmt * g) + clientReferral + sumCash + brokerageKeep + sumDeduction;

    const listAfterBrokerComm = this.r(listComm - this.brokerReferralAmount(adj));
    const afterClient = this.agentCommissionsAfterClient(listAfterBrokerComm, members, 499, lAdjBefore, lAdjAfter, clientReferral);

    return {
      variant: 'listing',
      referrals: this.referralSections(listComm, adj, afterClient),
      deal_type: isLease ? 'Lease' : 'Sale',
      listing: { pct: listPct, commission: this.r(listComm), hst: this.r(listHst), total: this.r(listTotal) },
      coop: { pct: coopPct, commission: this.r(coopComm), hst: this.r(coopHst), total: this.r(coopTotal) },
      totals: { commission: this.r(totalComm), hst: this.r(totalHst), total: this.r(totalWithHst) },
      ext_referral: { amount: this.r(extAmt), hst: this.r(extHst), total: this.r(extTotal) },
      trust: {
        deposit: this.r(deposit),
        payable_to_client: this.r(payableToClient),
        receivable_from_lawyer: this.r(receivableFromLawyer),
      },
      coop_payout: this.r(coopPayout),
      split: {
        agent_split: agentSplitEffective,
        brokerage_split: brokerageSplit,
        agent_pool: this.r(agentPool),
        brokerage_keep: this.r(brokerageKeep),
        brokerage_floor: this.r(brokerageFloor),
      },
      client_referral: this.r(clientReferral),
      members: memberRows,
      brokerage_keep: this.r(brokerageKeep),
      adjust: {
        listing: { enabled: t.listing_adj_enabled, before: t.listing_adj_before, after: t.listing_adj_after },
        coop: { enabled: t.coop_adj_enabled, before: t.coop_adj_before, after: t.coop_adj_after },
      },
      agents,
      min_brokerage: { commission: minBrok, hst: this.r(minBrok * hst), total: this.r(minBrok * g) },
      balance_check: {
        expected: this.r(totalWithHst),
        reconcile: this.r(reconcile),
        pass: Math.abs(reconcile - totalWithHst) < 0.05,
      },
    };
  }

  private async resolveMembers(t: CommissionTxn, profileCache?: Map<string, Record<string, unknown>>): Promise<CommMember[]> {
    const members = t.teamMembers;
    if (members.length === 0 && t.agent) {
      // The id when the row has one, the name when it does not — see `PersonResolver`. This is the
      // path U-C1 was measured on: with a deactivated namesake it resolved to the wrong person's
      // percentage, and this is what stops it.
      const split = await this.agentDefaultSplit(t.agent, t.type, profileCache, t.agent_user_id);
      return [{ name: t.agent, user_id: t.agent_user_id, split: 100, agent_pct: split.agent, brok_pct: split.brok, scope: 'Entire', terms: [] }];
    }
    // Members exist, but nobody has been given a share yet — `team_members.split` defaults to 0,
    // and selecting agents on the Add Transaction screen adds them with no split. Every agent line
    // would otherwise multiply out to zero and the whole Financial section would read as blank.
    // Until the splits are entered the primary agent holds the entire deal, so give them 100%.
    // The moment any real split is entered this no longer applies and the stored values are used.
    if (members.length > 0 && members.every((m) => !(m.split > 0))) {
      const primary = t.agent ? members.findIndex((m) => m.name === t.agent) : -1;
      if (primary !== -1) return members.map((m, i) => (i === primary ? { ...m, split: 100 } : m));
    }
    return members;
  }

  /**
   * The split for one person, by id where the record has one.
   *
   * `userId` is preferred over `name` because a name is editable and not unique over time — see
   * `PersonResolver`. The name is still accepted and still works, which is what keeps rows written
   * before the id column resolving exactly as they did.
   */
  private async agentDefaultSplit(name: string | null, type: string | null, profileCache?: Map<string, Record<string, unknown>>, userId?: number | null): Promise<{ agent: number; brok: number }> {
    const isLease = /lease/i.test(type ?? '');
    let agent = isLease ? 95 : 90;
    if (name) {
      const p = profileCache
        ? (profileCache.get(name) ?? {})
        : parseJsonObject((await this.people.resolve(userId, name))?.profile);
      const v = p[isLease ? 'lease_comm_pct' : 'agent_comm_pct'];
      if (v !== null && v !== undefined && v !== '') agent = phpFloat(v);
    }
    return { agent, brok: round2(100 - agent) };
  }

  private agentLines(
    members: CommMember[],
    commissionWoHst: number,
    adjustments: Record<string, unknown>,
    term: number | null,
    agentCtx: { acTotal: number; pool?: number; entitlements?: Map<CommMember, number> } | null,
  ): Record<string, unknown>[] {
    const line = (wo: number): Triple => ({
      commission: wo,
      hst: this.r(wo * HST_RATE),
      total: this.r(wo * (1 + HST_RATE)),
    });

    return members.map((m) => {
      const memberWoHst = this.r((commissionWoHst * m.split) / 100);
      const agentWoHst = this.r((memberWoHst * m.agent_pct) / 100);
      const brokWoHst = this.r((memberWoHst * m.brok_pct) / 100);
      const deduction = this.memberDeduction(adjustments, m, term);

      let agent: Triple;
      let t4a: Triple;
      if (agentCtx !== null) {
        agent = this.agentCommissionLine(m, agentCtx, deduction);
        t4a = this.agentCommissionLine(m, agentCtx, 0);
      } else {
        agent = {
          commission: agentWoHst,
          hst: this.r(agentWoHst * HST_RATE),
          total: this.r(agentWoHst * (1 + HST_RATE) - deduction),
        };
        t4a = line(agentWoHst);
      }

      return {
        name: m.name,
        split: m.split,
        agent_pct: m.agent_pct,
        brok_pct: m.brok_pct,
        adjustment: deduction,
        agent,
        brokerage: line(brokWoHst),
        t4a,
      };
    });
  }

  private agentCommissionLine(m: CommMember, ctx: { acTotal: number; pool?: number; entitlements?: Map<CommMember, number> }, deduction: number): Triple {
    const g = 1 + HST_RATE;
    // TD-025: share the pool by each member's OWN entitlement. Paying by split alone gave every
    // member the weighted-average rate, so on a mixed-plan team the 90/10 member was short and
    // the 70/30 member over by the same amount. Falls back to split when entitlements are
    // absent - which is exactly the previous behaviour, never a zero or negative cheque.
    const own = ctx.entitlements?.get(m);
    const share = own !== undefined && ctx.pool !== undefined && ctx.pool > 0 ? own / ctx.pool : m.split / 100;
    const total = this.r((ctx.acTotal ?? 0) * share - deduction);
    const commission = this.r(total / g);
    const hst = this.r(total - commission);
    return { commission, hst, total };
  }

  private memberDeduction(adj: Record<string, unknown>, m: CommMember, term: number | null): number {
    if (Object.keys(adj).length === 0) return 0;
    let sum = 0;
    const name = m.name;

    if ((adj['agent_adjust'] ?? 'No') === 'Yes') {
      for (const r of this.rows(adj, 'adjustment_rows')) {
        if (term !== null && this.toInt(r['term'] ?? 0) !== term) continue;
        if ((r['agent'] ?? null) === name) sum += this.num(r['amount'] ?? 0);
      }
    }
    if ((adj['advance_payment'] ?? 'No') === 'Yes') {
      for (const r of this.rows(adj, 'advance_rows')) {
        if (term !== null && this.toInt(r['term'] ?? 0) !== term) continue;
        if ((r['agent'] ?? null) === name) sum += this.num(r['amount'] ?? 0);
      }
    }
    return this.r(sum);
  }

  private memberAdvance(adj: Record<string, unknown>, name: string | null): number {
    if ((adj['advance_payment'] ?? 'No') !== 'Yes' || name === null) return 0;
    let sum = 0;
    for (const r of this.rows(adj, 'advance_rows')) {
      if ((r['agent'] ?? null) === name) sum += this.num(r['amount'] ?? 0);
    }
    return sum;
  }

  private brokerReferralAmount(adj: Record<string, unknown>): number {
    if ((adj['ext_referral'] ?? 'No') !== 'Yes') return 0;
    const ext = adj['ext'] as Record<string, unknown> | undefined;
    return this.num(ext?.['amount'] ?? 0);
  }

  private clientReferralAmount(adj: Record<string, unknown>): number {
    if ((adj['client_referral'] ?? 'No') !== 'Yes') return 0;
    let sum = 0;
    for (const r of this.rows(adj, 'client_rows')) sum += this.num(r['amount'] ?? 0);
    return sum;
  }

  private referralSections(
    dealComm: number,
    adj: Record<string, unknown>,
    afterClient: Triple | null,
  ): Record<string, unknown> | null {
    const showBroker = (adj['ext_referral'] ?? 'No') === 'Yes';
    const showClient = (adj['client_referral'] ?? 'No') === 'Yes';
    if (!showBroker && !showClient) return null;
    const afterBrokerComm = this.r(dealComm - this.brokerReferralAmount(adj));
    const afterBroker: Triple = {
      commission: afterBrokerComm,
      hst: this.r(afterBrokerComm * HST_RATE),
      total: this.r(afterBrokerComm * (1 + HST_RATE)),
    };
    return {
      broker_amount: this.r(this.brokerReferralAmount(adj)),
      client_amount: this.r(this.clientReferralAmount(adj)),
      show_broker: showBroker,
      show_client: showClient,
      after_broker: afterBroker,
      after_client: afterClient,
    };
  }

  private agentCommissionsAfterClient(
    lc: number,
    members: CommMember[],
    minBrokComm: number,
    adjBefore: number,
    adjAfter: number,
    clientReferral: number,
  ): Triple & { pool: number; entitlements: Map<CommMember, number> } {
    const g = 1 + HST_RATE;
    const minBrokTotal = minBrokComm * g;
    // TD-025: keep each member's OWN entitlement, not only the sum. Keyed by the member OBJECT
    // rather than by index or name, so a later filter, re-sort or duplicate name cannot hand one
    // person another's share.
    const entitlements = new Map<CommMember, number>();
    let pool = 0;
    for (const m of members) {
      const a = m.agent_pct / 100;
      const b = m.brok_pct / 100;
      const split = m.split / 100;
      const brokRaw = Math.max(lc * b * split, minBrokTotal);
      const floor = lc === 0 ? 0 : brokRaw - (adjBefore * g - adjAfter);
      const own = Math.max(0, Math.min(lc * a * split, lc - floor));
      entitlements.set(m, own);
      pool += own;
    }
    const total = this.r(pool * g - clientReferral);
    const commission = this.r(total / g);
    const hst = this.r(total - commission);
    return { commission, hst, total, pool, entitlements };
  }
}
