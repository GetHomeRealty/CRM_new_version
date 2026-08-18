import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CommissionService } from './commission.service';
import { TransactionReviewService } from './transaction-review.service';
import { isListingType } from '../reference/transaction.constants';
import { parseJsonObject } from '../common/serialize';
import { filterClauses } from './transaction-filters';
import type { ListTransactionsDto } from './dto/list-transactions.dto';
import { isAgent } from '../core/authz';
import { ownsTransaction, teamMemberIdentity, transactionScopeWhere } from '../common/transaction-scope';
import {
  transactionResource,
  txnIndexInclude,
  txnShowIncludeFor,
  type LoadedTxn,
  type ResourceBulk,
  type ResourceUser,
} from './transaction.resource';

/** The list response. `meta` is present only when the caller asked for a page. */
export interface TransactionListResult {
  data: Record<string, unknown>[];
  meta?: {
    current_page: number;
    per_page: number;
    last_page: number;
    total: number;
    /** Closing-date years available to this user, newest first. */
    years: string[];
    /** Open deletion requests across all pages, for the reviewer banner. */
    pending_deletions: Record<string, unknown>[];
    /** Review counters for the rows on this page, keyed by transaction id. */
    review_counts: Record<number, { open: number; corrected: number; resolved: number }>;
  };
}

const isListingStatusFamily = (type: string): boolean => isListingType(type) || type === 'Business Sale';
const TERMINAL = ['Closed', 'Sold', 'Leased', 'Void', 'Terminated', 'Mutual Release', 'DFT', 'Expired'];

