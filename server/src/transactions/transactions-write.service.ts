import { TransactionsService } from './transactions.service';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PersonResolver } from '../core/person-resolver.service';
import { AuditService, type ActingUser } from '../audit/audit.service';
import { CommissionService } from './commission.service';
import { PaymentCacheService } from './payment-cache.service';
import { normalizeCommissionTxn } from './commission.loader';
import { parseJsonObject, phpEmpty, phpFloat, phpJsonNormalize, round2, toFloat } from '../common/serialize';
import { canonicalTransactionType, isInvoiceableType, isListingType, SECURED_DEAL_TYPES, statusSetProblem, TRANSACTION_TYPES } from '../reference/transaction.constants';
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
 * TD-076 — the advisory-lock class for the create-time duplicate guard.
 *
 * Postgres advisory locks share one global space, so a bare hash could collide with a lock taken
 * for something else entirely. The two-argument form namespaces this rule under a class of its own
 * and makes it recognisable in `pg_locks` while somebody is diagnosing a wait.
 */
const DUPLICATE_LOCK_CLASS = 76;

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

/**
 * TD-111 — the Adjustment panel's sections: the Yes/No toggle, and what it holds when it is on.
 *
 * The three lists and the single external-referral object, in the order the panel shows them. The
 * external referral is an object rather than an array, which is why the clearing below asks what
 * shape it is looking at instead of assuming a list.
 */
const ADJUSTMENT_SECTIONS: [toggle: string, holds: string][] = [
  ['agent_adjust', 'adjustment_rows'],
  ['advance_payment', 'advance_rows'],
  ['client_referral', 'client_rows'],
  ['ext_referral', 'ext'],
];

/**
 * Does this section actually hold anything?
 *
 * A list holds something when it has a row. An OBJECT is judged by its values, because the form
 * posts the external referral as a full set of blank strings whether or not anybody filled it in —
 * treating that as content would file an empty Recycle Bin entry on every save of every deal that
 * has ever opened the panel. 'No' and 'N/A' are that form's own select defaults, so they are blank
 * in the same sense.
 */
function sectionHasContent(held: unknown): boolean {
  if (Array.isArray(held)) return held.length > 0;
  if (held === null || typeof held !== 'object') return false;
  const blank = new Set(['', 'No', 'N/A']);
  return Object.values(held as Record<string, unknown>)
    .some((v) => v !== null && v !== undefined && v !== false && !(typeof v === 'string' && blank.has(v)));
}

/**
 * TD-111 — empty the sections whose toggle is not 'Yes', so a section switched off holds nothing.
 *
 * Exported for the test that reads it directly: what it does is a rule about the record, and the
 * rule is worth stating on its own rather than only through a save.
 */
