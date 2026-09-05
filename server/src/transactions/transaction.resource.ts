import { Prisma, type transactions } from '@prisma/client';
import { jsonField, toDateString, toDateTimeString, toIso8601String } from '../common/serialize';
import { normalizeCommissionTxn } from './commission.loader';
import type { CommissionService } from './commission.service';

import { can, isAgent } from '../core/authz';
import { ownsTransaction, teamMemberIdentity } from '../common/transaction-scope';
import { invoiceDisplayStatus } from '../reference/invoice.constants';
const isPrecon = (type: string): boolean => type === 'Preconstruction';

// Deterministic ordering (Laravel's own order for these is index-plan-dependent
// and NOT stable across single-row vs IN-list queries, so exact tie/set order can't
// be matched — the golden test compares these order-insensitively):
//   • statuses: status ASC.
//   • audit_logs / edit_requests / delete_requests: `latest()` = created_at DESC,
//     ties by id ASC.
const STATUS_ORDER: Prisma.transaction_statusesOrderByWithRelationInput = { status: 'asc' };
const AUDIT_ORDER: Prisma.audit_logsOrderByWithRelationInput[] = [{ created_at: 'desc' }, { id: 'asc' }];
const EDITREQ_ORDER: Prisma.transaction_edit_requestsOrderByWithRelationInput[] = [{ created_at: 'desc' }, { id: 'asc' }];
const DELREQ_ORDER: Prisma.transaction_delete_requestsOrderByWithRelationInput[] = [{ created_at: 'desc' }, { id: 'asc' }];

/** Relations eager-loaded by the list endpoint. */
export const txnIndexInclude = {
  transaction_statuses: { orderBy: STATUS_ORDER },
  transaction_delete_requests: { orderBy: DELREQ_ORDER },
  clients: { orderBy: { position: 'asc' } },
  brokerages: { include: { brokerage_agents: { orderBy: { position: 'asc' } } } },
} satisfies Prisma.transactionsInclude;

/** Relations eager-loaded by the detail (show) endpoint. */
export const txnShowInclude = {
  transaction_statuses: { orderBy: STATUS_ORDER },
  clients: { orderBy: { position: 'asc' } },
  conditions: { orderBy: { position: 'asc' } },
  inter_board_listings: { orderBy: { position: 'asc' } },
  brokerages: { include: { brokerage_agents: { orderBy: { position: 'asc' } } } },
  team_members: { include: { team_member_terms: { orderBy: { term_no: 'asc' } } }, orderBy: { position: 'asc' } },
  precon_terms: { orderBy: { term_no: 'asc' } },
  audit_logs: { orderBy: AUDIT_ORDER },
  invoices: { orderBy: { id: 'asc' } },
  transaction_edit_requests: { orderBy: EDITREQ_ORDER },
  transaction_delete_requests: { orderBy: DELREQ_ORDER },
} satisfies Prisma.transactionsInclude;

/**
 * The detail include for one caller — the same relations, minus what they will not be sent.
 *
 * `audit_logs` is the whole reason this exists. It is the only unbounded collection in the detail
 * payload: a deal accumulates a row per changed field for ever, and the include has no `take`, so
 * opening a long-running transaction reads its entire history. An AGENT is then handed none of it —
 * `transactionResource` withholds the audit rows and `agent_changes` from them — so every one of
 * those rows was read from disk, serialised by Prisma and thrown away.
 *
 * Dropping it for agents changes no response: the field is already absent from what they receive.
 * The office keeps it, because `AuditTrailModal` renders it from this payload; moving that to its
 * own paged endpoint would be the real fix and is a change to how the screen works, not to how fast
 * it is, so it is left alone and recorded as an open item.
 */
