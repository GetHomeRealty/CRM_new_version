import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { PrismaService } from '../prisma/prisma.service';
import { CommissionService } from '../transactions/commission.service';
import { commissionInclude, normalizeCommissionTxn } from '../transactions/commission.loader';
import { parseJsonObject, phpFloat } from '../common/serialize';
import {
  Triple, ZERO_TRIPLE, num, money, sum, brokerageCommission, coopPayout,
  splitRatios, agentPaymentsPaid, advancePayments, cashback, referral, loanRepayments,
  type CashbackInfo, type ReferralInfo, agentLines, addTriple,
} from './report-financials';
import {
  docStatus, docCategory, docCounts, documentationStatus, groupStatus, expiryStatus,
  isAmendment, isWaiver, type DocRow, type DocCounts, type CondRow,
} from './report-documents';

/**
 * Transactions pulled into memory at a time while enriching a report.
 *
 * Small enough that one page's relation graph — ten documents, two clients, statuses, team members
 * — stays well inside what the query engine will materialise, large enough that 80,000 deals is 160
 * round trips rather than 80,000. See `load`.
 */
const LOAD_PAGE_SIZE = 500;

const dateStr = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);
/** Configured currency format (matches the app's formatCurrency: en-CA, always 2 decimals). */
const fmtNum = (n: number): string => Number(n).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const trimPct = (n: number): string => (Number.isInteger(n) ? String(n) : String(money(n)));
/** Same spelling `splitRatios(bd)` uses, so the dropdown values match the row values exactly. */
const trimRatio = trimPct;
/** Decimal-safe a − b − c … clamped at ≥ 0 (agent balances never go negative). */
const balanceOf = (due: number, ...deductions: number[]): number =>
  money(Decimal.max(0, deductions.reduce((acc, d) => acc.minus(num(d)), new Decimal(num(due)))));

/** A fully-computed transaction row with every field any of the 14 reports may need. */
export interface EnrichedTxn {
  id: number;
  trade_no: string;
  type: string;                 // Type of Deal (existing transaction type)
  property: string | null;
  offer_date: string | null;
  closing_date: string | null;
  created_at: string | null;
  updated_at: string | null;
  agent: string | null;         // primary agent
  agent_names: string[];        // all split agents (scoped for agent users)
  is_team: boolean;
  split_ratios: string[];
  /** Every split agent's own line (one entry per agent, incl. single-agent deals). */
  splits: { name: string; ratio: string; split: number; agent: Triple; brokerage: Triple }[];
  /** 'Yes' once any CTA→BA transfer row is Yes; otherwise 'No' (Admin Activities → CTA to BA). */
  cta_to_ba: string;
  price: number;
  listing_price: number | null;
  closed_price: number | null;
  comm_type: string | null;
  comm_value: number;
  comm_pct: number | null;
  comm_amt: number | null;
  comm_display: string;         // "2.5%" or "$5,000" — Commission % / Amount
  payment_type: string | null;
  total: Triple;                // transaction total commission (§9A)
  agentComm: Triple;            // agent commission totals (§9B, scoped)
  brokerageComm: Triple;        // brokerage split totals, excl. min brokerage (§9D)
  coopOut: Triple;              // co-op side paid to the other brokerage (TD-072/TD-105)
  agent_payment_status: string; // from Agent FAQ Center agent_commission_paid_status
  agent_paid: number;           // agent commission actually paid (admin_activities)
  agent_paid_date: string | null;
  any_agent_paid: boolean;
  advance: number;
  advance_date: string | null;
  agent_balance: number;        // agent commission due − advance − other agent payments (≥0)
  adjustments_total: number;    // commission adjustments (before+after HST)
  cashback: CashbackInfo;
  referral: ReferralInfo | null;
  statuses: string[];
  is_closed: boolean;
  is_mutual_release: boolean;
  commission_received: boolean;  // transaction comm_status === 'Received' (brokerage received)
  // new backward-compatible columns (null on legacy records)
  lead_source: string | null;
  lead_assigned_date: string | null;
  lead_converted_date: string | null;
  review_email_sent_at: string | null;
  review_received_at: string | null;
  gift_coupon_value: number | null;
  gift_coupon_issued_at: string | null;

  // ---- documentation reporting (§ Documentation Reports) ----
  /** Client names on the deal (buyer/seller/landlord/tenant), joined for display. */
  client_names: string[];
  /** Every non-deleted document on the transaction, with its reporting status + category. */
  docs: DocRow[];
  doc_counts: DocCounts;
  documentation_status: string;   // Pending / Invalid Documentation / Complete / No Documents
  last_doc_update: string | null; // most recent document change
  reco_audit_ready: string;       // 'Yes' | 'No'
  reco_audit_remarks: string | null;
  reco_review_at: string | null;  // transactions.agent_review_at (compliance review)
  conditional_offer: string;      // 'Yes' | 'No'
  conditions: CondRow[];
  /** Waiver / amendment documentation, reported separately from each other. */
  waiver_status: string;
  amendment_status: string;
}

