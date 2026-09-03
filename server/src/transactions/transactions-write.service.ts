import { ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PersonResolver } from '../core/person-resolver.service';
import { AuditService, type ActingUser } from '../audit/audit.service';
import { CommissionService } from './commission.service';
import { PaymentCacheService } from './payment-cache.service';
import { normalizeCommissionTxn } from './commission.loader';
import { parseJsonObject, phpEmpty, phpFloat, phpJsonNormalize, round2, toFloat } from '../common/serialize';
import { isInvoiceableType, isListingType, SECURED_DEAL_TYPES, statusSetProblem, TRANSACTION_TYPES } from '../reference/transaction.constants';
import { TradeNumberService } from './trade-number.service';
import { TransactionLawyerReminderService } from './transaction-lawyer-reminder.service';
import { TransactionReviewService } from './transaction-review.service';
import { ReminderSweepService } from './reminder-sweep.service';
import { TransactionInvoiceService } from '../invoices/transaction-invoice.service';
import { parseJson } from '../common/serialize';
import {
  transactionResource,
  txnShowIncludeFor,
  type LoadedTxn,
  type ResourceUser,
} from './transaction.resource';
import type { AuthUserRecord } from '../auth/auth.types';

import { isAdminOrAbove, isAgent, isSuperAdmin } from '../core/authz';
import { ownsTransaction, teamMemberIdentity } from '../common/transaction-scope';
type Tx = Prisma.TransactionClient;

/**
 * TD-028 — the same shape the Calendar and the browser already use, so a client email is judged by
 * one rule wherever it is entered.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * TD-028 — the fewest digits that can be a telephone number.
 *
 * Seven is `normalizePhone`'s own threshold (`meta/meta-lead-mapper.ts`), reused so the Desk and the
 * CRM do not disagree about what a phone number is. Deliberately a digit COUNT and not a pattern:
 * the brokerage takes international numbers and numbers with extensions, and a stricter rule would
 * reject real ones — which is a worse outcome than accepting an oddly-punctuated real number. It
 * still refuses what this defect was raised for, because 'abc-not-a-phone' contains no digits.
 */
const PHONE_MIN_DIGITS = 7;

/** A stored or submitted date reduced to its day, so two of them compare as ISO strings. */
const asDay = (v: unknown): string => {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v ?? '').trim().slice(0, 10);
};

/**
 * TD-056 — the deal date rules, enforced where they can actually be relied on.
 *
 * These are not new rules. The Add Transaction form states both of them under the inputs
 * ("Cannot be a future date", "Cannot be before the offer date") and refuses a save that breaks
 * them. THE API DID NOT: measured 2026-08-22, a PUT with a closing date of 2026-01-01 against an
 * offer date of 2026-08-22 returned 200 and stored it, as did a closing date of 3000-12-31. So the
 * browser silently refused saves the API would have accepted, and anything writing to the API
 * directly - an import, an integration, a script - could store dates the UI would never allow.
 *
 * Only the two rules the application already states are implemented here. The listing contract and
 * expiry dates are deliberately NOT ordered against each other: no screen in the product states
 * that rule, and inventing it would be a business decision rather than a fix. It is worth asking
 * for, and TD-074 is the entry that shows what a mistyped expiry date does today.
 *
 * UTC day, matching `toDateString` and `startOfToday` elsewhere in the codebase, so a date compares
 * the same way wherever it is read.
 */
function dateRuleProblems(offer: string, closing: string): Record<string, string> {
  const problems: Record<string, string> = {};
  const today = new Date().toISOString().slice(0, 10);
  if (offer && offer > today) problems.offer_date = 'The offer date cannot be in the future.';
  if (offer && closing && closing < offer) problems.closing_date = 'The closing date cannot be before the offer date.';
  return problems;
}

const REVERT_BOOL = new Set(['comm_adjust_enabled', 'listing_adj_enabled', 'coop_adj_enabled', 'precon_net_of_hst', 'mls_verified', 'conditional_offer', 'inter_board_enabled']);
const REVERT_DATE = new Set(['offer_date', 'closing_date', 'listing_contract_date', 'listing_expiry_date']);
const isListingFinancial = (type: string): boolean => isListingType(type) || type === 'Business Sale';
const isListingStatusFamily = (type: string): boolean => isListingType(type) || type === 'Business Sale';

// Column classification for normalizing the fillable payload → DB values.
const JSON_COLS = new Set(['admin_activities', 'activity_tracker', 'adjustments', 'commercial_lease', 'trade_sheet_data']);
const DATE_COLS = new Set(['offer_date', 'closing_date', 'listing_contract_date', 'listing_expiry_date']);
const BOOL_COLS = new Set(['mls_verified', 'comm_adjust_enabled', 'listing_adj_enabled', 'coop_adj_enabled', 'precon_net_of_hst', 'conditional_offer', 'inter_board_enabled']);
const INT_COLS = new Set(['precon_term_count']);

const FILL_KEYS = [
  'type', 'property', 'agent', 'price', 'deposit',
  'offer_date', 'closing_date', 'listing_contract_date', 'listing_expiry_date',
  'mls_type', 'mls_num', 'mls_verified',
  'comm_type', 'comm_value', 'comm_pct', 'comm_amt',
  'comm_adjust_enabled', 'comm_adjust_before', 'comm_adjust_after',
  'listing_comm_pct', 'coop_comm_pct', 'listing_comm_flat', 'coop_comm_flat', 'trust_payable',
  'listing_adj_enabled', 'listing_adj_before', 'listing_adj_after',
  'coop_adj_enabled', 'coop_adj_before', 'coop_adj_after',
  'precon_listing_type', 'precon_term_count', 'commission_agent',
  'precon_net_of_hst', 'precon_comm_pct', 'precon_comm_amt_manual', 'precon_details_of_terms',
  'lawyer_name', 'lawyer_email', 'lawyer_phone', 'lawyer_address',
  'buyer_lawyer_name', 'buyer_lawyer_email', 'buyer_lawyer_phone', 'buyer_lawyer_address',
  'seller_lawyer_name', 'seller_lawyer_email', 'seller_lawyer_phone', 'seller_lawyer_address',
  'admin_activities', 'activity_tracker', 'adjustments', 'commercial_lease', 'trade_sheet_data',
  'comm_status', 'comm_paid_status', 'valid_status',
  'conditional_offer', 'inter_board_enabled',
] as const;

// Agents cannot modify these.
const AGENT_LOCKED = [
  'comm_type', 'comm_value', 'comm_pct', 'comm_amt',
  'comm_adjust_enabled', 'comm_adjust_before', 'comm_adjust_after',
  'listing_comm_pct', 'coop_comm_pct', 'listing_comm_flat', 'coop_comm_flat', 'trust_payable',
  'listing_adj_enabled', 'listing_adj_before', 'listing_adj_after',
  'coop_adj_enabled', 'coop_adj_before', 'coop_adj_after',
  'comm_status', 'comm_paid_status',
  'precon_net_of_hst', 'precon_comm_pct', 'precon_comm_amt_manual', 'precon_listing_type',
  'adjustments', 'admin_activities',
];

const FINANCIAL_FIELDS = new Set([
  'price', 'deposit', 'comm_type', 'comm_value', 'comm_pct', 'comm_amt',
  'comm_adjust_enabled', 'comm_adjust_before', 'comm_adjust_after',
  'listing_comm_pct', 'coop_comm_pct', 'listing_comm_flat', 'coop_comm_flat',
  'listing_adj_enabled', 'listing_adj_before', 'listing_adj_after',
  'coop_adj_enabled', 'coop_adj_before', 'coop_adj_after',
]);

const asArray = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