export function txnShowIncludeFor(user: { role?: string | null; id?: number; name?: string | null } | null | undefined): Prisma.transactionsInclude {
  if (!isAgent(user)) return txnShowInclude;
  /*
   * TD-110 — AN AGENT SEES THEIR OWN CHANGES, AND STILL NOT THE OFFICE'S.
   *
   * The whole `audit_logs` relation was dropped for agents, correctly: it carries every field the
   * office has ever touched — commission percentages, splits, trust payable, approval decisions and
   * the reasons given — and an agent has no audit screen. But it also carries the rows the AGENT
   * wrote, so the person most likely to be asked to account for a change was the one person who
   * could not see it. On a RECO-regulated file that is the wrong way round.
   *
   * So the relation comes back for them, narrowed to their OWN rows. Identity by `user_id` where
   * the row carries one, falling back to the name for rows written before that column existed —
   * the same rule `common/transaction-scope.ts` uses to decide whose deal is whose.
   *
   * It stays bounded: only this caller's rows, and only on the detail read. The office's rows are
   * never loaded for them, so the reason the relation was dropped — reading an unbounded history
   * off disk to throw it away — does not come back with it.
   */
  const id = typeof user?.id === 'number' ? user.id : null;
  const name = (user?.name ?? '').trim();
  const mine: Prisma.audit_logsWhereInput[] = [];
  if (id !== null) mine.push({ user_id: id });
  if (name !== '') mine.push({ user_id: null, who: name });

  return {
    ...txnShowInclude,
    audit_logs: mine.length
      ? { where: { OR: mine }, orderBy: AUDIT_ORDER, take: 200 }
      // No identity to match on: send nothing rather than everything.
      : { where: { id: -1 }, orderBy: AUDIT_ORDER },
  };
}

type FullTxn = Prisma.transactionsGetPayload<{ include: typeof txnShowInclude }>;
/** A transaction with any subset of the resource relations loaded. */
export type LoadedTxn = transactions & Partial<Omit<FullTxn, keyof transactions>>;

export interface ResourceUser {
  id: number;
  role: string;
  name: string;
}

/**
 * Per-row lookups hoisted out of the row loop and answered once for the whole set.
 *
 * Serialising a transaction needs three things that are not on the row: the caller's unread
 * message count, the caller's team access, and the agent profile that sets the default
 * commission split. Fetched per row those are three round trips each, so a list of N costs 3N
 * sequential queries — fine at 7 transactions, minutes at several hundred.
 *
 * A caller that is serialising many rows loads all three up front and passes them here. When
 * absent (the detail endpoint, which serialises exactly one row) every lookup falls back to the
 * query it always did, so the output is identical either way. This mirrors the `profileCache`
 * the reports module already threads into CommissionService.breakdown().
 */
export interface ResourceBulk {
  /** transaction id → unread count for the current user. Absent id means zero. */
  unread: Map<number, number>;
  /** transaction id → the current agent's team access. Absent id means no membership. */
  teamAccess: Map<number, string>;
  /** agent name → parsed profile, for commission defaults. */
  profiles: Map<string, Record<string, unknown>>;
}

export interface ResourceCtx {
  user: ResourceUser | null;
  commission: CommissionService;
  prisma: Prisma.TransactionClient | import('@prisma/client').PrismaClient;
  /** Set by list endpoints; omitted when serialising a single row. */
  bulk?: ResourceBulk;
}

const num = (d: Prisma.Decimal | number | null): number => (d === null ? 0 : Number(d));
const numN = (d: Prisma.Decimal | number | null): number | null => (d === null ? null : Number(d));

/**
 * Laravel InvoiceStatusService::sentStatus — derived, never stored.
 *
 * TD-048 — this answers "has the invoice gone out yet", NOT "what does the invoice say". Its
 * `Draft` means raised but not sent; the panel that showed it was labelled "Invoice Status", so an
 * issued, overdue invoice was described as a draft on one screen and as Overdue on another. The
 * value is right and the label was wrong: it travels as `invoice_sent_status` beside
 * `invoice_status`, which is the same word the invoice list and the API show.
 */
function sentStatus(inv: { status?: string; sent_at?: Date | null } | null): string {
  if (!inv) return 'Pending to Raise';
  if (inv.status === 'Paid') return 'Paid';
  if (inv.status === 'Void') return 'Void';
  if (inv.sent_at) return 'Sent';
  return 'Draft';
}

function statusList(t: LoadedTxn): string[] {
  const list = (t.transaction_statuses ?? []).map((s) => s.status);
  return list.length ? list : ['Open'];
}

/**
 * Identity is the user id wherever the row carries one; the name decides only rows that never
 * resolved to an account. Same rule as `common/transaction-scope.ts` — restated here for the
 * in-memory case because the team rows are already loaded and re-querying them would be a third
 * round trip per transaction.
 */