/** The transaction shape `load()` fetches, including the documentation relations. */
type LoadedTxn = Prisma.transactionsGetPayload<{ include: typeof commissionInclude }> & {
  transaction_statuses: { status: string }[];
  documents: {
    id: number; title: string; status: string; validation: string; mandatory: boolean;
    is_condition: boolean; reminder: boolean; file_path: string | null; file_name: string | null;
    remarks: string | null; created_at: Date | null; updated_at: Date | null;
  }[];
  conditions: { id: number; type: string; custom_name: string | null; deadline: Date | null; status: string }[];
  clients: { name: string }[];
};

/**
 * Which of the three documentation relations a report reads.
 *
 * Declared per report rather than inferred, because the consequence of getting it wrong is not an
 * error: a report that reads `docs` without asking for them sees an empty list and reports zero
 * pending documents, which looks like good news. `report-needs.spec.ts` runs every report with the
 * relations forced on and with its declaration honoured and requires identical output, which is what
 * turns "declared" into "checked".
 */
export interface ReportNeeds {
  documents?: boolean;
  conditions?: boolean;
  clients?: boolean;
}

/** The default when a caller says nothing: everything, as it was before this existed. */
const ALL_NEEDS: ReportNeeds = { documents: true, conditions: true, clients: true };

/**
 * THE COLUMNS THE ENRICHMENT ACTUALLY READS — and nothing else.
 *
 * `transactions` has eighty-six columns. This used to fetch all of them, because `include` fetches
 * every scalar by definition, and then read about forty. Measured at 80,000 deals: 7.7 s to fetch,
 * against 2.5 s for this list. The cost is not the bytes — the rows average 259 of them — it is
 * Prisma hydrating eighty-six fields per row, eighty thousand times, on every slow-path report run.
 *
 * IT IS EXHAUSTIVE, AND THE DANGER IS THAT IT STOPS BEING SO. A column left out of this list does
 * not raise an error: it arrives `undefined`, and whatever is derived from it comes out null or zero
 * — a report that quietly reports no lead source, or a commission computed without its adjustment.
 * That is the same failure mode `ReportNeeds` has, and it is guarded the same way:
 * `report-select.spec.ts` writes a transaction with EVERY scalar column set to a distinctive value,
 * loads it through this select and through a full row, and requires the enriched results to be
 * identical. Add a column read to `enrich` or `normalizeCommissionTxn` without adding it here and
 * that spec fails.
 */
const TXN_SELECT = {
  // identity and display
  id: true, trade_no: true, type: true, property: true, agent: true, agent_user_id: true,
  offer_date: true, closing_date: true, created_at: true, updated_at: true,
  // financial inputs — every field normalizeCommissionTxn reads
  price: true, deposit: true, listing_price: true,
  comm_type: true, comm_value: true, comm_pct: true, comm_amt: true,
  comm_adjust_enabled: true, comm_adjust_before: true, comm_adjust_after: true,
  listing_comm_pct: true, coop_comm_pct: true, listing_comm_flat: true, coop_comm_flat: true,
  listing_adj_enabled: true, listing_adj_before: true, listing_adj_after: true,
  coop_adj_enabled: true, coop_adj_before: true, coop_adj_after: true,
  precon_net_of_hst: true, precon_comm_pct: true, precon_comm_amt_manual: true, precon_term_count: true,
  comm_paid_status: true, comm_status: true, payment_type: true,
  // the three JSON blobs the enrichment parses
  adjustments: true, admin_activities: true, activity_tracker: true,
  // lead, review and compliance columns
  lead_source: true, lead_assigned_date: true, lead_converted_date: true,
  review_email_sent_at: true, review_received_at: true,
  gift_coupon_value: true, gift_coupon_issued_at: true,
  agent_review_at: true, reco_audit_ready: true, reco_audit_remarks: true, conditional_offer: true,
} satisfies Prisma.transactionsSelect;

/** The relation selections, likewise trimmed to the fields the enrichment reads. */
const TEAM_SELECT = {
  select: {
    name: true, user_id: true, split: true, agent_pct: true, brok_pct: true, scope: true,
    team_member_terms: { select: { term_no: true } },
  },
  orderBy: { position: 'asc' },
} as const;
const PRECON_SELECT = { select: { term_no: true, pct: true, closing_date: true }, orderBy: { term_no: 'asc' } } as const;
const DOCUMENT_SELECT = {
  where: { deleted_at: null },
  select: {
    id: true, title: true, status: true, validation: true, mandatory: true, is_condition: true,
    reminder: true, file_path: true, file_name: true, remarks: true, created_at: true, updated_at: true,
  },
  orderBy: { position: 'asc' },
} as const;
const CONDITION_SELECT = {
  select: { id: true, type: true, custom_name: true, deadline: true, status: true },
  orderBy: { position: 'asc' },
} as const;