export function clearSwitchedOffSections(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const adj = { ...(value as Record<string, unknown>) };
  for (const [toggle, holds] of ADJUSTMENT_SECTIONS) {
    if ((adj[toggle] ?? 'No') === 'Yes') continue;
    if (!sectionHasContent(adj[holds])) continue;
    adj[holds] = Array.isArray(adj[holds]) ? [] : {};
  }
  return adj;
}

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
    private readonly txns: TransactionsService,
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
    /*
     * TD-050 — a caller may send the name the screens show, and it is stored as the value behind it.
     *
     * Three types are relabelled in the client: `Residential Sale Listing` reads as "Sale Listing",
     * `Residential Lease Listing` as "Lease Listing", `Preconstruction` as "Pre-construction". Those
     * labels are the only names the application ever shows, and sending one was refused as "not a
     * transaction type this system offers" — quoting a list the caller had never seen.
     *
     * Resolved on the WAY IN, once, so everything after this line — the required-field rules, the
     * status vocabulary, the row that gets written — sees the stored value and nothing downstream
     * needs to know an alias existed. An unknown string still resolves to nothing and is still
     * refused by the catalogue check below (TD-068).
     */
    if (String(body.type ?? '').trim() !== '') body.type = canonicalTransactionType(String(body.type)) ?? String(body.type).trim();
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

    /*
     * TD-076 — THE DUPLICATE GUARD HAS TO HOLD WHEN TWO SAVES ARRIVE TOGETHER.
     *
     * The guard is a SELECT followed by an INSERT, and it ran BEFORE the write transaction. Sent
     * one after the other, the second create is correctly refused with "Transaction already exists
     * — Trade #NNN". Fired simultaneously — a double-click, a retry, a flaky connection, two people
     * saving the same deal — both requests selected, both found nothing, and both inserted. Two
     * identical deals, each with its own trade number, and nothing to say which is real.
     *
     * A UNIQUE INDEX CANNOT EXPRESS THIS RULE. The match is fuzzy on the address: "9 Oak Rd" and
     * "9 Oak Road Unit 2" are compared by `propertiesSimilar`, not by equality, so there is no
     * column tuple a constraint could be placed on. What CAN be serialised is the candidate set —
     * every deal sharing Type, Price and Offer Date — so the check and the insert now happen inside
     * one transaction holding an advisory lock on exactly that key. Two racing saves of the same
     * deal take the same lock; the loser then sees the winner's row and gets the same 422 the
     * sequential path has always produced.
     *
     * The lock is per-key, so it costs nothing to unrelated saves: deals differing in type, price
     * or offer date hash to different keys and never queue behind each other. It is a TRANSACTION
     * lock, released on commit or rollback, so a failure cannot leave it held.
     *
     * Listings are outside this rule, as they always were: they carry no offer date to key on.
     */
    const txnId = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      if (!isListing && !phpEmpty(body.offer_date)) {
        const offerDate = toDate(body.offer_date);
        const price = toFloat(body.price ?? 0);
        await this.lockDuplicateKey(tx, `${type}|${price}|${offerDate ? offerDate.toISOString().slice(0, 10) : ''}`);

        // Soft-deleted rows are excluded (Eloquent SoftDeletes global scope → deleted_at null).
        const candidates = await tx.transactions.findMany({
          where: { type, price, offer_date: offerDate, deleted_at: null },
        });
        for (const cand of candidates) {
          if (this.propertiesSimilar(String(body.property ?? ''), String(cand.property ?? ''))) {
            const on = cand.agent ? ` on ${cand.agent}` : ' (unassigned)';
            throw new UnprocessableEntityException({ message: `Transaction already exists${on} — Trade #${cand.trade_no}. Same Type, Price and Offer Date with a matching Property Address.` });
          }
        }
      }
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
  /**
   * TD-076 — serialise everything that could be a duplicate of this deal, and nothing else.
   *
   * A Postgres advisory lock keyed by Type + Price + Offer Date. Two racing creates of the same
   * deal queue; a create of any other deal is untouched. The key is hashed here rather than with
   * `hashtext()` so the lock does not depend on an internal Postgres function, and the two-argument
   * form carries a fixed class id, which makes the lock identifiable in `pg_locks` as this rule
   * rather than an anonymous number.
   */
  private async lockDuplicateKey(tx: Tx, key: string): Promise<void> {
    // FNV-1a, folded into the signed 32-bit range `pg_advisory_xact_lock(int, int)` takes.
    let hash = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) {
      hash ^= key.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    // Cast in SQL: Prisma sends a JS number as a bigint parameter, and there is no
    // `pg_advisory_xact_lock(bigint, bigint)` — only the one-argument bigint form and this
    // two-argument int one. Without the casts every create answers 42883.
    await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock($1::int, $2::int)', DUPLICATE_LOCK_CLASS, hash | 0);
  }

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

  /**
   * TD-003 — the one refusal for a save that is not wrong, only late.
   *
   * Built in one place because it is raised from two: the cheap read-time comparison and the
   * write-time claim that closes the race between them. Both have to name the same numbers, or a
   * screen would show one story for the common case and another for the narrow one.
   */
  private staleTransaction(sent: number, current: number | null, updatedAt: Date | null): ConflictException {
    return new ConflictException({
      message: 'Somebody else changed this transaction while you were editing it. Reload to see their version, then apply your change again.',
      conflict: { current_version: current, your_version: sent, updated_at: updatedAt },
    });
  }

  async update(user: AuthUserRecord | null, txnId: number, body: Record<string, unknown>): Promise<{ data: Record<string, unknown>; message?: string }> {
    const t = await this.prisma.transactions.findFirst({ where: { id: txnId, deleted_at: null } });
    if (!t) throw new NotFoundException({ message: `No query results for model [App\\Models\\Transaction] ${txnId}.` });

    /*
     * TD-003 — OPTIMISTIC LOCKING. Two people editing one deal both got 200 and the later write
     * silently won.
     *
     * What makes this module worse than a normal last-write-wins is that the save is not a patch.
     * The detail screen sends the ENTIRE object on every save (`buildPayload`), so the second
     * person does not merely overwrite the field they touched — every field they are holding a
     * stale copy of goes back too. The reported case changed only an address and reverted a
     * $400,000 price change made minutes earlier, with nothing said to either person.
     *
     * The client sends back the version it read; if the row has moved on since, the save is
     * refused with a 409 carrying the current state, so the screen can say what happened. Same
     * shape the Calendar has used since 20260801060000 — see `CalendarService.update`.
     *
     * Absent `version` still saves, deliberately: an integration, a script or an older client
     * should not start failing. Anything that sends one gets the protection.
     */
    let expectedVersion: number | null = null;
    if (body.version !== undefined && body.version !== null && body.version !== '') {
      const sent = Number(body.version);
      if (!Number.isInteger(sent) || sent < 1) {
        throw new BadRequestException({ message: 'That version is not valid.' });
      }
      if (sent !== t.version) throw this.staleTransaction(sent, t.version, t.updated_at);
      // Kept for the WRITE, which is where the check has to be repeated — see below.
      expectedVersion = sent;
    }

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

    /*
     * TD-111 — A SECTION SWITCHED OFF DOES NOT KEEP WHAT IT HELD.
     *
     * Each of the Adjustment panel's sections is a Yes/No toggle over a list. Setting the toggle
     * back to No hid the rows and stopped applying them — the money is released correctly — but the
     * rows stayed in the stored blob, invisible from every screen. Dormant, until somebody set the
     * toggle back to Yes: an entry nobody remembers making, applied by somebody who had no way to
     * know it was waiting there.
     *
     * IT IS CLEARED, NOT KEPT-AND-SHOWN, because this panel already answers the question. The
     * fourth section, the external referral, has always treated its toggle going off as a REMOVAL —
     * `captureRemovedRows` files it in the Recycle Bin — and `RecycleBinService.restore` puts a
     * restored row back by setting its toggle to 'Yes' again. That restore was written for a world
     * where a switched-off section holds nothing. The three lists were the ones not keeping to it.
     *
     * NOTHING IS DESTROYED. This runs BEFORE `captureRemovedRows`, so what it clears is what that
     * method sees disappear, and every row lands in the Recycle Bin exactly as if it had been
     * deleted with the row's own bin button — restorable, by name, with the toggle coming back on.
     *
     * A save that leaves a section ON is untouched, and the arithmetic is untouched either way: a
     * dormant row was already being skipped by every consumer that gates on the toggle. The one
     * that did not is fixed with it — see `AgentsService.loans`.
     */
    if (Object.prototype.hasOwnProperty.call(data, 'adjustments')) {
      data.adjustments = clearSwitchedOffSections(data.adjustments);
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
      // TD-050 — the same resolution as `store`: what the screens display is accepted and stored
      // as the value behind it, and anything else is still refused.
      const submittedType = canonicalTransactionType(String(data.type ?? '')) ?? String(data.type ?? '').trim();
      if (submittedType) data.type = submittedType;
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
    /*
     * TD-095 - THE BROKERAGE RULED ON 2026-09-03 THAT ACCOUNTING MAY CHANGE THE MONEY.
     *
     * A guard was written here refusing price, deposit and the commission settings for this role,
     * and it was withdrawn the same morning: the brokerage's rule is that Accounting CAN make the
     * change, provided it is recorded. So the control is not the problem - the record is.
     *
     * The edit is already written to the Audit Trail in full: who, which field, old value, new
     * value and timestamp. What it does not reach is the DEAL'S OWN history, which carries only
     * agent_changes - that gap is TD-082 and affects every non-agent role, not just this one.
     *
     * Do not re-add a role block here without asking again.
     */
    /*
     * TD-107 - an agent is not paid out of money the brokerage has not collected.
     *
     * The payout lives in admin_activities.agents[name].payments[], a row counting as paid when
     * paid_status === 'Paid' (see agentPaymentsPaid). Nothing checked the deal had actually
     * received its commission first, so two clicks recorded a payout - Paid Type, a batch number -
     * against a deal that had collected nothing. It was masked only while the payout failed to
     * persist (TD-081); with that fixed it saves, and with TD-106 the commission-received date is
     * now reliably set when a payment settles the invoice, so 'nothing collected' is a real test.
     *
     * Refused when a payout row goes from not-Paid to Paid AND no linked invoice carries a
     * commission-received date. An existing paid row that is merely re-saved is left alone, so this
     * never blocks editing a deal whose agents were already, legitimately, paid.
     */
    if (Object.prototype.hasOwnProperty.call(data, 'admin_activities')) {
      const wasPaid = (blob: unknown): Set<string> => {
        const out = new Set<string>();
        const agents = asObject(asObject(blob).agents);
        for (const [name, info] of Object.entries(agents)) {
          for (const pay of asArray(asObject(info).payments)) {
            if (String(asObject(pay).paid_status) === 'Paid') out.add(name + '|' + JSON.stringify(asObject(pay).paid_date ?? '') + '|' + String(asObject(pay).amount ?? ''));
          }
        }
        return out;
      };
      const before = wasPaid(parseJsonObject(t.admin_activities));
      const nowPaid = wasPaid(data.admin_activities);
      const newlyPaid = [...nowPaid].some((k) => !before.has(k));
      if (newlyPaid) {
        const invs = await this.prisma.invoices.findMany({ where: { transaction_id: txnId, deleted_at: null }, select: { commission_received_date: true } });
        const collected = invs.some((i) => i.commission_received_date !== null);
        if (!collected) {
          const m = 'This deal has not received its commission yet, so an agent payout cannot be recorded against it. Record the commission payment on the invoice first - the received date fills in automatically - then pay the agent.';
          throw new UnprocessableEntityException({ message: m, errors: { admin_activities: [m] } });
        }
      }
    }

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

    /*
     * TD-071 — A TYPE CHANGE CARRIES THE STATUS WITH IT, SO IT HAS TO ANSWER FOR IT.
     *
     * The vocabulary was enforced only against statuses arriving in the SAME request: the block
     * above runs when `statuses` is submitted and changed. A PUT carrying nothing but a new type
     * never looked at what the deal was already holding — so a Residential Buying deal marked
     * "Secured Firm" became a Residential Sale Listing still marked "Secured Firm", a combination
     * the very same API refuses on a direct write with "Allowed: Open, Closed, Mutual Release, DFT,
     * Void". The deal was not accepted into an impossible state; it was CARRIED into one.
     *
     * That is not cosmetic. Status decides the edit-lock, the commission layout and every status
     * filter in the reports, so a deal holding a status its type does not define behaves
     * unpredictably in all three and nothing on screen says why.
     *
     * REFUSED RATHER THAN CLEARED. TD-015 was the opposite defect — a type change that wiped the
     * status silently — and clearing it here would be that bug again wearing a different hat. The
     * caller is told what the new type would leave behind and can send a status the type allows in
     * the same request, which is one round trip and no lost information.
     *
     * The EFFECTIVE set is judged: statuses submitted alongside the type when there are any,
     * otherwise the stored ones. That also closes the narrower hole above, where re-sending the
     * same statuses with a new type counted as "unchanged" and skipped the check entirely.
     */
    if (Object.prototype.hasOwnProperty.call(data, 'type')) {
      const newType = String(data.type ?? t.type);
      if (newType !== t.type) {
        const effective = Object.prototype.hasOwnProperty.call(data, 'statuses')
          ? [...new Set((data.statuses as unknown[]).filter(Boolean).map(String))]
          : statuses;
        const problem = statusSetProblem(newType, effective);
        if (problem) {
          const m = `Changing this deal to ${newType} would leave it holding a status that type cannot have. ${problem}`;
          throw new UnprocessableEntityException({ message: m, errors: { type: [m], statuses: [problem] } });
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

      /*
       * THE VERSION IS CHECKED AGAIN HERE, IN THE WRITE ITSELF.
       *
       * The comparison in the preamble is a separate read, and under read-committed both of two
       * simultaneous saves can finish it before either writes: both see version 4, both pass, both
       * UPDATE, and the second silently erases the first — the very thing this defect is about,
       * merely made narrower. `updateMany` with `version` in the WHERE makes the check and the
       * write one statement: Postgres takes a row lock, the loser re-evaluates the predicate
       * against the committed row, matches nothing, and reports `count: 0`.
       *
       * Losing here aborts the enclosing `$transaction`, so the status, client, condition and
       * brokerage syncs below — and the audit rows `captureRemovedRows` just wrote — all roll back
       * with it. A refused save leaves nothing behind.
       *
       * A caller that sent no version keeps the unconditional update, exactly as before. Either
       * way the row's version moves, so everyone else's open form learns it is stale.
       */
      if (expectedVersion !== null) {
        const claimed = await tx.transactions.updateMany({
          where: { id: txnId, version: expectedVersion },
          data: { ...(fill as Prisma.transactionsUpdateManyMutationInput), version: { increment: 1 }, updated_at: new Date() },
        });
        if (claimed.count === 0) {
          // Somebody committed between the read above and this statement. Re-read on the outer
          // connection — `tx` is about to roll back, and its snapshot cannot see their commit — so
          // the reply carries the version they actually have to reconcile against.
          const now = await this.prisma.transactions.findUnique({
            where: { id: txnId }, select: { version: true, updated_at: true },
          });
          throw this.staleTransaction(expectedVersion, now?.version ?? null, now?.updated_at ?? null);
        }
      } else {
        await tx.transactions.update({
          where: { id: txnId },
          data: { ...(fill as Prisma.transactionsUpdateInput), version: { increment: 1 }, updated_at: new Date() },
        });
      }

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
    /*
     * TD-074, the announcing half: the save that causes the automatic status change is the one
     * that says so. applyExpiry is the SAME rule the list uses - called, not re-spelled - and it
     * no-ops for anything that is not a listing with an expiry date. If it moved the status, the
     * response says which way and why, and the returned deal already carries the new status.
     */
    const statusRows = () => ((full as unknown as { transaction_statuses?: { status: string }[] }).transaction_statuses ?? []).map((x) => x.status).join(', ');
    const statusesBefore = statusRows();
    await this.txns.applyExpiry(full as never);
    const statusesAfter = statusRows();
    let statusNotice: string | undefined;
    if (statusesBefore !== statusesAfter) {
      const xd = (full as unknown as { listing_expiry_date?: Date | null }).listing_expiry_date;
      const d = xd ? xd.toISOString().slice(0, 10) : '';
      statusNotice = statusesAfter === 'Expired'
        ? `The status was changed to Expired because the listing expiry date (${d}) has passed. Correcting the date restores it.`
        : `The status was returned to Active because the listing expiry date (${d}) has not been reached.`;
    }
    return { data: await transactionResource(full, ctx), ...(statusNotice ? { message: statusNotice } : {}) };
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
    /*
     * TD-065 — A ROW WITH NO NAME IS NOT A CONDITION.
     *
     * The Conditional Offer editor keeps a spare row for the next entry, and the whole list went to
     * the API on save. So one condition entered arrived as two: the real one, and
     * `{type: '', deadline: null, status: 'Pending'}`. The blank one stored, and the document
     * auto-creation then produced a checklist row titled literally "Condition: " — an outstanding
     * document nobody could ever satisfy, counted on the dashboard and printed on a RECO file.
     *
     * A condition is identified by its type or its custom name; with neither, there is nothing to
     * store, nothing to chase and nothing to title. Such rows are dropped here rather than in the
     * browser, because the browser is not the only caller — an import or an integration sending the
     * same shape would have reproduced this exactly.
     *
     * DROPPED, NOT REFUSED, and that includes a stored row whose name has been cleared: the row
     * then falls out of `keep` and is deleted with everything else that is gone. Nothing is lost
     * silently — `syncConditionDocs` soft-deletes a document that carries an upload (TD-120), so a
     * condition with a file reaches the Recycle Bin rather than disappearing.
     *
     * `type` absent ENTIRELY still defaults to 'Financing' below, which is the long-standing
     * behaviour for a caller that names a condition without classifying it. What is refused is a
     * row that names nothing at all.
     */
    const named = (c: Record<string, unknown>): boolean =>
      String(c.type ?? '').trim() !== '' || String(c.custom_name ?? '').trim() !== '';
    const conditionRows = conditions.filter(named);

    const existing = await tx.conditions.findMany({ where: { transaction_id: txnId } });
    const known = new Set(existing.map((r) => r.id));
    const now = new Date();
    const keep = new Set<number>();
    let i = 0;
    for (const c of conditionRows) {
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
      /*
       * TD-111 — the external referral is filed when its CONTENT goes, not when its TOGGLE does.
       *
       * Both readings agree on the case this was written for (toggle Yes with a referral in it,
       * switched off) because the referral is now cleared with the toggle. Asking about content
       * covers the two the toggle reading missed: a referral left dormant behind a No toggle by a
       * save that predates this fix is filed the first time it is cleared, and a referral somebody
       * blanks field-by-field with the section still on is filed too, where before it was simply
       * gone — `isEmpty` counts an object of empty strings as content, so nothing was captured.
       */
      if (sectionHasContent(oldA.ext) && !sectionHasContent(newA.ext)) {
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