export const isMyMemberRow = (m: { user_id: number | null; name: string }, user: ResourceUser): boolean =>
  m.user_id !== null ? m.user_id === user.id : m.name === user.name;

/*
 * TD-054 - "docs only" means documents, not money.
 *
 * The access level was recorded and enforced on WRITES (a PUT returns 403) and never applied to
 * what is read back, so a docs-only member was served the other agent's split and commission, the
 * brokerage share, the deal totals and the full team matrix - and could export all of it.
 *
 * THE RATES GO WITH THE TOTALS. Removing the commission objects while leaving comm_value and the
 * listing/co-op percentages beside the price would leave the totals a multiplication away, which
 * is not withholding anything.
 */
const DOCS_ONLY_HIDDEN = [
  'comm_type', 'comm_value', 'comm_pct', 'comm_amt',
  'comm_adjust_enabled', 'comm_adjust_before', 'comm_adjust_after',
  'listing_comm_pct', 'coop_comm_pct', 'listing_comm_flat', 'coop_comm_flat', 'trust_payable',
  'listing_adj_enabled', 'listing_adj_before', 'listing_adj_after',
  'coop_adj_enabled', 'coop_adj_before', 'coop_adj_after',
  'precon_comm_pct', 'precon_comm_amt_manual', 'precon_net_of_hst',
  'commission', 'financial',
];

async function myTeamAccess(t: LoadedTxn, ctx: ResourceCtx): Promise<string | null> {
  const user = ctx.user;
  if (!user || !isAgent(user)) return null;
  if (ownsTransaction(user, t)) return 'full';
  let member: { access: string } | null | undefined;
  if (t.team_members !== undefined) {
    member = t.team_members.find((m) => isMyMemberRow(m, user)) ?? null;
  } else if (ctx.bulk) {
    return ctx.bulk.teamAccess.get(t.id) ?? null;
  } else {
    member = await ctx.prisma.team_members.findFirst({
      where: { transaction_id: t.id, ...teamMemberIdentity(user) },
    });
  }
  return member?.access ?? null;
}

async function unreadMessages(t: LoadedTxn, ctx: ResourceCtx): Promise<number> {
  const user = ctx.user;
  if (!user) return 0;
  if (ctx.bulk) return ctx.bulk.unread.get(t.id) ?? 0;
  const read = await ctx.prisma.transaction_message_reads.findFirst({
    where: { transaction_id: t.id, user_id: user.id },
    select: { last_read_at: true },
  });
  const where: Prisma.transaction_messagesWhereInput = { transaction_id: t.id, user_id: { not: user.id } };
  if (read?.last_read_at) where.created_at = { gt: read.last_read_at };
  return ctx.prisma.transaction_messages.count({ where });
}

function invoiceAdmin(t: LoadedTxn): Record<string, unknown> {
  const invoices = t.invoices ?? [];
  const block = (inv: (typeof invoices)[number] | null): Record<string, unknown> => ({
    invoice_number: inv?.invoice_no ?? null,
    // TD-048 — what the invoice says, derived exactly once (`reference/invoice.constants`), so this
    // panel and the invoice list cannot describe the same invoice with two different words.
    invoice_status: inv ? invoiceDisplayStatus(inv) : null,
    invoice_sent_status: sentStatus(inv),
    commission_received_date: toDateString(inv?.commission_received_date ?? null),
    commission_received_via: inv?.commission_received_via ?? null,
  });

  if (isPrecon(t.type)) {
    const byTerm: Record<string, unknown> = {};
    for (const inv of invoices) {
      if (inv.term_no) byTerm[inv.term_no] = block(inv);
    }
    return { by_term: byTerm };
  }
  return block(invoices[0] ?? null);
}