@Injectable()
export class TransactionsWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly people: PersonResolver,
    private readonly audit: AuditService,
    private readonly commission: CommissionService,
    private readonly tradeNumbers: TradeNumberService,
    private readonly txnInvoices: TransactionInvoiceService,
    private readonly lawyerReminder: TransactionLawyerReminderService,
    private readonly reviews: TransactionReviewService,
    private readonly reminders: ReminderSweepService,
    private readonly paymentCache: PaymentCacheService,
  ) {}

  /**
   * Refresh the deal's cached agent-payment figures.
   *
   * CALLED ON EVERY WRITE, not only on the ones that touch `admin_activities`. The cached values
   * depend on the blob AND on the deal's agent names, which come from `team_members` through the
   * commission engine — so a change to the team, to a split, to the deal type or to the price can
   * move them without the blob being touched at all. Deciding per-field which writes matter would be
   * a list to keep in step with the commission engine; recomputing one row is a few milliseconds.
   *
   * AWAITED, so a save followed immediately by opening a report cannot show the previous figures.
   * Firing it off would make the write marginally faster and the read occasionally wrong.
   *
   * A FAILURE HERE MUST NOT FAIL THE WRITE. The blob is authoritative and `calc_at` is left as it
   * was; the reports fall back to parsing it for this row, which is correct and merely slower.
   * `verify-payment-cache.cjs` is what surfaces a row that has drifted this way.
   */
  private async refreshPaymentCache(txnId: number): Promise<void> {
    try {
      await this.paymentCache.recomputeOne(txnId);
    } catch {
      // Deliberately swallowed — see above. The service logs its own reason.
    }
  }

  /** Create a transaction (port of TransactionController::store). */
  async store(user: AuthUserRecord | null, body: Record<string, unknown>): Promise<{ data: Record<string, unknown> }> {
    const type = String(body.type ?? '');
    const isListing = isListingType(type);

    /*
     * TD-113 - every problem this can see, in one reply.
     *
     * The checks ran one at a time and threw on the first, so a create carrying only a type came
     * back naming ONLY the property - while price, offer date, closing date and commission type
     * were missing too. An integration or a migration script discovered the required fields one
     * round trip at a time. The product already does better in the importer, which reports every
     * fault on a row together with a correction for each, so this was inconsistent as well as
     * unhelpful.
     *
     * WHICH FIELDS ARE ASKED FOR DEPENDS ON THE TYPE, so an unknown type reports only the three
     * that every deal needs. Listing the deal-side fields as "required" next to a type error would
     * be inventing requirements the caller may not have — a listing needs none of them — and the
     * type error is the one to fix first anyway.
     *
     * The status VOCABULARY check joins the same reply rather than following in a later one, but
     * only when it can be judged: a status can only be wrong for a type that is known.
     */
    /*
     * The KEYS in `errors` stay exactly as they are — they are the API's contract and callers match
     * on them. Only the human label changes, and only for the two that read as jargon: underscore
     * stripping alone turns `comm_type` into "comm type", which was tolerable when it appeared
     * alone and reads badly in a list of seven. "Commission Type" is what the screen and the import
     * template already call it.
     */
    const LABELS: Record<string, string> = { comm_type: 'commission type', comm_value: 'commission value' };
    const label = (f: string): string => LABELS[f] ?? f.replace(/_/g, ' ');
    const blank = (v: unknown): boolean => v === undefined || v === null || v === '';
    const knownType = (TRANSACTION_TYPES as readonly string[]).includes(type);

    const required = ['type', 'property', 'status'];
    if (knownType && !isListing) required.push('comm_type', 'comm_value', 'price', 'offer_date', 'closing_date');

    const errors: Record<string, string[]> = {};
    const missing = required.filter((f) => blank(body[f]));
    for (const f of missing) errors[f] = [`The ${label(f)} field is required.`];

    /*
     * TD-068 ON CREATE. The catalogue check existed only on update; creation required a type to be
     * PRESENT and then stored whatever arrived - POST with 'Sale Listing', and even 'zzz-not-a-type',
     * both returned 201. Every later rule keys off the type: which statuses it may hold, which
     * documents it generates, how its commission is worked out. Found by REG-TR-027 on 2026-08-31.
     *
     * Kept exactly as strict, but reported through the same collection as everything else (TD-113)
     * rather than thrown on sight, so a caller who sent an unknown type AND left fields out learns
     * both in one reply. A blank type is already covered above as a missing field, so this only
     * speaks when something was actually supplied.
     */
    if (!blank(body.type) && !knownType) {
      errors.type = [`"${type}" is not a transaction type this system offers. Allowed: ${TRANSACTION_TYPES.join(', ')}.`];
    }

    // The status the deal is being opened with has to exist for the type. Creation takes a single
    // status, so the only rule that can bite here is the vocabulary one — but a deal created
    // through the API with `status: 'Expired'` on a Residential Buying was accepted, and every
    // later save inherited it.
    if (knownType && !blank(body.status)) {
      const problem = statusSetProblem(type, [String(body.status)]);
      if (problem) errors.status = [problem];
    }

    // TD-056 — the same two date rules the form states, joining the same reply. On create every
    // date is newly supplied, so both can be judged and both are reported.
    for (const [field, message] of Object.entries(dateRuleProblems(asDay(body.offer_date), asDay(body.closing_date)))) {
      errors[field] = [message];
    }

    if (Object.keys(errors).length) {
      const sentences: string[] = [];
      if (missing.length === 1) sentences.push(`The ${label(missing[0])} field is required.`);
      else if (missing.length > 1) {
        const names = missing.map(label);
        sentences.push(`The ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} fields are required.`);
      }
      // Anything that is not a missing-field message, so `message` says as much as `errors` does —
      // a caller that only displays `message` should not have to ask twice either.
      for (const [field, msgs] of Object.entries(errors)) if (!missing.includes(field)) sentences.push(...msgs);
      throw new UnprocessableEntityException({ message: sentences.join(' '), errors });
    }

    /*
     * A LISTING THAT HAS SOLD CARRIES ITS MONEY. An unsold listing does not.
     *
     * Creation forced price, deposit, offer date and closing date to nothing for EVERY listing,
     * on the reasoning that a listing has no offer terms - true while it is on the market, and
     * false the moment it sells. update() has always allowed those fields, so the only effect was
     * to make somebody create the deal and immediately edit it. It also made bulk import unable to
     * carry a historical sold listing: it arrived priced at zero, and a listing commission is a
     * percentage OF THE PRICE, so it arrived earning nothing (TD-126).
     *
     * This sits alongside the required-field rule above rather than contradicting it. A listing
     * REQUIRES none of these - that is why they are pushed onto `required` only for non-listings -
     * and a SOLD one may nonetheless carry them. Not required and not forbidden are compatible.
     *
     * Sold, Leased and Closed mean the deal transacted. Active, Suspended, Terminated, Expired and
     * Void do not, and on those a sale price would be a number describing nothing.
     */
    const LISTING_TRANSACTED = ['Sold', 'Leased', 'Closed'];
    const soldListing = isListing && LISTING_TRANSACTED.includes(String(body.status ?? '').trim());
    const noOfferTerms = isListing && !soldListing;

    /*
     * A TRADE NUMBER MAY BE CHOSEN BY HAND, which filing a historical deal needs - it already
     * carries a number, and inventing a second one for the same trade helps nobody. Left blank,
     * one is allocated as before, so nothing changes for anybody who does not care.
     *
     * It is validated BEFORE the create rather than left to the unique index, because the index
     * answers with a Prisma error naming a constraint. That is what TD-127 surfaced to users, and
     * it tells somebody who mistyped a number nothing about what to do next.
     */
    const manualTrade = String(body.trade_no ?? '').trim();
    if (manualTrade) {
      const problem = await this.tradeNumbers.manualProblem(this.prisma, type, manualTrade);
      if (problem) throw new UnprocessableEntityException({ message: problem, errors: { trade_no: [problem] } });
    }

    const creatorAgent = user && isAgent(user) ? user.name : null;
    const commType = isListing ? '%' : String(body.comm_type ?? '%');
    const commValue = isListing ? 0 : toFloat(body.comm_value ?? 0);

    const primaryAgent = body.primary_agent ? String(body.primary_agent) : creatorAgent;
    const members = (Array.isArray(body.team_members) ? (body.team_members as unknown[]) : []).map(String).filter((n) => n !== '');
    const isTeam = !!body.primary_agent || members.length > 0;
    const team: Record<string, unknown>[] = [];
    if (isTeam && primaryAgent) {
      team.push({ name: primaryAgent, is_primary: true, access: 'full' });
      for (const m of members) if (m !== primaryAgent) team.push({ name: m, is_primary: false, access: 'full' });
    }
    const agentName = isTeam ? primaryAgent : creatorAgent;
    const actor: ActingUser | null = user ? { id: user.id, name: user.name } : null;
    const toDate = (v: unknown): Date | null => (v ? new Date(String(v).slice(0, 10) + 'T00:00:00.000Z') : null);

    // Duplicate guard (buying/lease): same Type + Price + Offer Date with a FUZZY property
    // match — an exact address isn't required (mirrors TransactionController::store). Soft-
    // deleted rows are excluded (Eloquent SoftDeletes global scope → deleted_at null).
    if (!isListing && !phpEmpty(body.offer_date)) {
      const candidates = await this.prisma.transactions.findMany({
        where: { type, price: toFloat(body.price ?? 0), offer_date: toDate(body.offer_date), deleted_at: null },
      });
      for (const cand of candidates) {
        if (this.propertiesSimilar(String(body.property ?? ''), String(cand.property ?? ''))) {
          const on = cand.agent ? ` on ${cand.agent}` : ' (unassigned)';
          throw new UnprocessableEntityException({ message: `Transaction already exists${on} — Trade #${cand.trade_no}. Same Type, Price and Offer Date with a matching Property Address.` });
        }
      }
    }

    const txnId = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const t = await tx.transactions.create({
        data: {
          trade_no: manualTrade || await this.tradeNumbers.next(tx, type),
          type,
          property: (body.property ?? null) as string | null,
          agent: agentName,
          // Recorded beside the name, so nothing downstream has to resolve a person from a string
          // that may be edited or reused. See `PersonResolver` and migration
          // 20260803010000_person_user_ids. Null when the name matches no account, which is the
          // same position rows written before this were in.
          agent_user_id: (await this.people.resolve(null, agentName))?.id ?? null,
          price: noOfferTerms ? 0 : ((body.price ?? 0) as number),
          deposit: noOfferTerms ? 0 : ((body.deposit ?? 0) as number),
          offer_date: noOfferTerms ? null : toDate(body.offer_date),
          closing_date: noOfferTerms ? null : toDate(body.closing_date),
          listing_price: phpEmpty(body.listing_price) ? null : toFloat(body.listing_price),
          listing_contract_date: isListing ? toDate(body.listing_contract_date) : null,
          listing_expiry_date: isListing ? toDate(body.listing_expiry_date) : null,
          comm_type: commType,
          comm_value: commValue,
          comm_amt: !isListing && commType === 'Fixed' && commValue > 0 ? commValue : null,
          comm_pct: !isListing && commType === '%' && commValue > 0 ? commValue : null,
          comm_status: 'Pending',
          valid_status: 'Pending',
          created_at: now,
          updated_at: now,
        },
      });
      const status = String(body.status ?? this.defaultStatus(type));
      if (status) await tx.transaction_statuses.create({ data: { transaction_id: t.id, status, created_at: now, updated_at: now } });
      await this.audit.record(t.id, actor, { section: 'Basic Information', action: 'Record created', source: 'Manual', details: `Trade #${t.trade_no} (${t.type})` }, tx);
      if (team.length > 0) await this.syncTeam(tx, t.id, type, team);
      return t.id;
    });

    // Auto-generate the commission invoice (transaction_desk_v2 flag, invoiceable, not precon). Best-effort.
    if ((await this.featureFlag('transaction_desk_v2', true)) && isInvoiceableType(type) && type !== 'Preconstruction') {
      try {
        await this.prisma.$transaction((tx) => this.txnInvoices.generate(tx, txnId, actor, true));
      } catch {
        /* never let invoicing block the transaction */
      }
    }
    // Best-effort nudge if buyer/seller lawyer details are missing on a Buying/Lease deal.
    void this.lawyerReminder.maybeRemind(txnId);
    // Columns with a non-null DB default that store() never sets → null in the in-memory
    // model Laravel returns from create (mls_type, precon_listing_type, precon_details_of_terms).
    return this.loadResource(txnId, user, ['mls_type', 'precon_listing_type', 'precon_details_of_terms']);
  }

  /*
   * TD-113 — `req()` stood here: one field, throwing immediately. Removed rather than left unused,
   * because a throw-on-first helper sitting beside a collect-then-throw one is an invitation to
   * reintroduce the defect on the next required field somebody adds.
   */

  /**
   * Extract distinguishing address features that must NOT be fuzzed over: directional
   * tokens (N/S/E/W + long/compound forms) and unit numbers (unit/apt/suite/#, or a
   * leading "5-123" prefix). Returned sorted so two feature sets compare by equality.
   * (Sort order only needs to be self-consistent — both sides use the same sort.)
   */
  private addrFeatures(input: string): { dirs: string[]; units: string[] } {
    const s = input.toLowerCase().trim();
    const units: string[] = [];
    const unitRe = /(?:unit|apt|apartment|suite|ste|#)\s*\.?\s*([a-z0-9]+)/gu;
    for (let m = unitRe.exec(s); m !== null; m = unitRe.exec(s)) units.push(m[1]);
    const lead = /^\s*([a-z0-9]+)\s*[-/]\s*\d/u.exec(s);
    if (lead) units.push(lead[1]);
    const uniqUnits = [...new Set(units)].sort();

    const dirMap: Record<string, string> = {
      n: 'n', s: 's', e: 'e', w: 'w', ne: 'ne', nw: 'nw', se: 'se', sw: 'sw',
      north: 'n', south: 's', east: 'e', west: 'w', northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
    };
    const dirsSet: Record<string, string> = {};
    for (const tok of s.split(/[^a-z0-9]+/u)) if (tok && dirMap[tok]) dirsSet[dirMap[tok]] = dirMap[tok];
    return { dirs: Object.values(dirsSet).sort(), units: uniqUnits };
  }

  /** Fuzzy property-address match (port of TransactionController::propertiesSimilar). */
  private propertiesSimilar(a: string, b: string): boolean {
    const fa = this.addrFeatures(a), fb = this.addrFeatures(b);
    if (fa.dirs.join('\x00') !== fb.dirs.join('\x00') || fa.units.join('\x00') !== fb.units.join('\x00')) return false;

    const norm = (s: string): string => s.toLowerCase().trim().replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/gu, ' ').trim();
    const na = norm(a), nb = norm(b);
    if (na === '' || nb === '') return false;
    if (na === nb) return true;

    // Word-based prefix/subset: one address is the other plus extra trailing words.
    const wa = na.split(' '), wb = nb.split(' ');
    const short = wa.length <= wb.length ? wa : wb;
    const long = wa.length <= wb.length ? wb : wa;
    if (long.slice(0, short.length).join('\x00') === short.join('\x00')) return true;

    return this.similarText(na, nb) >= 85.0;
  }

  /** PHP similar_text() percentage (byte-level LCS recursion). */
  private similarText(s1: string, s2: string): number {
    const b1 = Buffer.from(s1, 'utf8'), b2 = Buffer.from(s2, 'utf8');
    if (b1.length + b2.length === 0) return 0;
    return (this.similarChar(b1, b2) * 2.0) / (b1.length + b2.length) * 100;
  }

  private similarChar(t1: Uint8Array, t2: Uint8Array): number {
    // Longest first-occurring common substring.
    let max = 0, pos1 = 0, pos2 = 0;
    for (let p = 0; p < t1.length; p++) {
      for (let q = 0; q < t2.length; q++) {
        let l = 0;
        while (p + l < t1.length && q + l < t2.length && t1[p + l] === t2[q + l]) l++;
        if (l > max) { max = l; pos1 = p; pos2 = q; }
      }
    }
    let sum = max;
    if (sum) {
      if (pos1 && pos2) sum += this.similarChar(t1.subarray(0, pos1), t2.subarray(0, pos2));
      if (pos1 + max < t1.length && pos2 + max < t2.length) sum += this.similarChar(t1.subarray(pos1 + max), t2.subarray(pos2 + max));
    }
    return sum;
  }

  private async featureFlag(key: string, def: boolean): Promise<boolean> {
    const s = await this.prisma.company_settings.findUnique({ where: { id: 1 }, select: { feature_flags: true } });
    const flags = parseJson<Record<string, unknown>>(s?.feature_flags ?? null);
    if (!flags || typeof flags !== 'object') return def;
    return key in flags ? !!flags[key] : def;
  }

  async update(user: AuthUserRecord | null, txnId: number, body: Record<string, unknown>): Promise<{ data: Record<string, unknown> }> {
    const t = await this.prisma.transactions.findFirst({ where: { id: txnId, deleted_at: null } });
    if (!t) throw new NotFoundException({ message: `No query results for model [App\\Models\\Transaction] ${txnId}.` });

    // Only "present" keys (Laravel validated() semantics).
    const data: Record<string, unknown> = {};
    for (const k of [...FILL_KEYS, 'builder', 'team', 'precon_terms', 'statuses', 'clients', 'conditions', 'inter_board_listings', 'brokerage']) {
      if (Object.prototype.hasOwnProperty.call(body, k)) data[k] = body[k];
    }

    const actor: ActingUser | null = user ? { id: user.id, name: user.name } : null;

    if (user && isAgent(user)) {
      // Identity by id where the row has one — see `common/transaction-scope.ts`. A namesake must
      // not inherit edit rights, and must not be able to write their own name over the agent field.
      const isOwner = ownsTransaction(user, t);
      const isFullMember = (await this.prisma.team_members.findFirst({
        where: { transaction_id: txnId, access: 'full', ...teamMemberIdentity(user) },
      })) !== null;
      if (!isOwner && !isFullMember) throw new ForbiddenException({ message: 'You do not have edit access to this transaction.' });
      if (isOwner) data.agent = user.name;
      else delete data.agent;
      for (const k of AGENT_LOCKED) delete data[k];
      if (Object.prototype.hasOwnProperty.call(data, 'activity_tracker')) {
        const existing = parseJsonObject(t.activity_tracker);
        existing.batch_review_email = !!asObject(data.activity_tracker).batch_review_email;
        data.activity_tracker = existing;
      }
    }

    const statuses = await this.statusList(this.prisma, txnId);

    /*
     * A STATUS SET THAT CANNOT BE TRUE IS REFUSED, and refused here — before the lock checks, so an
     * impossible request is answered as impossible rather than as "you may not do that".
     *
     * Two guards, and the second is the one that makes this safe to deploy:
     *
     *   ONLY WHEN THE STATUSES ARE ACTUALLY CHANGING. A save that leaves them alone is not the place
     *   to litigate them. Rows already holding a contradictory pair — which the database can contain,
     *   because nothing stopped it until now — stay editable, so nobody is locked out of a deal they
     *   have to fix. The contradiction is refused the moment somebody tries to CREATE one.
     *
     *   ONLY WHEN A SET IS SUBMITTED. `statuses` absent means the caller is not touching them.
     *
     * Deliberately not a transition table: which status may follow which is how a brokerage works,
     * and that is a decision to be stated rather than inferred. This rejects only what is
     * self-contradictory or does not exist for the type.
     */
    /*
     * TD-068 and TD-014 - the type drives everything on a deal: which statuses it may hold, which
     * documents it generates, how its commission is worked out. It was required when a deal was
     * created, then free to be blanked or replaced with anything at all on update.
     */
    if (Object.prototype.hasOwnProperty.call(data, 'type')) {
      const submittedType = String(data.type ?? '').trim();
      if (!submittedType) {
        const m = 'A transaction must have a type. It is required when the deal is created and cannot be cleared afterwards.';
        throw new UnprocessableEntityException({ message: m, errors: { type: [m] } });
      }
      if (!(TRANSACTION_TYPES as readonly string[]).includes(submittedType)) {
        const m = `"${submittedType}" is not a transaction type this system offers. Allowed: ${TRANSACTION_TYPES.join(', ')}.`;
        throw new UnprocessableEntityException({ message: m, errors: { type: [m] } });
      }
    }

    /*
     * TD-055 - money that cannot exist. A negative price is not a discount, and a deposit larger
     * than the price is not a deposit. Both saved, and both reach the reports and the invoices.
     */
    const readMoney = (v: unknown): number => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
    const pricePresent = Object.prototype.hasOwnProperty.call(data, 'price');
    const depositPresent = Object.prototype.hasOwnProperty.call(data, 'deposit');
    if (pricePresent || depositPresent) {
      const priceIn = pricePresent ? readMoney(data.price) : readMoney(t.price);
      const depositIn = depositPresent ? readMoney(data.deposit) : readMoney(t.deposit);
      if (pricePresent && priceIn < 0) {
        const m = 'The purchase price cannot be negative.';
        throw new UnprocessableEntityException({ message: m, errors: { price: [m] } });
      }
      if (depositPresent && depositIn < 0) {
        const m = 'The deposit cannot be negative.';
        throw new UnprocessableEntityException({ message: m, errors: { deposit: [m] } });
      }
      if (priceIn > 0 && depositIn > priceIn) {
        const m = 'The deposit cannot be larger than the purchase price.';
        throw new UnprocessableEntityException({ message: m, errors: { deposit: [m] } });
      }
    }

    /*
     * TD-056 - the deal date rules, on the endpoint the browser is not the only caller of.
     *
     * Read like the money rules above: a date that is being changed is judged against the one that
     * is not, so submitting only a closing date is still checked against the stored offer date.
     *
     * ONLY A FIELD THE CALLER ACTUALLY SUBMITTED IS REFUSED. Deals already holding a broken pair
     * exist - the defect proves several were stored - and complaining about a stored offer date
     * when somebody is trying to correct the closing date would lock them out of the fix. Same
     * reasoning as the status rules below, which litigate a set only when it is being changed.
     */
    const offerPresent = Object.prototype.hasOwnProperty.call(data, 'offer_date');
    const closingPresent = Object.prototype.hasOwnProperty.call(data, 'closing_date');
    if (offerPresent || closingPresent) {
      const problems = dateRuleProblems(
        asDay(offerPresent ? data.offer_date : t.offer_date),
        asDay(closingPresent ? data.closing_date : t.closing_date),
      );
      const submitted: Record<string, boolean> = { offer_date: offerPresent, closing_date: closingPresent };
      for (const [field, m] of Object.entries(problems)) {
        if (submitted[field]) throw new UnprocessableEntityException({ message: m, errors: { [field]: [m] } });
      }
    }

    /*
     * TD-129 - the terms divide the deal's commission, so together they cannot come to more
     * than it. The brokerage states this as the governing condition for preconstruction.
     * The figure was already derived and returned as terms_pct_valid, and then ignored by
     * both surfaces: the screen warned and left Save enabled, and the API did not warn at
     * all. A term is what a builder is invoiced for, so it is refused at the point of save.
     *
     * THE MASTER IS READ FROM THIS REQUEST WHERE THIS REQUEST CHANGES IT. Taking it only
     * from the stored row would let one save lower the deal's percentage and raise the terms
     * together and pass - the exact shape this exists to stop.
     *
     * A FIXED-FEE DEAL IS NOT GUARDED HERE, deliberately rather than by oversight. It has no
     * percentage to compare against, and a term cannot hold an amount at all (TD-130). It is
     * left unchecked rather than checked wrongly.
     */
    const typeForTerms = String(data.type ?? t.type ?? '');
    if (/precon/i.test(typeForTerms) && Object.prototype.hasOwnProperty.call(data, 'precon_terms')) {
      const masterPct = Object.prototype.hasOwnProperty.call(data, 'precon_comm_pct')
        ? readMoney(data.precon_comm_pct)
        : readMoney(t.precon_comm_pct);
      if (masterPct > 0) {
        const sumPct = asArray(data.precon_terms).reduce(
          (acc, term) => acc + readMoney((term as Record<string, unknown>).pct), 0);
        if (sumPct > masterPct + 1e-9) {
          const m = `The commission terms add up to ${round2(sumPct)}% of the deal, which is more than the deal's own ${round2(masterPct)}%. The terms divide the commission between them; together they cannot exceed it.`;
          throw new UnprocessableEntityException({ message: m, errors: { precon_terms: [m] } });
        }
      }
    }

    /*
     * TD-028 - client records, checked by the API rather than only by the browser.
     *
     * The sub-form refuses a nameless client and an invalid email, and the API refused nothing at
     * all: an empty name stored with a 200, 'not-an-email' stored with a 200, and a phone of
     * 'abc-not-a-phone' stored verbatim. So every rule the screen enforced could be walked past by
     * an import, an integration or a direct call - and these values are not decorative, they are
     * what a Deposit Receipt and a Notice of Sale are addressed with.
     *
     * The row is NAMED IN THE MESSAGE. A payload carrying four clients that fails on the third is
     * useless feedback if the reply only says "a client is invalid", and this endpoint is the one
     * an integration talks to.
     *
     * Only when `clients` is submitted, like every rule above: a save that does not touch the
     * clients is not the place to litigate rows somebody else stored years ago.
     */
    if (Object.prototype.hasOwnProperty.call(data, 'clients')) {
      const submittedClients = Array.isArray(data.clients) ? (data.clients as Record<string, unknown>[]) : [];
      submittedClients.forEach((c, idx) => {
        const where = String(c?.name ?? '').trim() || `Client ${idx + 1}`;
        const fail = (m: string): never => {
          throw new UnprocessableEntityException({ message: m, errors: { clients: [m] } });
        };
        if (!String(c?.name ?? '').trim()) fail(`Client ${idx + 1} needs a name.`);
        const email = String(c?.email ?? '').trim();
        if (email && !EMAIL_RE.test(email)) fail(`"${email}" is not a valid email address (${where}).`);
        const phone = String(c?.phone ?? '').trim();
        if (phone && phone.replace(/\D/g, '').length < PHONE_MIN_DIGITS) {
          fail(`"${phone}" is not a valid phone number (${where}). It needs at least ${PHONE_MIN_DIGITS} digits.`);
        }
      });
    }

    if (Object.prototype.hasOwnProperty.call(data, 'statuses')) {
      const submitted = [...new Set((data.statuses as unknown[]).filter(Boolean).map(String))];
      const changed = submitted.length !== statuses.length || submitted.some((s) => !statuses.includes(s));
      if (changed) {
        const problem = statusSetProblem(String(data.type ?? t.type), submitted);
        if (problem) {
          throw new UnprocessableEntityException({ message: problem, errors: { statuses: [problem] } });
        }
      }
    }

    if (statuses.includes('Closed') && !isSuperAdmin(user)) {
      throw new ForbiddenException({ message: 'This transaction is Closed — only a Super Admin can edit it.' });
    }
    if (statuses.includes('DFT') && !isSuperAdmin(user)) {
      const approved = await this.prisma.transaction_edit_requests.findFirst({
        where: { transaction_id: txnId, status: 'approved' },
        orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
      });
      if (!approved) throw new ForbiddenException({ message: 'This transaction is DFT — edits require Super Admin approval. Use “Request Edit”.' });
      await this.prisma.transaction_edit_requests.update({ where: { id: approved.id }, data: { status: 'applied', updated_at: new Date() } });
    }

    /*
     * A deal cannot be closed while a rejected change is still outstanding.
     *
     * Closing is the moment the paperwork is declared final, and an unanswered rejection means it
     * is not. The block is deliberately overridable — an office that has settled the point another
     * way must not be stuck — but the override is a deliberate act with a reason, and it is written
     * to the audit trail, so "we closed it anyway" is a sentence somebody signed rather than a
     * silence. An override with no reason is refused.
     */
    const closingNow = Array.isArray(data.statuses)
      && (data.statuses as unknown[]).map(String).includes('Closed')
      && !statuses.includes('Closed');
    if (closingNow) {
      const outstanding = await this.reviews.openItems(txnId);
      if (outstanding.length) {
        const override = String((body.review_override_reason ?? '') as string).trim();
        if (!override) {
          throw new UnprocessableEntityException({
            message: `This transaction has ${outstanding.length} unresolved review item${outstanding.length === 1 ? '' : 's'} and cannot be closed until they are resolved. An administrator may close it anyway by giving a reason.`,
            errors: { review_override_reason: ['A reason is required to close with unresolved review items.'] },
            unresolved_reviews: outstanding,
          });
        }
        await this.audit.record(txnId, actor, {
          section: 'Status',
          field: 'Closed with unresolved review items',
          action: 'Review requirement overridden',
          source: 'Manual',
          old: `${outstanding.length} unresolved`,
          new: 'Closed',
          details: override,
        });
      }
    }

    // The two dates every reminder schedule hangs off, read before the save so a move can be
    // noticed afterwards and the schedule recalculated.
    const datesBefore = await this.prisma.transactions.findUnique({
      where: { id: txnId },
      select: { closing_date: true, listing_expiry_date: true },
    });

    const before = await this.audit.snapshot(txnId);

    await this.prisma.$transaction(async (tx) => {
      const fill: Record<string, unknown> = {};
      for (const k of FILL_KEYS) {
        if (Object.prototype.hasOwnProperty.call(data, k)) fill[k] = this.normalizeFill(k, data[k]);
      }
      if (Object.prototype.hasOwnProperty.call(data, 'builder') && data.builder && typeof data.builder === 'object') {
        const b = asObject(data.builder);
        for (const key of ['name', 'vendor', 'project', 'address', 'office_email', 'invoice_email', 'phone']) {
          fill['builder_' + key] = (b[key] ?? null) as string | null;
        }
      }

      await this.captureRemovedRows(tx, t, actor, data);

      await tx.transactions.update({ where: { id: txnId }, data: { ...(fill as Prisma.transactionsUpdateInput), updated_at: new Date() } });

      if (Object.prototype.hasOwnProperty.call(data, 'team')) await this.syncTeam(tx, txnId, String(fill.type ?? t.type), asArray(data.team));
      if (Object.prototype.hasOwnProperty.call(data, 'precon_terms')) await this.syncPreconTerms(tx, txnId, asArray(data.precon_terms));

      if (Object.prototype.hasOwnProperty.call(data, 'statuses')) {
        const finals = ['Sold', 'Leased'];
        const oldStatuses = statuses;
        const newStatuses = (data.statuses as unknown[]).filter(Boolean).map(String);
        const type = String(fill.type ?? t.type);
        const justSold = isListingStatusFamily(type) && newStatuses.some((s) => finals.includes(s)) && !oldStatuses.some((s) => finals.includes(s));

        await this.syncStatuses(tx, txnId, type, data.statuses as unknown[]);

        const cur = await tx.transactions.findUnique({ where: { id: txnId }, select: { mls_verified: true, agent: true } });
        if (justSold && cur?.mls_verified) await tx.transactions.update({ where: { id: txnId }, data: { mls_verified: false } });
        if (newStatuses.includes('Closed') && !oldStatuses.includes('Closed')) await this.applySplitUpgrade(tx, cur?.agent ?? null);
        if (newStatuses.includes('DFT')) {
          await tx.transactions.update({ where: { id: txnId }, data: { comm_status: 'N/A', comm_paid_status: 'N/A', valid_status: 'N/A' } });
        }
      }
      if (Object.prototype.hasOwnProperty.call(data, 'clients')) await this.syncClients(tx, txnId, asArray(data.clients));
      if (Object.prototype.hasOwnProperty.call(data, 'conditions')) await this.syncConditions(tx, txnId, asArray(data.conditions));
      if (Object.prototype.hasOwnProperty.call(data, 'inter_board_listings')) await this.syncInterBoard(tx, txnId, asArray(data.inter_board_listings));
      if (Object.prototype.hasOwnProperty.call(data, 'brokerage')) await this.syncBrokerage(tx, txnId, data.brokerage === null ? null : asObject(data.brokerage));

      await this.syncClientPayment(tx, txnId);
      await this.syncAdjustmentStatuses(tx, txnId);
    });

    if (Object.keys(data).some((k) => FINANCIAL_FIELDS.has(k))) {
      await this.prisma.transaction_edit_requests.updateMany({
        where: { transaction_id: txnId, scope: 'financial', status: 'approved' },
        data: { status: 'applied', updated_at: new Date() },
      });
    }

    const source = isAgent(user) ? 'Agent' : 'Manual';
    const changed = await this.audit.recordChanges(txnId, actor, before, await this.audit.snapshot(txnId), source);

    // An agent editing a field that was rejected is the correction half of the review lifecycle: the
    // original rejection moves to Corrected rather than a second, unrelated record being opened.
    // Only an agent's own save counts — the office editing the same field is not the agent fixing it.
    if (source === 'Agent' && changed.length) {
      await this.reviews.markCorrected(txnId, actor?.name ?? null, changed);
    }

    // Re-check lawyer details after the edit — only re-emails when the missing set actually changed.
    void this.lawyerReminder.maybeRemind(txnId);

    // A moved closing or expiry date means the reminder cadence is computed against a different
    // day from now on. Nothing is scheduled ahead — the sweep derives it nightly — so the schedule
    // recalculates by construction; this records that it happened and releases today's claim, so a
    // date brought forward can be chased today rather than tomorrow.
    const datesAfter = await this.prisma.transactions.findUnique({
      where: { id: txnId },
      select: { closing_date: true, listing_expiry_date: true },
    });
    for (const field of ['closing_date', 'listing_expiry_date'] as const) {
      const was = datesBefore?.[field] ?? null;
      const now = datesAfter?.[field] ?? null;
      if (was?.getTime() !== now?.getTime()) {
        void this.reminders.dateChanged(txnId, field, was, now);
      }
    }

    await this.refreshPaymentCache(txnId);

    const full = (await this.prisma.transactions.findUnique({ where: { id: txnId }, include: txnShowIncludeFor(user) })) as unknown as LoadedTxn;
    const ctx = { user: user ? ({ id: user.id, role: user.role, name: user.name } as ResourceUser) : null, commission: this.commission, prisma: this.prisma };
    return { data: await transactionResource(full, ctx) };
  }

  // ---- fill normalization -------------------------------------------------
  private normalizeFill(col: string, value: unknown): unknown {
    if (JSON_COLS.has(col)) return value === null || value === undefined ? null : JSON.stringify(phpJsonNormalize(value));
    if (DATE_COLS.has(col)) return value ? new Date(String(value).slice(0, 10) + 'T00:00:00.000Z') : null;
    if (BOOL_COLS.has(col)) return value === true || value === 1 || value === '1';
    if (INT_COLS.has(col)) return value === null || value === undefined || value === '' ? null : Number(value);
    return value === undefined ? null : value;
  }

  // ---- sync helpers -------------------------------------------------------
  private async statusList(db: Tx | PrismaService, txnId: number): Promise<string[]> {
    const rows = await db.transaction_statuses.findMany({ where: { transaction_id: txnId }, select: { status: true } });
    const list = rows.map((r) => r.status);
    return list.length ? list : ['Open'];
  }

  private defaultStatus(type: string): string {
    if (isListingStatusFamily(type)) return 'Active';
    return (SECURED_DEAL_TYPES as readonly string[]).includes(type) ? '' : 'Open';
  }

  private async syncPreconTerms(tx: Tx, txnId: number, terms: Record<string, unknown>[]): Promise<void> {
    await tx.precon_terms.deleteMany({ where: { transaction_id: txnId } });
    const now = new Date();
    for (const term of terms) {
      if (term.term_no === undefined || term.term_no === null) continue;
      await tx.precon_terms.create({
        data: {
          transaction_id: txnId,
          term_no: Number(term.term_no),
          pct: term.pct === undefined || term.pct === null ? null : (term.pct as number),
          closing_date: term.closing_date ? new Date(String(term.closing_date).slice(0, 10) + 'T00:00:00.000Z') : null,
          created_at: now,
          updated_at: now,
        },
      });
    }
  }

  private async agentSplitFromProfile(db: Tx | PrismaService, name: string | null, type: string, userId?: number | null): Promise<{ agent: number; brok: number }> {
    const isLease = /lease/i.test(type);
    let agent = isLease ? 95 : 90;
    if (name) {
      // Through the resolver, on the SAME client, so a split written earlier in this transaction is
      // visible and two people sharing a name resolve the same way they do everywhere else.
      const u = await this.people.resolve(userId, name, { client: db });
      const p = parseJsonObject(u?.profile);
      const v = p[isLease ? 'lease_comm_pct' : 'agent_comm_pct'];
      if (v !== null && v !== undefined && v !== '') agent = phpFloat(v);
    }
    return { agent, brok: round2(100 - agent) };
  }

  private async applySplitUpgrade(tx: Tx, agentName: string | null): Promise<void> {
    if (!agentName) return;
    const user = await this.people.resolve(null, agentName, { client: tx });
    if (!user) return;
    const profile = parseJsonObject(user.profile);
    if (profile.split_upgraded) return;
    const threshold = parseInt(String(profile.completed_deals ?? 0), 10) || 0;
    const newAgent = profile.upgrade_agent_pct;
    if (threshold <= 0 || newAgent === null || newAgent === undefined || newAgent === '') return;

    const closed = await tx.transactions.count({ where: { agent: agentName, deleted_at: null, transaction_statuses: { some: { status: 'Closed' } } } });
    if (closed < threshold) return;

    const newBrok = profile.upgrade_brok_pct;
    profile.agent_comm_pct = phpFloat(newAgent);
    profile.brok_comm_pct = newBrok === null || newBrok === undefined || newBrok === '' ? round2(100 - phpFloat(newAgent)) : phpFloat(newBrok);
    profile.split_upgraded = true;
    await tx.users.update({ where: { id: user.id }, data: { profile: JSON.stringify(phpJsonNormalize(profile)), updated_at: new Date() } });
  }

  private async syncTeam(tx: Tx, txnId: number, type: string, team: Record<string, unknown>[]): Promise<void> {
    const prev = await tx.team_members.findMany({ where: { transaction_id: txnId }, select: { name: true, access: true } });
    const prevAccess = new Map(prev.map((m) => [m.name, m.access]));
    await tx.team_members.deleteMany({ where: { transaction_id: txnId } });
    const now = new Date();
    let i = 0;
    for (const m of team) {
      const name = String(m.name ?? '');
      // Resolved once for the row: the same person answers both "whose split is this?" and "who is
      // this member?", so looking them up twice invites the two to disagree.
      const person = await this.people.resolve(null, name, { client: tx });
      const hasAgentPct = m.agent_pct !== undefined && m.agent_pct !== null && m.agent_pct !== '';
      let agentPct: number;
      let brokPct: number;
      if (hasAgentPct) {
        agentPct = phpFloat(m.agent_pct);
        brokPct = m.brok_pct !== undefined && m.brok_pct !== null && m.brok_pct !== '' ? phpFloat(m.brok_pct) : round2(100 - agentPct);
      } else {
        const split = await this.agentSplitFromProfile(tx, name, type, person?.id ?? null);
        agentPct = split.agent;
        brokPct = split.brok;
      }
      const isPrimary = m.is_primary !== undefined ? !!m.is_primary : i === 0;
      const access = isPrimary ? 'full' : String(m.access ?? prevAccess.get(name) ?? 'docs');
      const member = await tx.team_members.create({
        data: {
          transaction_id: txnId,
          name,
          // As above: the id beside the name, so a split is not resolved from an editable string.
          user_id: person?.id ?? null,
          split: (m.split ?? 0) as number,
          agent_pct: agentPct,
          brok_pct: brokPct,
          is_primary: isPrimary,
          access,
          scope: String(m.scope ?? 'Entire'),
          position: i,
          created_at: now,
          updated_at: now,
        },
      });
      const terms = Array.isArray(m.terms) ? [...new Set((m.terms as unknown[]).map(Number))] : [];
      for (const term of terms) {
        await tx.team_member_terms.create({ data: { team_member_id: member.id, term_no: term, created_at: now, updated_at: now } });
      }
      i++;
    }
  }

  private async syncStatuses(tx: Tx, txnId: number, type: string, statusesIn: unknown[]): Promise<void> {
    let statuses = [...new Set(statusesIn.filter(Boolean).map(String))];
    if (statuses.length === 0) {
      const def = this.defaultStatus(type);
      statuses = def !== '' ? [def] : [];
    }
    await tx.transaction_statuses.deleteMany({ where: { transaction_id: txnId } });
    const now = new Date();
    for (const status of statuses) {
      await tx.transaction_statuses.create({ data: { transaction_id: txnId, status, created_at: now, updated_at: now } });
    }
  }

  private async syncClients(tx: Tx, txnId: number, clients: Record<string, unknown>[]): Promise<void> {
    await tx.clients.deleteMany({ where: { transaction_id: txnId } });
    const now = new Date();
    let i = 0;
    for (const c of clients) {
      await tx.clients.create({ data: { transaction_id: txnId, name: String(c.name ?? ''), email: (c.email ?? null) as string | null, phone: (c.phone ?? null) as string | null, position: i, created_at: now, updated_at: now } });
      i++;
    }
  }

  private async syncConditions(tx: Tx, txnId: number, conditions: Record<string, unknown>[]): Promise<void> {
    // TD-033: match existing rows by id and update in place. Deleting and recreating gave every
    // condition a new id, which orphaned its generated document row - and syncConditionDocs then
    // purged that row's uploaded file from disk. Identity has to survive an ordinary save.
    const existing = await tx.conditions.findMany({ where: { transaction_id: txnId } });
    const known = new Set(existing.map((r) => r.id));
    const now = new Date();
    const keep = new Set<number>();
    let i = 0;
    for (const c of conditions) {
      const values = {
        type: String(c.type ?? 'Financing'),
        custom_name: (c.custom_name ?? null) as string | null,
        deadline: c.deadline ? new Date(String(c.deadline).slice(0, 10) + 'T00:00:00.000Z') : null,
        status: String(c.status ?? 'Pending'),
        position: i,
        updated_at: now,
      };
      const id = Number(c.id ?? 0);
      if (id && known.has(id)) {
        await tx.conditions.update({ where: { id }, data: values });
        keep.add(id);
      } else {
        const created = await tx.conditions.create({ data: { transaction_id: txnId, ...values, created_at: now } });
        keep.add(created.id);
      }
      i++;
    }
    const removed = existing.filter((r) => !keep.has(r.id)).map((r) => r.id);
    if (removed.length > 0) await tx.conditions.deleteMany({ where: { id: { in: removed } } });
  }

  private async syncInterBoard(tx: Tx, txnId: number, items: Record<string, unknown>[]): Promise<void> {
    await tx.inter_board_listings.deleteMany({ where: { transaction_id: txnId } });
    const now = new Date();
    let i = 0;
    for (const item of items) {
      await tx.inter_board_listings.create({ data: { transaction_id: txnId, name: (item.name ?? null) as string | null, board_id: (item.board_id ?? null) as string | null, verified: !!item.verified, position: i, created_at: now, updated_at: now } });
      i++;
    }
  }

  private async syncBrokerage(tx: Tx, txnId: number, data: Record<string, unknown> | null): Promise<void> {
    if (data === null) return;
    const now = new Date();
    const existing = await tx.brokerages.findUnique({ where: { transaction_id: txnId } });
    const values = {
      name: (data.name ?? null) as string | null,
      address: (data.address ?? null) as string | null,
      email: (data.email ?? null) as string | null,
      invoice_email: (data.invoice_email ?? null) as string | null,
      agent_email: (data.agent_email ?? null) as string | null,
      phone: (data.phone ?? null) as string | null,
    };
    const brokerage = existing
      ? await tx.brokerages.update({ where: { transaction_id: txnId }, data: { ...values, updated_at: now } })
      : await tx.brokerages.create({ data: { transaction_id: txnId, ...values, created_at: now, updated_at: now } });

    await tx.brokerage_agents.deleteMany({ where: { brokerage_id: brokerage.id } });
    const agents = Array.isArray(data.agents) ? (data.agents as unknown[]).filter(Boolean) : [];
    let i = 0;
    for (const name of agents) {
      await tx.brokerage_agents.create({ data: { brokerage_id: brokerage.id, name: String(name), position: i, created_at: now, updated_at: now } });
      i++;
    }
  }

  // ---- Recycle Bin capture ------------------------------------------------
  private async captureRemovedRows(tx: Tx, t: { id: number; admin_activities: string | null; adjustments: string | null }, actor: ActingUser | null, data: Record<string, unknown>): Promise<void> {
    const now = new Date();
    const save = async (mod: string, kind: string, agent: string | null, term: number | null, label: string, rowData: unknown): Promise<void> => {
      await tx.trashed_row_items.create({
        data: { transaction_id: t.id, module: mod, kind, agent, term, label, data: JSON.stringify(rowData), who: actor?.name ?? null, user_id: actor?.id ?? null, created_at: now, updated_at: now },
      });
    };

    if (Object.prototype.hasOwnProperty.call(data, 'admin_activities')) {
      const oldA = parseJsonObject(t.admin_activities);
      const newA = asObject(data.admin_activities);
      const scanAgents = async (oldAgents: Record<string, unknown>, newAgents: Record<string, unknown>, term: number | null): Promise<void> => {
        for (const [name, info] of Object.entries(oldAgents)) {
          const oldInfo = asObject(info);
          const newInfo = asObject(newAgents[name]);
          for (const p of this.rowsRemoved(asArray(oldInfo.payments), asArray(newInfo.payments))) {
            await save('admin_activities', 'agent_payment', name, term, ((term ? `Term ${term} ` : '') + 'Agent Commission Paid — ' + name).trim(), p);
          }
          for (const c of this.rowsRemoved(asArray(oldInfo.cta), asArray(newInfo.cta))) {
            await save('admin_activities', 'cta', name, term, ((term ? `Term ${term} ` : '') + 'CTA to BA — ' + name).trim(), c);
          }
        }
      };
      await scanAgents(asObject(oldA.agents), asObject(newA.agents), null);
      for (const [k, term] of Object.entries(asObject(oldA.term_admin))) {
        await scanAgents(asObject(asObject(term).agents), asObject(asObject(asObject(newA.term_admin)[k]).agents), parseInt(k, 10) || 0);
      }
    }

    if (Object.prototype.hasOwnProperty.call(data, 'adjustments')) {
      const oldA = parseJsonObject(t.adjustments);
      const newA = asObject(data.adjustments);
      const lists: [string, string, string][] = [
        ['adjustment_rows', 'adjustment_row', 'Adjustment Details'],
        ['advance_rows', 'advance_row', 'Advance Payment'],
        ['client_rows', 'client_row', 'Client Referral'],
      ];
      for (const [listKey, kind, label] of lists) {
        for (const r of this.rowsRemoved(asArray(oldA[listKey]), asArray(newA[listKey]))) {
          const who2 = (r.agent ?? r.client_name ?? null) as string | null;
          await save('adjustments', kind, who2, null, label + (who2 ? ` — ${who2}` : ''), r);
        }
      }
      const oldExt = (oldA.ext_referral ?? 'No') === 'Yes' && !this.isEmpty(oldA.ext);
      const newExt = (newA.ext_referral ?? 'No') === 'Yes' && !this.isEmpty(newA.ext);
      if (oldExt && !newExt) {
        const ext = asObject(oldA.ext);
        const agentName = (ext.agent_name ?? null) as string | null;
        await save('adjustments', 'ext_referral', agentName, null, 'External Brokerage Referral' + (agentName ? ` — ${agentName}` : ''), oldA.ext);
      }
    }
  }

  private isEmpty(v: unknown): boolean {
    if (v === null || v === undefined) return true;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === 'object') return Object.keys(v).length === 0;
    return v === '' || v === 0 || v === false;
  }

  private rowsRemoved(oldRows: Record<string, unknown>[], newRows: Record<string, unknown>[]): Record<string, unknown>[] {
    const drop = oldRows.length - newRows.length;
    if (drop <= 0) return [];
    const newEnc = newRows.map((r) => JSON.stringify(r));
    const removed: Record<string, unknown>[] = [];
    for (const r of oldRows) {
      if (!newEnc.includes(JSON.stringify(r))) {
        removed.push(r);
        if (removed.length >= drop) break;
      }
    }
    return removed;
  }

  // ---- client-payment + adjustment-status sync ----------------------------
  private async syncClientPayment(tx: Tx, txnId: number): Promise<void> {
    const t = await tx.transactions.findUnique({ where: { id: txnId }, include: { team_members: { include: { team_member_terms: true } }, precon_terms: true } });
    if (!t || !isListingFinancial(t.type)) return;

    const bd = await this.commission.breakdown(normalizeCommissionTxn(t));
    if (bd.variant !== 'listing') return;
    const trust = asObject(bd.trust);
    const payable = phpFloat(trust.payable_to_client ?? 0);
    const receivable = phpFloat(trust.receivable_from_lawyer ?? 0);

    const admin = parseJsonObject(t.admin_activities);
    const tracker = parseJsonObject(t.activity_tracker);
    let dirty = false;
    const hasVoidCheque = !this.isEmpty(asObject(tracker.void_cheque).data);

    const recv = asObject(admin.recv_lawyer).enabled ?? null;
    if (receivable <= 0) {
      if (recv !== 'N/A') { admin.recv_lawyer = { ...asObject(admin.recv_lawyer), enabled: 'N/A' }; dirty = true; }
    } else if (recv === null || recv === '' || recv === 'N/A') {
      admin.recv_lawyer = { ...asObject(admin.recv_lawyer), enabled: 'No' }; dirty = true;
    }

    if (payable <= 0) {
      if ((asObject(admin.paid_client).enabled ?? null) !== 'N/A') { admin.paid_client = { ...asObject(admin.paid_client), enabled: 'N/A' }; dirty = true; }
      if ((tracker.client_payment_paid ?? null) !== 'N/A') { tracker.client_payment_paid = 'N/A'; dirty = true; }
      if ((admin.void_cheque_received ?? null) !== 'N/A') { admin.void_cheque_received = 'N/A'; dirty = true; }
    } else {
      let pc = asObject(admin.paid_client).enabled ?? null;
      if (pc === null || pc === '' || pc === 'N/A') { admin.paid_client = { ...asObject(admin.paid_client), enabled: 'No' }; pc = 'No'; dirty = true; }
      if (pc === 'Yes' && (tracker.client_payment_paid ?? null) !== 'Yes') { tracker.client_payment_paid = 'Yes'; dirty = true; }
      const vc = admin.void_cheque_received ?? null;
      if (hasVoidCheque && vc !== 'Yes') { admin.void_cheque_received = 'Yes'; dirty = true; }
      else if (!hasVoidCheque && vc === 'Yes') { admin.void_cheque_received = 'No'; dirty = true; }
    }

    if (dirty) {
      await tx.transactions.update({ where: { id: txnId }, data: { admin_activities: JSON.stringify(phpJsonNormalize(admin)), activity_tracker: JSON.stringify(phpJsonNormalize(tracker)) } });
    }
  }

  private async syncAdjustmentStatuses(tx: Tx, txnId: number): Promise<void> {
    const t = await tx.transactions.findUnique({ where: { id: txnId }, select: { adjustments: true, comm_paid_status: true, activity_tracker: true, admin_activities: true } });
    if (!t) return;
    const adj = parseJsonObject(t.adjustments);
    if ((adj.agent_adjust ?? null) !== 'Yes' || !Array.isArray(adj.adjustment_rows) || adj.adjustment_rows.length === 0) return;

    const paidAgents = this.paidAgentNames(t.admin_activities);
    const dealPaid = t.comm_paid_status === 'Yes' || (parseJsonObject(t.activity_tracker).agent_commission_paid_status ?? null) === 'Yes';

    let changed = false;
    const rows = adj.adjustment_rows as Record<string, unknown>[];
    rows.forEach((row) => {
      const agent = String(row.agent ?? '');
      const amount = toFloat(row.amount ?? 0);
      let status: string;
      if (agent !== '' && (paidAgents.includes(agent) || dealPaid)) status = 'Closed';
      else if (agent !== '' && Math.abs(amount) > 0) status = 'Yet to Adjust';
      else status = '';
      if ((row.status ?? null) !== status) { row.status = status; changed = true; }
    });

    if (changed) await tx.transactions.update({ where: { id: txnId }, data: { adjustments: JSON.stringify(phpJsonNormalize(adj)) } });
  }

  private paidAgentNames(adminJson: string | null): string[] {
    const admin = parseJsonObject(adminJson);
    const names: string[] = [];
    const scan = (agents: Record<string, unknown>): void => {
      for (const [name, info] of Object.entries(agents)) {
        for (const p of asArray(asObject(info).payments)) {
          if ((p.paid_status ?? null) === 'Paid') { names.push(name); break; }
        }
      }
    };
    scan(asObject(admin.agents));
    for (const term of Object.values(asObject(admin.term_admin))) scan(asObject(asObject(term).agents));
    return names;
  }

  // ---- destroy + agent-change review -------------------------------------
  async destroy(user: AuthUserRecord | null, txnId: number): Promise<{ message: string }> {
    if (user && isAgent(user)) {
      throw new ForbiddenException({ message: 'Agents cannot delete transactions. Request deletion instead.' });
    }
    const t = await this.prisma.transactions.findFirst({ where: { id: txnId, deleted_at: null } });
    if (!t) throw new NotFoundException({ message: `No query results for model [App\\Models\\Transaction] ${txnId}.` });
    const actor: ActingUser | null = user ? { id: user.id, name: user.name } : null;
    await this.audit.record(txnId, actor, {
      section: 'Basic Information', action: 'Record removed', source: 'Manual',
      details: `Trade #${t.trade_no} (${t.type})`,
    });
    // An invoice only exists because of its transaction, so it goes with it. Left behind it
    // stays listed on the Invoice screen and in the financial totals, pointing at a deal that is
    // no longer there — which is how this database already came to hold an invoice whose
    // transaction was deleted.
    //
    // The SAME timestamp is written to both. That is what makes the pairing reversible: on
    // restore, only invoices deleted in this exact moment come back, so an invoice that was
    // deleted on its own beforehand stays deleted.
    const at = new Date();
    await this.prisma.$transaction([
      this.prisma.invoices.updateMany({ where: { transaction_id: txnId, deleted_at: null }, data: { deleted_at: at } }),
      this.prisma.transactions.update({ where: { id: txnId }, data: { deleted_at: at } }),
    ]);
    return { message: 'Transaction deleted' };
  }

  /** `note` is optional — "Verified against APS", or nothing at all. */
  async reviewAgentChanges(user: AuthUserRecord | null, txnId: number, note: string | null = null): Promise<{ data: Record<string, unknown> }> {
    if (!isAdminOrAbove(user)) throw new ForbiddenException({ message: 'Administrator access required.' });
    await this.assertExists(txnId);
    const txn = await this.prisma.transactions.findUnique({ where: { id: txnId }, select: { agent: true } });
    await this.prisma.audit_logs.updateMany({ where: { transaction_id: txnId, source: 'Agent', handled: false }, data: { handled: true, updated_at: new Date() } });
    await this.prisma.transactions.update({ where: { id: txnId }, data: { agent_review_at: new Date() } });
    // Written after the changes are marked handled, so the record describes a review that happened.
    await this.reviews.recordReviewed(txnId, user, note, txn?.agent ?? null);
    return this.loadResource(txnId, user);
  }

  /**
   * Reject one of the agent's changes, with the reason the administrator gave.
   *
   * A rejection is never refused for being un-revertable. Putting the old value back is something
   * this can do for a Status or a Contact and cannot do for most fields; either way the decision,
   * the reason and the notification stand, and the record says which of the two happened. The old
   * behaviour threw instead, so a rejection of any other field was lost entirely — the agent was
   * never told, and nothing was written down.
   */
  async rejectAgentChange(user: AuthUserRecord | null, txnId: number, auditId: number, reason: string): Promise<{ data: Record<string, unknown> }> {
    if (!isAdminOrAbove(user)) throw new ForbiddenException({ message: 'Administrator access required.' });
    await this.assertExists(txnId);
    const log = await this.prisma.audit_logs.findFirst({ where: { id: auditId, transaction_id: txnId, source: 'Agent', handled: false } });
    if (!log) throw new NotFoundException({ message: 'Change not found.' });

    // TD-038. A rejection must never write over a value somebody has changed since. The audit ids
    // answer that where comparing values cannot: a field changed away and back reads identical,
    // but the agent's edit is no longer what is standing.
    //
    // GROUPED FIELDS ARE CHECKED AS A WHOLE ROW. Adding a client writes one entry per subfield and
    // rejecting any one of them removes the entire row, so a sibling corrected since must block it.
    const fam = /^((?:Client|Condition|Inter-Board) #\d+) /.exec(String(log.field ?? ''));
    const fieldWhere = fam ? { startsWith: fam[1] + ' ' } : log.field;

    const newer = await this.prisma.audit_logs.findFirst({
      where: { transaction_id: txnId, id: { gt: log.id }, field: fieldWhere },
      orderBy: { id: 'asc' }, select: { id: true },
    });
    const earlierPending = await this.prisma.audit_logs.findFirst({
      where: { transaction_id: txnId, id: { lt: log.id }, source: 'Agent', handled: false, field: fieldWhere },
      orderBy: { id: 'desc' }, select: { id: true },
    });

    // Belt and braces for anything written without an audit entry. Both sides normalised, so a
    // field the agent CLEARED (null against '') is not mistaken for a change.
    const norm = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
    const snapNow = await this.audit.snapshot(txnId);
    const entry = Object.values(snapNow).find((e) => e.section === log.section && e.field === log.field);
    const valueMoved = entry !== undefined && norm(entry.value) !== norm(log.new_value);

    const blockedBy = !log.field ? 'this entry does not name a field'
      : newer ? 'it has been changed since'
      : earlierPending ? 'an earlier change to it is still awaiting review'
      : valueMoved ? 'it no longer holds the value this change made'
      : null;

    const reverted = blockedBy ? false : await this.revertAgentChange(txnId, log);
    // VarChar(255): truncate, so a long field name cannot 500 the request after handled is set.
    const skipNote = blockedBy
      ? `Not restored - ${log.field ?? log.section ?? 'this field'} was left as it is because ${blockedBy}. The rejection has been recorded.`.slice(0, 250)
      : undefined;
    const actor: ActingUser | null = user ? { id: user.id, name: user.name } : null;
    await this.prisma.audit_logs.update({ where: { id: log.id }, data: { handled: true, updated_at: new Date() } });
    await this.audit.record(txnId, actor, {
      section: log.section,
      field: log.field,
      action: reverted ? 'Agent change rejected (reverted)' : blockedBy ? 'Agent change rejected (not reverted — value left as it stands)' : 'Agent change rejected (value kept — agent to correct)',
      source: 'Manual',
      old: log.new_value,
      new: reverted ? log.old_value : log.new_value,
      details: reason,
    });

    await this.reviews.recordRejection({
      txnId,
      actor: user,
      auditLogId: log.id,
      reason,
      // The label the agent will recognise, and the one a later correction is matched against.
      fieldLabel: log.field ?? log.section,
      oldValue: log.old_value,
      newValue: log.new_value,
      agentName: log.who ?? null,
      autoReverted: reverted,
      autoRevertNote: skipNote,
    });
    return this.loadResource(txnId, user);
  }

  /**
   * Why a hand-picked trade number cannot be used, or null if it can.
   *
   * Exposed for the bulk importer, which validates a whole file BEFORE writing anything and so
   * needs the answer without attempting a create. store() applies the same check again at write
   * time, so a number taken between review and import is still caught.
   */
  async tradeNumberProblem(type: string, raw: unknown): Promise<string | null> {
    return this.tradeNumbers.manualProblem(this.prisma, type, raw);
  }

  private async assertExists(txnId: number): Promise<void> {
    const t = await this.prisma.transactions.findFirst({ where: { id: txnId, deleted_at: null }, select: { id: true } });
    if (!t) throw new NotFoundException({ message: `No query results for model [App\\Models\\Transaction] ${txnId}.` });
  }

  private async loadResource(txnId: number, user: AuthUserRecord | null, inMemoryNulls?: readonly string[]): Promise<{ data: Record<string, unknown> }> {
    // Every create returns through here, so this is where a new deal's cache is first built.
    await this.refreshPaymentCache(txnId);
    const full = (await this.prisma.transactions.findUnique({ where: { id: txnId }, include: txnShowIncludeFor(user) })) as unknown as LoadedTxn;
    // On create, Laravel returns the in-memory model (loadDetail loads relations but never
    // refreshes scalar attributes), so columns not passed to create() read as null in the
    // POST response even though the DB row carries their non-null default. Replicate that
    // for the response only — the stored row keeps its default, so GET /show still matches.
    if (inMemoryNulls) for (const c of inMemoryNulls) (full as unknown as Record<string, unknown>)[c] = null;
    const ctx = { user: user ? ({ id: user.id, role: user.role, name: user.name } as ResourceUser) : null, commission: this.commission, prisma: this.prisma };
    return { data: await transactionResource(full, ctx) };
  }

  private async revertAgentChange(txnId: number, log: { section: string | null; field: string | null; old_value: string | null; action: string | null }): Promise<boolean> {
    const section = log.section;
    const field = String(log.field ?? '');
    const old = log.old_value;
    const action = log.action;
    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      const t = await tx.transactions.findUnique({ where: { id: txnId }, select: { type: true } });
      const type = t?.type ?? '';

      if (section === 'Status' && field === 'Status') {
        await this.syncStatuses(tx, txnId, type, String(old ?? '').split(',').map((s) => s.trim()).filter(Boolean));
        return true;
      }

      const column = this.audit.columnForLabel(field);
      if (column) {
        let value: unknown;
        if (REVERT_BOOL.has(column)) value = old === 'Yes';
        else if (REVERT_DATE.has(column)) value = old === null || old === '' ? null : new Date(String(old).slice(0, 10) + 'T00:00:00.000Z');
        else if (INT_COLS.has(column)) value = old === null || old === '' ? null : Number(old);
        else value = old === '' ? null : old;
        await tx.transactions.update({ where: { id: txnId }, data: { [column]: value, updated_at: now } as Prisma.transactionsUpdateInput });
        return true;
      }

      if (section === 'Contacts') {
        const bmap: Record<string, string> = { 'Brokerage Name': 'name', 'Brokerage Address': 'address', 'Brokerage Email': 'email', 'Brokerage Invoice Email': 'invoice_email', 'Brokerage Agent Email': 'agent_email', 'Brokerage Phone': 'phone' };
        if (bmap[field]) {
          const val = old === '' ? null : old;
          await tx.brokerages.upsert({ where: { transaction_id: txnId }, create: { transaction_id: txnId, [bmap[field]]: val, created_at: now, updated_at: now }, update: { [bmap[field]]: val, updated_at: now } });
          return true;
        }
        if (field === 'Listing Agent Name(s)') {
          const b = await tx.brokerages.upsert({ where: { transaction_id: txnId }, create: { transaction_id: txnId, created_at: now, updated_at: now }, update: {} });
          await tx.brokerage_agents.deleteMany({ where: { brokerage_id: b.id } });
          const names = String(old ?? '').split(',').map((s) => s.trim()).filter(Boolean);
          let i = 0;
          for (const n of names) { await tx.brokerage_agents.create({ data: { brokerage_id: b.id, name: n, position: i, created_at: now, updated_at: now } }); i++; }
          return true;
        }
      }

      const cols: Record<string, { rel: 'clients' | 'conditions' | 'inter_board_listings'; prefix: string; fields: Record<string, string> }> = {
        'Client Information': { rel: 'clients', prefix: 'Client', fields: { Name: 'name', Email: 'email', Phone: 'phone' } },
        Conditions: { rel: 'conditions', prefix: 'Condition', fields: { Name: 'custom_name', Deadline: 'deadline', Status: 'status' } },
        'Property Information': { rel: 'inter_board_listings', prefix: 'Inter-Board', fields: { Name: 'name', Board: 'board_id', Verified: 'verified' } },
      };
      const cfg = section ? cols[section] : undefined;
      if (cfg) {
        const m = field.match(new RegExp('^' + cfg.prefix.replace(/[-]/g, '\\$&') + ' #(\\d+) (.+)$'));
        if (m) {
          const sub = cfg.fields[m[2]];
          if (!sub) return false;
          const i = parseInt(m[1], 10) - 1;
          const val = sub === 'verified' ? old === 'Yes' : old === '' ? null : old;
          const currentRows = await this.collectionRows(tx, cfg.rel, txnId);
          if (action === 'Added') {
            if (currentRows[i] !== undefined) currentRows.splice(i, 1);
          } else if (action === 'Removed') {
            while (currentRows.length <= i) currentRows.push(this.blankCollectionRow(cfg.rel));
            currentRows[i][sub] = val;
          } else if (currentRows[i] !== undefined) {
            currentRows[i][sub] = val;
          }
          if (cfg.rel === 'clients') await this.syncClients(tx, txnId, currentRows);
          else if (cfg.rel === 'conditions') await this.syncConditions(tx, txnId, currentRows);
          else await this.syncInterBoard(tx, txnId, currentRows);
          return true;
        }
      }
      return false;
    });
  }

  private async collectionRows(tx: Tx, rel: 'clients' | 'conditions' | 'inter_board_listings', txnId: number): Promise<Record<string, unknown>[]> {
    if (rel === 'clients') {
      const rows = await tx.clients.findMany({ where: { transaction_id: txnId }, orderBy: { position: 'asc' } });
      return rows.map((r) => ({ name: r.name, email: r.email, phone: r.phone }));
    }
    if (rel === 'conditions') {
      const rows = await tx.conditions.findMany({ where: { transaction_id: txnId }, orderBy: { position: 'asc' } });
      return rows.map((r) => ({ id: r.id, type: r.type, custom_name: r.custom_name, deadline: r.deadline ? r.deadline.toISOString().slice(0, 10) : null, status: r.status }));
    }
    const rows = await tx.inter_board_listings.findMany({ where: { transaction_id: txnId }, orderBy: { position: 'asc' } });
    return rows.map((r) => ({ name: r.name, board_id: r.board_id, verified: r.verified }));
  }

  private blankCollectionRow(rel: 'clients' | 'conditions' | 'inter_board_listings'): Record<string, unknown> {
    if (rel === 'clients') return { name: '', email: null, phone: null };
    if (rel === 'conditions') return { type: 'Financing', custom_name: null, deadline: null, status: 'Pending' };
    return { name: null, board_id: null, verified: false };
  }
}
