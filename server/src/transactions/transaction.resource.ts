import { Prisma, type transactions } from '@prisma/client';
import { jsonField, toDateString, toDateTimeString, toIso8601String } from '../common/serialize';
import { normalizeCommissionTxn } from './commission.loader';
import type { CommissionService } from './commission.service';

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

/** Laravel InvoiceStatusService::sentStatus — derived, never stored. */
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

async function myTeamAccess(t: LoadedTxn, ctx: ResourceCtx): Promise<string | null> {
  const user = ctx.user;
  if (!user || user.role !== 'agent') return null;
  if (t.agent === user.name) return 'full';
  let member: { access: string } | null | undefined;
  if (t.team_members !== undefined) {
    member = t.team_members.find((m) => m.name === user.name) ?? null;
  } else if (ctx.bulk) {
    return ctx.bulk.teamAccess.get(t.id) ?? null;
  } else {
    member = await ctx.prisma.team_members.findFirst({ where: { transaction_id: t.id, name: user.name } });
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

  // invoices + invoice_admin (whenLoaded invoices)
  if (t.invoices !== undefined) {
    out.invoices = t.invoices.map((inv) => ({
      id: inv.id,
      invoice_no: inv.invoice_no,
      status: inv.status,
      total: num(inv.total),
      sent_at: toIso8601String(inv.sent_at),
    }));
    out.invoice_admin = invoiceAdmin(t);
  }

  // audit_logs + agent_changes (whenLoaded auditLogs)
  if (t.audit_logs !== undefined) {
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
    out.agent_changes = logs
      .filter(
        (a) =>
          a.source === 'Agent' &&
          !a.handled &&
          !(a.field ?? '').toLowerCase().includes('team member') &&
          !(a.field ?? '').toLowerCase().includes('lawyer'),
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

  return out;
}