/** Exported for `report-select.spec.ts`, which is what keeps the list above honest. */
export const REPORT_TXN_SELECT = TXN_SELECT;

export interface LoadOptions {
  /**
   * An extra predicate ANDed into the query. MUST BE A SUPERSET of whatever the caller will filter
   * with afterwards — see `load`.
   */
  where?: Prisma.transactionsWhereInput;
  needs?: ReportNeeds;
}

/** Scope for a report run: an agent user is locked to their own name; admins may pass agents. */
export interface DataScope {
  /**
   * When set, only this agent's transactions are loaded and financials are scoped to them.
   *
   * This is a DISPLAY key, not the authorization key — it selects which split lines inside a deal
   * are the caller's own. Which deals may be loaded at all is decided by `lockedUserId` below.
   */
  lockedAgent?: string | null;
  /**
   * The locked agent's user id — the authorization key.
   *
   * A name is editable and not unique (two active accounts here share one), so scoping a report to
   * `agent = 'Akhil'` handed one Akhil the other's deals. The query now matches
   * `agent_user_id`/`team_members.user_id` and falls back to the name only for rows that never
   * resolved to an account. Absent means "no id known": the name fallback alone is used, which is
   * the behaviour this replaces.
   */
  lockedUserId?: number | null;
  /** admin/authorized: restrict to these agent names (from the Agent filter), else all. */
  agents?: string[];
}

@Injectable()
export class ReportDataService {
  constructor(private readonly prisma: PrismaService, private readonly commission: CommissionService) {}

  /**
   * name → parsed profile, loaded once so breakdown() never does per-txn user lookups.
   *
   * RESOLVED THROUGH `PersonResolver`, and it has to be. This built the map with a plain
   * `findMany` and `map.set(u.name, …)` per row, so for two accounts sharing a name the LAST row the
   * planner happened to return won — no `orderBy`, no rule, and a different answer after a VACUUM.
   *
   * The rest of the application resolves a name one way: an Active row wins, ties break on the
   * lowest id. Measured against that rule on the 80,000-deal corpus, this cache disagreed on 26
   * deals and moved $16,250 from the brokerage side of the split to the agent side — one namesake
   * pair with commission percentages of 90 and 80. The SQL report totals follow `PersonResolver`,
   * so the two paths returned different footers for the same report; this is the side that was
   * wrong.
   *
   * A duplicate name is still ambiguous by construction. What fixes it properly is the id —
   * `agent_user_id` and `team_members.user_id`, preferred wherever a row has them. This makes the
   * fallback deterministic and consistent, which is all a name can offer.
   */
  private async profileCache(): Promise<Map<string, Record<string, unknown>>> {
    const names = (await this.prisma.users.findMany({ select: { name: true }, distinct: ['name'] }))
      .map((u) => u.name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0);
    const resolved = await this.commission.personResolver.resolveManyByName(names);
    const map = new Map<string, Record<string, unknown>>();
    for (const name of names) map.set(name, parseJsonObject(resolved.get(name)?.profile));
    return map;
  }

  /**
   * The visibility term for a scope, or null for "everything".
   *
   * A LOCKED AGENT IS MATCHED BY ID. That is the authorization boundary of every report, of the
   * documents expansion, of the reminder history and of every bulk export — the one place where
   * getting the identity rule wrong hands one agent another's deals. The name is kept as a fallback
   * for legacy rows carrying no `agent_user_id`, exactly as `common/transaction-scope.ts` does.
   *
   * The ADMIN agent filter (`scope.agents`) stays name-based: it is a filter somebody chose from a
   * list of names, applied to data they may already read in full, so it narrows a result set rather
   * than deciding access.
   */
  private visibilityWhere(scope: DataScope): Prisma.transactionsWhereInput[] | null {
    const locked = (scope.lockedAgent ?? '').trim();
    const lockedId = typeof scope.lockedUserId === 'number' && Number.isFinite(scope.lockedUserId) ? scope.lockedUserId : null;

    if (locked !== '' || lockedId !== null) {
      const or: Prisma.transactionsWhereInput[] = [];
      if (lockedId !== null) {
        or.push({ agent_user_id: lockedId });
        or.push({ team_members: { some: { user_id: lockedId } } });
      }
      if (locked !== '') {
        or.push({ AND: [{ agent_user_id: null }, { agent: locked }] });
        or.push({ team_members: { some: { AND: [{ user_id: null }, { name: locked }] } } });
      }
      // Neither an id nor a name is not "show everything" — it is "show nothing".
      return or.length ? or : [{ id: { in: [] } }];
    }

    const names = scope.agents && scope.agents.length ? scope.agents : null;
    if (!names) return null;
    return [{ agent: { in: names } }, { team_members: { some: { name: { in: names } } } }];
  }