/** Build the TransactionResource JSON — a faithful port of TransactionResource::toArray. */
export async function transactionResource(t: LoadedTxn, ctx: ResourceCtx): Promise<Record<string, unknown>> {
  const commissionInput = normalizeCommissionTxn(t);
  const commission = ctx.commission.summarize(commissionInput);

  const out: Record<string, unknown> = {
    id: t.id,
    trade_no: t.trade_no,
    type: t.type,
    property: t.property,
    agent: t.agent,
    price: num(t.price),
    deposit: num(t.deposit),
    offer_date: toDateString(t.offer_date),
    closing_date: toDateString(t.closing_date),
    listing_contract_date: toDateString(t.listing_contract_date),
    listing_expiry_date: toDateString(t.listing_expiry_date),

    mls_type: t.mls_type,
    mls_num: t.mls_num,
    mls_verified: t.mls_verified,

    comm_type: t.comm_type,
    comm_value: num(t.comm_value),
    comm_pct: numN(t.comm_pct),
    comm_amt: numN(t.comm_amt),
    comm_adjust_enabled: t.comm_adjust_enabled,
    comm_adjust_before: num(t.comm_adjust_before),
    comm_adjust_after: num(t.comm_adjust_after),
    listing_comm_pct: numN(t.listing_comm_pct),
    coop_comm_pct: numN(t.coop_comm_pct),
    listing_comm_flat: numN(t.listing_comm_flat),
    coop_comm_flat: numN(t.coop_comm_flat),
    trust_payable: numN(t.trust_payable),
    listing_adj_enabled: t.listing_adj_enabled,
    listing_adj_before: num(t.listing_adj_before),
    listing_adj_after: num(t.listing_adj_after),
    coop_adj_enabled: t.coop_adj_enabled,
    coop_adj_before: num(t.coop_adj_before),
    coop_adj_after: num(t.coop_adj_after),
    comm_status: t.comm_status,
    comm_paid_status: t.comm_paid_status,
    valid_status: t.valid_status,

    conditional_offer: t.conditional_offer,
    inter_board_enabled: t.inter_board_enabled,

    lawyer_name: t.lawyer_name,
    lawyer_email: t.lawyer_email,
    lawyer_phone: t.lawyer_phone,
    lawyer_address: t.lawyer_address,
    buyer_lawyer_name: t.buyer_lawyer_name,
    buyer_lawyer_email: t.buyer_lawyer_email,
    buyer_lawyer_phone: t.buyer_lawyer_phone,
    buyer_lawyer_address: t.buyer_lawyer_address,
    seller_lawyer_name: t.seller_lawyer_name,
    seller_lawyer_email: t.seller_lawyer_email,
    seller_lawyer_phone: t.seller_lawyer_phone,
    seller_lawyer_address: t.seller_lawyer_address,

    admin_activities: jsonField(t.admin_activities),
    activity_tracker: jsonField(t.activity_tracker),
    adjustments: jsonField(t.adjustments),
    commercial_lease: jsonField(t.commercial_lease),
    notice_of_sale: jsonField(t.notice_of_sale),
    trade_sheet_sent_at: toIso8601String(t.trade_sheet_sent_at),
    // TD-088 — when the sheet was last PRODUCED, which is a different question from whether it
    // was emailed to anybody.
    trade_sheet_generated_at: toIso8601String(t.trade_sheet_generated_at),
    trade_sheet_data: jsonField(t.trade_sheet_data),

    precon_listing_type: t.precon_listing_type,
    precon_term_count: t.precon_term_count !== null ? Number(t.precon_term_count) : null,
    commission_agent: t.commission_agent,
    precon_net_of_hst: t.precon_net_of_hst,
    precon_comm_pct: numN(t.precon_comm_pct),
    precon_comm_amt_manual: numN(t.precon_comm_amt_manual),
    precon_details_of_terms: t.precon_details_of_terms,
    builder: {
      name: t.builder_name,
      vendor: t.builder_vendor,
      project: t.builder_project,
      address: t.builder_address,
      office_email: t.builder_office_email,
      invoice_email: t.builder_invoice_email,
      phone: t.builder_phone,
    },
  };

  // precon_terms (whenLoaded)
  if (t.precon_terms !== undefined) {
    out.precon_terms = t.precon_terms.map((p) => ({
      term_no: p.term_no,
      pct: numN(p.pct),
      closing_date: toDateString(p.closing_date),
    }));
  }

  out.statuses = statusList(t);
  out.commission = commission;

  // team (whenLoaded teamMembers)
  if (t.team_members !== undefined) {
    out.team = t.team_members.map((m) => ({
      id: m.id,
      name: m.name,
      split: num(m.split),
      agent_pct: num(m.agent_pct),
      brok_pct: num(m.brok_pct),
      is_primary: m.is_primary,
      access: m.access,
      scope: m.scope,
      terms: m.team_member_terms.map((x) => x.term_no),
    }));
  }

  out.my_team_access = await myTeamAccess(t, ctx);

  // financial (when teamMembers loaded)
  if (t.team_members !== undefined) {
    // The profile cache, when supplied, spares breakdown() a users lookup per agent name.
    out.financial = await ctx.commission.breakdown(commissionInput, ctx.bulk?.profiles);
  }

  // TD-054. Applied after `financial` is built, so it strips the result rather than trying to
  // predict it. The team keeps its names, roles and access levels - who worked the deal is not
  // the secret; what they earned is.
  if (out.my_team_access === 'docs') {
    for (const k of DOCS_ONLY_HIDDEN) delete (out as Record<string, unknown>)[k];
    if (Array.isArray(out.team)) {
      out.team = (out.team as Record<string, unknown>[]).map((m) => ({
        id: m.id, name: m.name, is_primary: m.is_primary, access: m.access, scope: m.scope, terms: m.terms,
      }));
    }
  }

  // clients (whenLoaded)
  if (t.clients !== undefined) {
    out.clients = t.clients.map((c) => ({ id: c.id, name: c.name, email: c.email, phone: c.phone }));
  }

  // conditions (whenLoaded)
  if (t.conditions !== undefined) {
    out.conditions = t.conditions.map((c) => ({
      id: c.id,
      type: c.type,
      custom_name: c.custom_name,
      deadline: toDateString(c.deadline),
      status: c.status,
    }));
  }

  // inter_board_listings (whenLoaded)
  if (t.inter_board_listings !== undefined) {
    out.inter_board_listings = t.inter_board_listings.map((i) => ({
      id: i.id,
      name: i.name,
      board_id: i.board_id,
      verified: i.verified,
    }));
  }

  // brokerage (whenLoaded)
  if (t.brokerages !== undefined) {
    const b = t.brokerages;
    out.brokerage = b
      ? {
          name: b.name,
          address: b.address,
          email: b.email,
          invoice_email: b.invoice_email,
          agent_email: b.agent_email,
          phone: b.phone,
          agents: b.brokerage_agents.map((a) => a.name),
        }
      : null;
  }

  /*
   * invoices + invoice_admin (whenLoaded invoices) — ONLY for a caller who may open the Invoice
   * module.
   *
   * These two blocks are Invoice-module data travelling on a Transaction response: invoice numbers,
   * totals, sent state, and the commission-received date and method. An agent holds
   * `invoice: 'none'` and is refused every invoice endpoint, yet every deal they opened carried
   * this. Withholding it at the module and serving it here is not a restriction, it is a detour.
   *
   * Gated on the same `invoices.access` capability the Invoice API enforces — one rule, so the two
   * cannot drift. Absent rather than blanked, so a client can tell "not yours" from "none yet";
   * `AgentFaqModal` already falls back to the `admin_activities` values for the two fields it shows.
   */
  if (t.invoices !== undefined && can(ctx.user, 'invoices.access')) {
    out.invoices = t.invoices.map((inv) => ({
      id: inv.id,
      invoice_no: inv.invoice_no,
      status: inv.status,
      total: num(inv.total),
      sent_at: toIso8601String(inv.sent_at),
    }));
    out.invoice_admin = invoiceAdmin(t);
  }

  /*
   * audit_logs + agent_changes (whenLoaded auditLogs) — WITHHELD FROM AGENTS.
   *
   * The Transaction Desk Audit Trail is an administrator's screen: `audit: 'none'` for agents,
   * `/api/audit-logs` refuses them, and the per-deal Audit Trail button is hidden from them on
   * `TransactionDetailPage`. The rows travelled on the transaction payload anyway — every field the
   * office has ever changed, with its old and new value: commission percentages and amounts, agent
   * and brokerage splits, trust payable, adjustments, approval decisions, who overrode what and the
   * reason they gave. Hiding the button and sending the data is not a restriction.
   *
   * `agent_changes` goes with it. It is the office's review QUEUE — what an administrator has been
   * asked to approve or reject, including other people's pending edits on a team deal — and the
   * banner that renders it is `isAdminOrAbove` already. What an agent legitimately needs is the
   * DECISION, and that arrives through `transaction_reviews` on its own endpoint, which is
   * ownership-scoped and which they still read in full.
   *
   * Absent rather than emptied: an empty array would read as "nothing has ever happened on this
   * deal", which is a different and worse untruth than the field not being there.
   */
  /*
   * TD-110 — the agent's own history, on their own deal.
   *
   * `agent_changes` above is the OFFICE's review queue: unhandled agent edits awaiting a decision,
   * including other people's on a team deal, rendered by an `isAdminOrAbove` banner. Handing that
   * array to agents would be the wrong fix — it is not their history and it carries their
   * colleagues' pending edits.
   *
   * `my_changes` is what they were missing: the rows THEY wrote on THIS deal, handled ones
   * included, so a change that was reverted (TD-038) is visible to the person who made it. The
   * include has already narrowed the relation to their own rows, so nothing else is in reach.
   */
  if (t.audit_logs !== undefined && isAgent(ctx.user)) {
    out.my_changes = t.audit_logs.map((a) => ({
      id: a.id,
      section: a.section,
      field: a.field,
      action: a.action,
      old_value: a.old_value,
      new_value: a.new_value,
      handled: a.handled,
      stamp: toDateTimeString(a.created_at),
    }));
  }

  if (t.audit_logs !== undefined && !isAgent(ctx.user)) {
    const logs = t.audit_logs;
    out.audit_logs = logs.map((a) => ({
      id: a.id,
      who: a.who,
      section: a.section,
      field: a.field,
      old_value: a.old_value,
      new_value: a.new_value,
      action: a.action,
      source: a.source,
      details: a.details,
      stamp: toDateTimeString(a.created_at),
    }));
    /*
     * What an administrator is asked to REVIEW — which is not the same as what they are told about.
     *
     * Three kinds of agent activity are deliberately absent: team splits, lawyer details, and
     * anything the agent did to a document. Uploading a file is not a change to be approved or
     * rejected; it is work arriving, and the office is told about it through the notification bell
     * instead. Rejecting one was never possible in any case — `revertAgentChange` can only put back
     * a Status or a Contact, so a document row offered a Reject button that always answered "this
     * change can't be auto-reverted".
     *
     * Nothing is hidden by this: every upload is still written to the audit trail and still listed
     * under Legal & Documents.
     */
    out.agent_changes = logs
      .filter(
        (a) =>
          a.source === 'Agent' &&
          !a.handled &&
          !(a.field ?? '').toLowerCase().includes('team member') &&
          !(a.field ?? '').toLowerCase().includes('lawyer') &&
          !(a.action ?? '').toLowerCase().startsWith('document'),
      )
      .map((a) => ({
        id: a.id,
        who: a.who,
        section: a.section,
        field: a.field,
        action: a.action,
        old_value: a.old_value,
        new_value: a.new_value,
        stamp: toDateTimeString(a.created_at),
      }));
  }

  // delete_request (whenLoaded deleteRequests)
  if (t.transaction_delete_requests !== undefined) {
    const r = t.transaction_delete_requests.find((x) => x.status === 'pending' || x.status === 'forwarded');
    out.delete_request = r
      ? {
          id: r.id,
          status: r.status,
          reason: r.reason,
          requested_by_name: r.requested_by_name,
          forwarded_by_name: r.forwarded_by_name,
          forward_reason: r.forward_reason,
          stamp: toDateTimeString(r.created_at),
        }
      : null;
  }

  out.unread_messages = await unreadMessages(t, ctx);

  out.edit_locked = statusList(t).some((s) => s === 'DFT' || s === 'Closed');

  // edit_requests (whenLoaded)
  if (t.transaction_edit_requests !== undefined) {
    out.edit_requests = t.transaction_edit_requests.map((r) => ({
      id: r.id,
      status: r.status,
      scope: r.scope,
      status_at_request: r.status_at_request,
      requested_by_name: r.requested_by_name,
      reason: r.reason,
      reviewed_by_name: r.reviewed_by_name,
      reviewed_at: toDateTimeString(r.reviewed_at),
      stamp: toDateTimeString(r.created_at),
    }));
  }

  out.created_at = toDateTimeString(t.created_at);
  // TD-003 — the token the editor holds and sends back on save, so a write made against a snapshot
  // somebody else has already replaced is refused rather than applied. Emitted on every read of a
  // transaction, because every one of them is a form somebody may go on to save.
  out.version = t.version;

  return out;
}