@Injectable()
export class TransactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commission: CommissionService,
    private readonly reviews: TransactionReviewService,
  ) {}

  /**
   * Transactions list (newest first). Agents only see their own + team-split deals.
   *
   * Filtering and paging are opt-in. With no query the answer is the entire list under a bare
   * `data` key, exactly as before — the Dashboard, Analytics, Commission and calendar screens all
   * aggregate over the full set, so the default had to stay total. Pass `page` and the same
   * response gains a `meta` block and returns one page.
   */
  async index(user: ResourceUser | null, query: ListTransactionsDto = {}): Promise<TransactionListResult> {
    const where: Prisma.transactionsWhereInput = { deleted_at: null };
    const and: Prisma.transactionsWhereInput[] = [];
    // Kept as its own AND term rather than `where.OR`, so a filter that needs an OR of its own
    // (status, payout) cannot overwrite the visibility rule and widen what an agent can see.
    // The rule itself comes from `transactionScopeWhere` — one definition, used by every screen
    // that asks — and is empty for anyone who is not an agent.
    const visible = transactionScopeWhere(user);
    if (Object.keys(visible).length) and.push(visible);
    and.push(...filterClauses(query));
    if (and.length) where.AND = and;

    const paged = query.page !== undefined;
    const perPage = Math.min(200, Math.max(1, query.per_page ?? 25));

    // The count and the page are independent, and the extra lists only matter when paging.
    const [total, txns] = await Promise.all([
      paged ? this.prisma.transactions.count({ where }) : Promise.resolve(0),
      this.prisma.transactions.findMany({
        where,
        orderBy: { created_at: 'desc' },
        include: txnIndexInclude,
        ...(paged ? { skip: (Math.max(1, query.page ?? 1) - 1) * perPage, take: perPage } : {}),
      }),
    ]);

    const rows = txns as LoadedTxn[];
    // Expiry can rewrite a row's statuses, so it has to settle before anything is serialised.
    // It is a no-op unless a listing is past its expiry date and not already in a terminal
    // status, and the status it writes ('Expired') is itself terminal — so it fires at most
    // once per listing, not on every load.
    for (const t of rows) await this.applyExpiry(t);

    // Everything the serialiser would otherwise fetch per row, fetched once for the whole set.
    const ctx = { user, commission: this.commission, prisma: this.prisma, bulk: await this.bulkFor(rows, user) };
    const data = await Promise.all(rows.map((t) => transactionResource(t, ctx)));
    if (!paged) return { data };

    // Two things on that screen are about the whole result set, not the visible page: the year
    // dropdown and the deletion-requests banner. Paging the rows without supplying these would
    // quietly shrink both to whatever page you were on.
    const scope: Prisma.transactionsWhereInput = { AND: [{ deleted_at: null }, ...(and.length ? and : [])] };
    const [years, pending, reviewCounts] = await Promise.all([
      this.matchingYears(scope, user),
      this.pendingDeletions(user),
      // One grouped query for the rows on this page. A counter fetched per row is how a list screen
      // quietly becomes N+1 queries.
      this.reviews.countsFor(rows.map((r) => r.id)),
    ]);

    return {
      data,
      meta: {
        current_page: Math.max(1, query.page ?? 1),
        per_page: perPage,
        last_page: Math.max(1, Math.ceil(total / perPage)),
        total,
        years,
        pending_deletions: pending,
        // Keyed by transaction id; a deal with no review history is simply absent.
        review_counts: reviewCounts,
      },
    };
  }

  /**
   * Every id matching the current filters, in list order — "Select all N matching".
   *
   * ITS OWN REQUEST, because it is the only part of the list response whose size is the size of the
   * brokerage. It used to travel in `meta.ids` on every page load: measured at 80,000 deals that is
   * an unbounded id scan plus roughly half a megabyte of JSON attached to a request that shows
   * twenty-five rows, paid for by every list load, every filter change and every page turn — to
   * serve one button that is pressed rarely and that the other ninety-nine per cent of loads never
   * touch.
   *
   * Nothing about the button changes: it still selects every matching deal across every page, from
   * the same `where` in the same order. The ids are simply fetched when it is pressed.
   */
  async matchingIds(user: ResourceUser | null, query: ListTransactionsDto = {}): Promise<{ ids: number[] }> {
    const where: Prisma.transactionsWhereInput = { deleted_at: null };
    const and: Prisma.transactionsWhereInput[] = [];
    const visible = transactionScopeWhere(user);
    if (Object.keys(visible).length) and.push(visible);
    and.push(...filterClauses(query));
    if (and.length) where.AND = and;

    const rows = await this.prisma.transactions.findMany({
      where,
      orderBy: { created_at: 'desc' },
      select: { id: true },
    });
    return { ids: rows.map((r) => r.id) };
  }

  /**
   * Closing-date years present in what this user can see, newest first.
   *
   * Deliberately ignores the filters and reflects only visibility, so the dropdown does not
   * delete its own options: picking 2025 must not leave 2025 as the only year on offer.
   */
  private async matchingYears(_scope: Prisma.transactionsWhereInput, user: ResourceUser | null): Promise<string[]> {
    const where: Prisma.transactionsWhereInput = {
      AND: [{ deleted_at: null, closing_date: { not: null } }, transactionScopeWhere(user)],
    };
    const rows = await this.prisma.transactions.findMany({ where, select: { closing_date: true }, distinct: ['closing_date'] });
    const years = new Set<string>();
    // Same rule the screen used client-side: the year of the ISO date string.
    for (const r of rows) if (r.closing_date) years.add(r.closing_date.toISOString().slice(0, 10).slice(0, 4));
    return [...years].sort((a, b) => b.localeCompare(a));
  }

  /**
   * Open deletion requests across every page, for the reviewer banner. Admin-facing only, and
   * scoped the same way the list is, so an agent never sees another agent's request.
   */
  private async pendingDeletions(user: ResourceUser | null): Promise<Record<string, unknown>[]> {
    /*
     * START FROM THE REQUESTS, NOT FROM THE DEALS.
     *
     * This asked the transactions table for rows having a related request, which is a predicate on
     * the big table driven by the small one — at 80,000 deals the planner reads transactions and
     * probes for each. Open deletion requests number in the tens at most, so collecting their ids
     * first turns the banner into an id lookup. The scope term is unchanged and still applied, so an
     * agent still never sees another agent's request.
     */
    const open = await this.prisma.transaction_delete_requests.findMany({
      where: { status: { in: ['pending', 'forwarded'] } },
      select: { transaction_id: true },
      distinct: ['transaction_id'],
    });
    if (open.length === 0) return [];

    const where: Prisma.transactionsWhereInput = {
      AND: [
        { deleted_at: null, id: { in: open.map((r) => r.transaction_id) } },
        transactionScopeWhere(user),
      ],
    };
    const rows = await this.prisma.transactions.findMany({
      where,
      orderBy: { created_at: 'desc' },
      select: {
        id: true, trade_no: true, property: true,
        transaction_delete_requests: {
          where: { status: { in: ['pending', 'forwarded'] } },
          orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
          take: 1,
          select: { id: true, reason: true, status: true, requested_by_name: true },
        },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      trade_no: r.trade_no,
      property: r.property,
      delete_request: r.transaction_delete_requests[0] ?? null,
    }));
  }

  /**
   * Resolve the three per-row lookups for a whole list in a fixed number of queries.
   *
   * Serialising a transaction needs the caller's unread count, the caller's team access, and the
   * agent profiles behind the commission split. Left to the resource these are three round trips
   * per row, run sequentially — 500 transactions meant ~1,500 serial queries, which is seconds of
   * dead time on a local database and far worse across a network. This resolves the same data in
   * at most four queries regardless of list length.
   */
  private async bulkFor(rows: LoadedTxn[], user: ResourceUser | null): Promise<ResourceBulk> {
    const empty: ResourceBulk = { unread: new Map(), teamAccess: new Map(), profiles: new Map() };
    if (!user || rows.length === 0) return empty;
    const ids = rows.map((t) => t.id);

    /*
     * The profile cache is loaded ONLY IF THE ROWS CARRY TEAM MEMBERS.
     *
     * `transactionResource` uses it in exactly one place — the `financial` breakdown, which is
     * emitted `if (t.team_members !== undefined)`. The LIST include (`txnIndexInclude`) does not
     * fetch team members, so on the list path that branch never runs and the cache was never read:
     * every list request read all 601 user rows with their profile blobs and JSON-parsed each one to
     * build a map nothing looked at.
     *
     * Kept rather than deleted because the include is a one-line change away from carrying team
     * members again, and a silently missing cache would not be a slow list — a cache MISS is treated
     * as an empty profile and does NOT fall back to a query, so it would substitute the default
     * 90/95 split for somebody's real one. This loads it exactly when it will be used.
     */
    const needsProfiles = rows.some((t) => t.team_members !== undefined);

    const [reads, memberships, users] = await Promise.all([
      this.prisma.transaction_message_reads.findMany({
        where: { transaction_id: { in: ids }, user_id: user.id },
        select: { transaction_id: true, last_read_at: true },
      }),
      // Only agents have a team access value; for everyone else the resource returns null anyway.
      // Identity comes from `teamMemberIdentity` — the id where the row has one — so the access
      // shown on the list is the caller's own row and never a namesake's.
      isAgent(user)
        ? this.prisma.team_members.findMany({
            where: { transaction_id: { in: ids }, ...teamMemberIdentity(user) },
            select: { transaction_id: true, access: true },
          })
        : Promise.resolve([]),
      needsProfiles
        ? this.prisma.users.findMany({ select: { name: true, profile: true } })
        : Promise.resolve([] as { name: string; profile: string | null }[]),
    ]);

    const teamAccess = new Map<number, string>();
    for (const m of memberships) teamAccess.set(m.transaction_id, m.access);

    const profiles = new Map<string, Record<string, unknown>>();
    for (const u of users) profiles.set(u.name, parseJsonObject(u.profile));

    // "Unread" means messages from someone else, newer than this user's last read of THAT
    // transaction — so the cutoff differs per row and a single count query cannot express it.
    // One OR term per row does: transactions never opened match on id alone, the rest carry
    // their own cutoff. Grouping then returns every count in one round trip.
    const seen = new Map<number, Date>();
    for (const r of reads) if (r.last_read_at) seen.set(r.transaction_id, r.last_read_at);

    const never = ids.filter((id) => !seen.has(id));
    const or: Prisma.transaction_messagesWhereInput[] = [];
    if (never.length) or.push({ transaction_id: { in: never } });
    for (const [id, at] of seen) or.push({ transaction_id: id, created_at: { gt: at } });

    const unread = new Map<number, number>();
    if (or.length) {
      const grouped = await this.prisma.transaction_messages.groupBy({
        by: ['transaction_id'],
        where: { user_id: { not: user.id }, OR: or },
        _count: { _all: true },
      });
      for (const g of grouped) unread.set(g.transaction_id, g._count._all);
    }

    return { unread, teamAccess, profiles };
  }

  /** Transaction detail. Agents may only access transactions they own or are split into. */
  async show(user: ResourceUser | null, id: number): Promise<{ data: Record<string, unknown> }> {
    // Route-model-binding equivalent: 404 for missing / soft-deleted.
    const base = await this.prisma.transactions.findFirst({ where: { id, deleted_at: null } });
    if (!base) {
      throw new NotFoundException({ message: `No query results for model [App\\Models\\Transaction] ${id}.` });
    }
    await this.authorizeAgentAccess(user, base);

    // Agents are not sent the audit history, so it is not read for them either — see
    // `txnShowIncludeFor`. It is the one unbounded collection in this payload.
    const t = (await this.prisma.transactions.findUnique({ where: { id }, include: txnShowIncludeFor(user) })) as unknown as LoadedTxn;
    await this.applyExpiry(t);

    const ctx = { user, commission: this.commission, prisma: this.prisma };
    return { data: await transactionResource(t, ctx) };
  }

  /** Agents may only access transactions they own or are split into (admins: no-op). */
  private async authorizeAgentAccess(
    user: ResourceUser | null,
    t: { id: number; agent: string | null; agent_user_id: number | null },
  ): Promise<void> {
    if (!user || !isAgent(user)) return;
    // Unassigned transactions (no agent) are admin-only, even if team rows exist.
    const allowed =
      ownsTransaction(user, t) ||
      (!!t.agent &&
        (await this.prisma.team_members.findFirst({
          where: { transaction_id: t.id, ...teamMemberIdentity(user) },
        })) !== null);
    if (!allowed) {
      throw new ForbiddenException({ message: 'You do not have access to this transaction.' });
    }
  }

  /**
   * Listing-side auto-status: once the listing expiry date passes, the status
   * becomes Expired automatically. Terminal states are left untouched.
   */
  private async applyExpiry(t: LoadedTxn): Promise<void> {
    if (!isListingStatusFamily(t.type) || !t.listing_expiry_date) return;
    if (!(t.listing_expiry_date < new Date())) return;
    const current = (t.transaction_statuses ?? []).map((s) => s.status);
    if (current.some((s) => TERMINAL.includes(s))) return;
    await this.prisma.transaction_statuses.deleteMany({ where: { transaction_id: t.id } });
    await this.prisma.transaction_statuses.create({ data: { transaction_id: t.id, status: 'Expired' } });
    t.transaction_statuses = await this.prisma.transaction_statuses.findMany({
      where: { transaction_id: t.id },
      orderBy: { status: 'asc' },
    });
  }
}