  /**
   * Load the transactions in scope, enriched.
   *
   * `opts.where` NARROWS WHAT IS READ AT ALL, and is where the report's own predicates now live —
   * see `ReportsService.compute`. It is required to be a SUPERSET of the report's JavaScript
   * predicate, never an equivalent of it: the exact predicate still runs afterwards on whatever this
   * returns, so a slightly generous SQL filter costs a little work and a slightly strict one silently
   * drops rows from somebody's report.
   *
   * `opts.needs` decides which RELATIONS are fetched. Every report used to get all three — documents,
   * conditions and clients — including the eleven that never read them. At 80,000 deals and 800,000
   * documents that is most of a million rows loaded, hydrated and discarded per run of a commission
   * report. A relation that is not asked for arrives as an empty array, and the enrichment derived
   * from it is empty with it, which is why the declaration is per report and checked by
   * `report-needs.spec.ts` rather than inferred.
   */
  async load(scope: DataScope, opts: LoadOptions = {}): Promise<EnrichedTxn[]> {
    const where: Prisma.transactionsWhereInput = { deleted_at: null };
    const visibility = this.visibilityWhere(scope);
    if (visibility) where.OR = visibility;
    if (opts.where) where.AND = [opts.where];

    const needs = opts.needs ?? ALL_NEEDS;
    const cache = await this.profileCache();
    const out: EnrichedTxn[] = [];

    /*
     * READ IN PAGES, NOT IN ONE QUERY.
     *
     * This was a single unbounded `findMany` with five relations attached — every transaction, each
     * with its statuses, documents, conditions, clients, team members and preconstruction terms.
     *
     * MEASURED at 80,000 deals / 800,000 documents: it did not merely get slow, it CRASHED. The
     * Prisma query engine panicked — `query-engine/query-structure/src/record.rs:69: no entry found
     * for key` — and every one of the five reports tested failed outright. At 8,000 deals the same
     * call took 2.9 s and held ~450 MB; the failure is what that curve arrives at.
     *
     * Cursor paging by ascending id, the same shape `DashboardService.commissions` already uses.
     * Two properties matter and both are preserved exactly:
     *
     *   · THE RESULT IS IDENTICAL. Same `where`, same relations, same ascending id order, same
     *     enrichment per row. Callers still receive the complete filtered set, so totals, sections
     *     and exports are computed over everything exactly as before — nothing is truncated and no
     *     report's numbers change.
     *   · MEMORY IS BOUNDED PER PAGE rather than by brokerage size. The enriched rows still
     *     accumulate — that is what the caller asked for — but the raw relation graph for one page
     *     is released before the next is fetched, which is where the engine was failing.
     *
     * This does not make Reports fast; it makes them possible. Reducing the enriched set itself
     * means pushing the report predicates into SQL, which is a redesign of the reports data layer
     * rather than a repair, and is recorded as an open item.
     */
    /*
     * THE NEXT PAGE IS ASKED FOR BEFORE THIS ONE IS ENRICHED.
     *
     * Fetching and enriching are the two halves of this loop and they use different machines: the
     * fetch waits on PostgreSQL, the enrichment burns CPU in Node. Issuing the next query before
     * enriching the page in hand lets the wait overlap the work instead of following it.
     *
     * MEASURED, because the theory promises more than it delivers here: 8.95 s → 8.1 s at 80,000
     * deals, about eight per cent. A CPU profile shows 4.3 s of the run with the JavaScript thread
     * idle, but most of that is not round-trip latency waiting to be hidden — it is the Prisma query
     * engine doing its own work, which this cannot overlap. The change is kept because it is free and
     * real, not because it is the answer; what actually costs the time is reading 79,037 deals at all,
     * which is what the fast paths avoid.
     *
     * Nothing else changes: same query, same cursor, same order, same enrichment, one page in flight
     * at a time so memory stays bounded exactly as before.
     */
    const fetchFrom = (cursor: number | undefined) => this.prisma.transactions.findMany({
      where,
      // `select`, not `include` — see TXN_SELECT. The relations are the same ones
      // `commissionInclude` names, trimmed to the fields that are read.
      select: {
        ...TXN_SELECT,
        team_members: TEAM_SELECT,
        precon_terms: PRECON_SELECT,
        transaction_statuses: { select: { status: true } },
        // documentation reporting: documents, their conditions, and the deal's clients — fetched
        // only for the reports that read them.
        ...(needs.documents ? { documents: DOCUMENT_SELECT } : {}),
        ...(needs.conditions ? { conditions: CONDITION_SELECT } : {}),
        ...(needs.clients ? { clients: { orderBy: { position: 'asc' }, select: { name: true } } } : {}),
      } as Prisma.transactionsSelect,
      orderBy: { id: 'asc' },
      take: LOAD_PAGE_SIZE,
      ...(cursor === undefined ? {} : { skip: 1, cursor: { id: cursor } }),
    });

    let inflight = fetchFrom(undefined);
    for (;;) {
      const page = await inflight;
      if (page.length === 0) break;

      // A short page is the last one; asking for another would be a wasted round trip AND would
      // leave a promise nobody awaits.
      const more = page.length === LOAD_PAGE_SIZE;
      if (more) inflight = fetchFrom(page[page.length - 1].id as number);

      for (const row of page) {
        // An un-fetched relation is absent rather than empty, so it is filled in here — `enrich`
        // reads all three unconditionally and the report that asked for none of them derives
        // nothing from them.
        const t = row as unknown as LoadedTxn;
        t.documents ??= [];
        t.conditions ??= [];
        t.clients ??= [];
        const cinput = normalizeCommissionTxn(t);
        const bd = await this.commission.breakdown(cinput, cache);
        const summary = this.commission.summarize(cinput);
        out.push(this.enrich(t, bd, summary, scope.lockedAgent ?? null));
      }

      if (!more) break;
    }
    return out;
  }

  private enrich(
    t: LoadedTxn,
    bd: Record<string, unknown>,
    summary: { amount: number; hst: number; total: number },
    lockedAgent: string | null,
  ): EnrichedTxn {
    const adjustments = parseJsonObject(t.adjustments);
    const admin = parseJsonObject(t.admin_activities);
    const tracker = parseJsonObject(t.activity_tracker);

    const allNames = agentLines(bd).map((l) => String(l.name ?? '')).filter((n) => n !== '');
    // Agent users only ever see their own split line(s); admins see the whole split.
    const scopedNames = lockedAgent ? allNames.filter((n) => n === lockedAgent) : allNames;
    const scopedLines = lockedAgent ? agentLines(bd).filter((l) => String(l.name) === lockedAgent) : agentLines(bd);

    const agentComm = scopedLines.reduce<Triple>((a, l) => addTriple(a, { commission: num((l.agent as Record<string, unknown>)?.commission), hst: num((l.agent as Record<string, unknown>)?.hst), total: num((l.agent as Record<string, unknown>)?.total) }), { ...ZERO_TRIPLE });
    const brokerageComm = lockedAgent ? scopedLines.reduce<Triple>((a, l) => addTriple(a, { commission: num((l.brokerage as Record<string, unknown>)?.commission), hst: num((l.brokerage as Record<string, unknown>)?.hst), total: num((l.brokerage as Record<string, unknown>)?.total) }), { ...ZERO_TRIPLE }) : brokerageCommission(bd);
    const coopOut = coopPayout(bd);

    const paid = agentPaymentsPaid(admin, scopedNames);
    const adv = advancePayments(adjustments, lockedAgent ? [lockedAgent] : null);
    const balance = balanceOf(agentComm.total, adv.total, paid.totalPaid);

    const statuses = t.transaction_statuses.map((s) => s.status);
    const adjust = (bd.adjust as Record<string, unknown>) ?? {};
    const adjustmentsTotal = sum([num(adjust.before), num(adjust.after)]);

    // Commission % / Amount — taken from Financial Information: whichever of
    // "Commission %" (comm_pct) or "Commission Amount" (comm_amt) is given.
    const pctVal = t.comm_pct !== null ? num(t.comm_pct) : t.comm_type === '%' ? num(t.comm_value) : 0;
    const amtVal = t.comm_amt !== null ? num(t.comm_amt) : t.comm_type === 'Fixed' ? num(t.comm_value) : 0;
    const commDisplay = pctVal > 0 ? trimPct(pctVal) + '%' : amtVal > 0 ? '$' + fmtNum(amtVal) : '—';

    // ---- documentation reporting ------------------------------------------
    const docs: DocRow[] = t.documents.map((d) => ({
      id: d.id,
      title: d.title,
      category: docCategory(d.title),
      status: docStatus(d),
      raw_status: d.status,
      validation: d.validation,
      mandatory: d.mandatory,
      is_condition: d.is_condition,
      uploaded: !!d.file_path,
      reminder_sent: d.reminder,
      file_name: d.file_name,
      uploaded_at: dateStr(d.created_at),
      reviewed_at: dateStr(d.updated_at),
      remarks: d.remarks,
    }));
    const counts = docCounts(docs);
    const lastDocUpdate = docs.reduce<string | null>((a, d) => (d.reviewed_at && (!a || d.reviewed_at > a) ? d.reviewed_at : a), null);
    const today = new Date().toISOString().slice(0, 10);
    const conditions: CondRow[] = t.conditions.map((c) => {
      const cond = { status: c.status, deadline: dateStr(c.deadline) };
      return { id: c.id, type: c.custom_name || c.type, deadline: cond.deadline, status: c.status, expiry_status: expiryStatus(cond, today) };
    });

    const rec = t as unknown as Record<string, unknown>;
    // Payment Type: the transaction column when set, else the actual method used on the
    // agent payment rows (admin_activities → paid_type), ignoring the "N/A" placeholder.
    const paymentType = rec.payment_type != null && String(rec.payment_type) !== ''
      ? String(rec.payment_type)
      : this.derivePaymentType(admin, scopedNames);
    return {
      id: t.id,
      trade_no: t.trade_no,
      type: t.type,
      property: t.property,
      offer_date: dateStr(t.offer_date),
      closing_date: dateStr(t.closing_date),
      created_at: dateStr(t.created_at),
      updated_at: dateStr(t.updated_at),
      agent: t.agent,
      agent_names: scopedNames.length ? scopedNames : (t.agent ? [t.agent] : []),
      is_team: allNames.length > 1,
      split_ratios: splitRatios(bd),
      splits: this.buildSplits(scopedLines),
      cta_to_ba: this.ctaToBa(admin, scopedNames),
      price: num(t.price),
      listing_price: rec.listing_price != null ? num(rec.listing_price) : null,
      closed_price: num(t.price),
      comm_type: t.comm_type,
      comm_value: num(t.comm_value),
      comm_pct: t.comm_pct != null ? num(t.comm_pct) : null,
      comm_amt: t.comm_amt != null ? num(t.comm_amt) : null,
      comm_display: commDisplay,
      payment_type: paymentType,
      total: { commission: money(summary.amount), hst: money(summary.hst), total: money(summary.total) },
      agentComm,
      brokerageComm,
      coopOut,
      agent_payment_status: this.agentPaymentStatus(tracker, statuses, paid, scopedNames, agentComm.total),
      agent_paid: paid.totalPaid,
      agent_paid_date: paid.lastPaidDate,
      any_agent_paid: paid.anyPaid,
      advance: adv.total,
      advance_date: adv.lastDate,
      agent_balance: balance,
      adjustments_total: adjustmentsTotal,
      cashback: cashback(adjustments),
      referral: referral(adjustments),
      statuses,
      is_closed: statuses.includes('Closed'),
      is_mutual_release: statuses.includes('Mutual Release'),
      commission_received: t.comm_status === 'Received',
      lead_source: rec.lead_source != null && String(rec.lead_source) !== '' ? String(rec.lead_source) : null,
      lead_assigned_date: dateStr(rec.lead_assigned_date as Date | null),
      lead_converted_date: dateStr(rec.lead_converted_date as Date | null),
      review_email_sent_at: dateStr(rec.review_email_sent_at as Date | null),
      review_received_at: dateStr(rec.review_received_at as Date | null),
      client_names: t.clients.map((c) => c.name).filter(Boolean),
      docs,
      doc_counts: counts,
      documentation_status: documentationStatus(counts),
      last_doc_update: lastDocUpdate,
      // reco_audit_ready is stored as a flag/word depending on vintage — normalise to Yes/No
      reco_audit_ready: this.yesNo(rec.reco_audit_ready),
      reco_audit_remarks: rec.reco_audit_remarks != null ? String(rec.reco_audit_remarks) : null,
      reco_review_at: dateStr(t.agent_review_at),
      conditional_offer: this.yesNo(rec.conditional_offer) === 'Yes' || conditions.length > 0 ? 'Yes' : 'No',
      conditions,
      waiver_status: groupStatus(docs.filter((d) => isWaiver(d.title))),
      amendment_status: groupStatus(docs.filter((d) => isAmendment(d.title))),
      gift_coupon_value: rec.gift_coupon_value != null ? num(rec.gift_coupon_value) : null,
      gift_coupon_issued_at: dateStr(rec.gift_coupon_issued_at as Date | null),
    };
  }

  /** One entry per split agent (single-agent deals produce exactly one). */
  private buildSplits(lines: Record<string, unknown>[]): EnrichedTxn['splits'] {
    const tri = (v: unknown): Triple => { const o = (v ?? {}) as Record<string, unknown>; return { commission: num(o.commission), hst: num(o.hst), total: num(o.total) }; };
    const trim = (n: number): string => (Number.isInteger(n) ? String(n) : String(money(n)));
    return lines.map((l) => ({
      name: String(l.name ?? ''),
      ratio: `${trim(num(l.agent_pct))}/${trim(num(l.brok_pct))}`,
      split: num(l.split),
      agent: tri(l.agent),
      brokerage: tri(l.brokerage),
    }));
  }

  /**
   * CTA → BA transfer state from Admin Activities: 'Yes' once any transfer row for the
   * transaction's agents is Yes; otherwise 'No' (including when no transfer row exists yet).
   */
  private ctaToBa(admin: Record<string, unknown>, names: string[]): string {
    const agents = (admin.agents && typeof admin.agents === 'object' ? admin.agents : {}) as Record<string, unknown>;
    for (const name of names) {
      const rec = (agents[name] && typeof agents[name] === 'object' ? agents[name] : {}) as Record<string, unknown>;
      for (const row of (Array.isArray(rec.cta) ? rec.cta : [])) {
        if (String((row as Record<string, unknown>)?.cta) === 'Yes') return 'Yes';
      }
    }
    return 'No';
  }

  /** First real payment method used on this transaction's agent payment rows ("N/A" ignored). */
  private derivePaymentType(admin: Record<string, unknown>, names: string[]): string | null {
    const agents = (admin.agents && typeof admin.agents === 'object' ? admin.agents : {}) as Record<string, unknown>;
    for (const name of names) {
      const rec = (agents[name] && typeof agents[name] === 'object' ? agents[name] : {}) as Record<string, unknown>;
      const rows = Array.isArray(rec.payments) ? rec.payments : [];
      for (const p of rows) {
        const pt = (p as Record<string, unknown>)?.paid_type;
        if (pt && String(pt) !== 'N/A' && String(pt) !== '') return String(pt);
      }
    }
    return null;
  }

  /** Normalise the several truthy spellings these flag columns use into 'Yes' / 'No'. */
  private yesNo(v: unknown): string {
    if (v === true || v === 1) return 'Yes';
    const s = String(v ?? '').trim().toLowerCase();
    return s === 'yes' || s === 'y' || s === '1' || s === 'true' ? 'Yes' : 'No';
  }

  /**
   * The transactions in scope, as ids and the two display fields the reminder report needs.
   *
   * `computeReminders` used to call `load()` for this — enriching every deal in the brokerage,
   * commission breakdown and all, to find out which ids an agent may read and what their trade
   * numbers are. Same scope rule, same answer, three columns.
   */
  async visibleSummaries(scope: DataScope): Promise<{ id: number; trade_no: string; property: string | null }[]> {
    const where: Prisma.transactionsWhereInput = { deleted_at: null };
    const visibility = this.visibilityWhere(scope);
    if (visibility) where.OR = visibility;
    return this.prisma.transactions.findMany({
      where,
      select: { id: true, trade_no: true, property: true },
      orderBy: { id: 'asc' },
    });
  }

  /**
   * The agent/brokerage split ratios present in the data — the Split Ratio dropdown.
   *
   * THIS USED TO ENRICH THE ENTIRE BROKERAGE. `filterOptions` called `load()` and read
   * `split_ratios` off every enriched row, so opening the Reports screen ran a full commission
   * breakdown over 80,000 deals to populate one `<select>`.
   *
   * A ratio is a member's `agent_pct/brok_pct` pair, which is stored. Two sources, matching
   * `splitRatios(bd)`: the team member rows, and — for deals with no team rows, where the member is
   * synthesised from the deal's agent — that agent's profile split, which is what `agentDefaultSplit`
   * would produce. Both are distinct queries over small column sets.
   */
  async splitRatioOptions(scope: DataScope): Promise<string[]> {
    const where: Prisma.transactionsWhereInput = { deleted_at: null };
    const visibility = this.visibilityWhere(scope);
    if (visibility) where.OR = visibility;

    const [members, soloTypes, users] = await Promise.all([
      this.prisma.team_members.findMany({
        where: { transactions: where },
        select: { agent_pct: true, brok_pct: true },
        distinct: ['agent_pct', 'brok_pct'],
      }),
      // Deals with no team rows at all: the member is synthesised from the deal's agent, and the
      // split then depends only on whether the TYPE is a lease.
      this.prisma.transactions.findMany({
        where: { AND: [where, { team_members: { none: {} } }, { agent: { not: null } }] },
        select: { agent: true, type: true },
        distinct: ['agent', 'type'],
      }),
      this.prisma.users.findMany({ select: { name: true, profile: true, status: true }, orderBy: { id: 'asc' } }),
    ]);

    // Same resolution rule as `PersonResolver`: an Active row wins, ties go to the lowest id.
    const profiles = new Map<string, Record<string, unknown>>();
    const isActive = new Map<string, boolean>();
    for (const u of users) {
      const held = isActive.get(u.name);
      if (held === undefined || (held === false && u.status === 'Active')) {
        profiles.set(u.name, parseJsonObject(u.profile));
        isActive.set(u.name, u.status === 'Active');
      }
    }

    const ratios = new Set<string>();
    const add = (a: number, b: number): void => { if (a || b) ratios.add(`${trimRatio(a)}/${trimRatio(b)}`); };
    for (const m of members) add(num(m.agent_pct), num(m.brok_pct));
    for (const s of soloTypes) {
      const isLease = /lease/i.test(s.type ?? '');
      const p = profiles.get(s.agent ?? '') ?? {};
      const v = p[isLease ? 'lease_comm_pct' : 'agent_comm_pct'];
      const agent = v !== null && v !== undefined && v !== '' ? phpFloat(v) : isLease ? 95 : 90;
      add(agent, money(100 - agent));
    }
    return [...ratios];
  }

  /** Active agent-role users — the same list the Transactions module's Agent dropdown uses. */
  async agentNames(): Promise<string[]> {
    const rows = await this.prisma.users.findMany({ where: { role: 'agent', status: 'Active' }, select: { name: true } });
    return rows.map((r) => r.name).sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  }

  /** Distinct years present on closing_date, newest first (drives the Closing Year filter). */
  async closingYears(): Promise<string[]> {
    const rows = await this.prisma.transactions.findMany({ where: { deleted_at: null, closing_date: { not: null } }, select: { closing_date: true } });
    return [...new Set(rows.map((r) => String(r.closing_date!.getUTCFullYear())))].sort((a, b) => Number(b) - Number(a));
  }

  /**
   * Agent payment status. Source of truth is Agent FAQ Center → Agent Commission Paid Status;
   * where that is unset we derive a transaction-level status across every split agent:
   *   all agents paid → Paid · some paid → Partially Paid · none paid → Pending (Upcoming
   *   while the deal is still open) · no commission payable → Not Applicable.
   */
  private agentPaymentStatus(
    tracker: Record<string, unknown>,
    statuses: string[],
    paid: { paidNames: string[] },
    names: string[],
    agentCommTotal: number,
  ): string {
    const faq = tracker.agent_commission_paid_status;
    if (faq === 'Yes') return 'Paid';
    if (faq === 'N/A' || faq === 'Not Applicable') return 'Not Applicable';
    if (agentCommTotal <= 0) return 'Not Applicable';

    const paidCount = paid.paidNames.length;
    if (names.length > 0 && paidCount >= names.length) return 'Paid';
    if (paidCount > 0) return 'Partially Paid';
    return statuses.includes('Closed') ? 'Pending' : 'Upcoming';
  }

  /**
   * Agent loan rows (Report 12) — derived exactly like Laravel AgentController::loans():
   * loan principal from User.profile (has_loan/loan_amount); repayments from adjustment_rows[]
   * with is_loan, aggregated per agent across all their transactions.
   */
  async loadLoans(scope: DataScope): Promise<LoanRow[]> {
    const users = await this.prisma.users.findMany({ select: { name: true, profile: true, role: true } });
    const nameFilter = scope.lockedAgent ? [scope.lockedAgent] : scope.agents && scope.agents.length ? scope.agents : null;

    // repayments across transactions, grouped by agent
    const txns = await this.prisma.transactions.findMany({ where: { deleted_at: null }, select: { trade_no: true, property: true, closing_date: true, adjustments: true } });
    const repayByAgent = new Map<string, { trade_no: string; property: string | null; closing_date: string | null; amount: number }[]>();
    for (const t of txns) {
      const adj = parseJsonObject(t.adjustments);
      for (const name of new Set(this.loanAgentsIn(adj))) {
        const reps = loanRepayments(adj, name);
        if (!reps.length) continue;
        const list = repayByAgent.get(name) ?? [];
        for (const r of reps) list.push({ trade_no: t.trade_no, property: t.property, closing_date: dateStr(t.closing_date), amount: r.amount });
        repayByAgent.set(name, list);
      }
    }

    const rows: LoanRow[] = [];
    for (const u of users) {
      if (nameFilter && !nameFilter.includes(u.name)) continue;
      const p = parseJsonObject(u.profile);
      const hasLoan = p.has_loan === true || p.has_loan === 'Yes' || p.has_loan === 1 || p.has_loan === '1';
      const principal = num(p.loan_amount);
      const reps = repayByAgent.get(u.name) ?? [];
      const repaid = sum(reps.map((r) => r.amount));
      if (!hasLoan && principal === 0 && reps.length === 0) continue; // no loan for this agent
      const outstanding = balanceOf(principal, repaid);
      rows.push({
        agent: u.name,
        loan_amount: principal,
        loan_repaid: repaid,
        outstanding,
        status: this.loanStatus(principal, repaid),
        repayment_count: reps.length,
        last_repayment: reps.map((r) => r.closing_date).filter(Boolean).sort().slice(-1)[0] ?? null,
        repayments: reps,
      });
    }
    return rows;
  }

  private loanAgentsIn(adj: Record<string, unknown>): string[] {
    if (String(adj.agent_adjust) !== 'Yes') return [];
    const rows = Array.isArray(adj.adjustment_rows) ? adj.adjustment_rows : [];
    return rows.filter((r) => r && typeof r === 'object' && (r as Record<string, unknown>).is_loan).map((r) => String((r as Record<string, unknown>).agent ?? '')).filter(Boolean);
  }

  private loanStatus(principal: number, repaid: number): string {
    if (principal <= 0) return 'Active';
    if (repaid <= 0) return 'Active';
    if (repaid >= principal) return 'Fully Repaid';
    return 'Partially Repaid';
  }
}

export interface LoanRow {
  agent: string;
  loan_amount: number;
  loan_repaid: number;
  outstanding: number;
  status: string;
  repayment_count: number;
  last_repayment: string | null;
  repayments: { trade_no: string; property: string | null; closing_date: string | null; amount: number }[];
}
