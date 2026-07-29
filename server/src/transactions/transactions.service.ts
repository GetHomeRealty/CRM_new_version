import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CommissionService } from './commission.service';
import { isListingType } from '../reference/transaction.constants';
import { parseJsonObject } from '../common/serialize';
import {
  transactionResource,
  txnIndexInclude,
  txnShowInclude,
  type LoadedTxn,
  type ResourceBulk,
  type ResourceUser,
} from './transaction.resource';

const isListingStatusFamily = (type: string): boolean => isListingType(type) || type === 'Business Sale';
const TERMINAL = ['Closed', 'Sold', 'Leased', 'Void', 'Terminated', 'Mutual Release', 'DFT', 'Expired'];

@Injectable()
export class TransactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commission: CommissionService,
  ) {}

  /** Transactions list (newest first). Agents only see their own + team-split deals. */
  async index(user: ResourceUser | null): Promise<{ data: Record<string, unknown>[] }> {
    const where: Prisma.transactionsWhereInput = { deleted_at: null };
    if (user && user.role === 'agent') {
      where.OR = [
        { agent: user.name },
        {
          AND: [
            { agent: { not: null } },
            { agent: { not: '' } },
            { team_members: { some: { name: user.name } } },
          ],
        },
      ];
    }

    const txns = await this.prisma.transactions.findMany({
      where,
      orderBy: { created_at: 'desc' },
      include: txnIndexInclude,
    });

    const rows = txns as LoadedTxn[];
    // Expiry can rewrite a row's statuses, so it has to settle before anything is serialised.
    // It is a no-op unless a listing is past its expiry date and not already in a terminal
    // status, and the status it writes ('Expired') is itself terminal — so it fires at most
    // once per listing, not on every load.
    for (const t of rows) await this.applyExpiry(t);

    // Everything the serialiser would otherwise fetch per row, fetched once for the whole set.
    const ctx = { user, commission: this.commission, prisma: this.prisma, bulk: await this.bulkFor(rows, user) };
    return { data: await Promise.all(rows.map((t) => transactionResource(t, ctx))) };
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

    const [reads, memberships, users] = await Promise.all([
      this.prisma.transaction_message_reads.findMany({
        where: { transaction_id: { in: ids }, user_id: user.id },
        select: { transaction_id: true, last_read_at: true },
      }),
      // Only agents have a team access value; for everyone else the resource returns null anyway.
      user.role === 'agent'
        ? this.prisma.team_members.findMany({
            where: { transaction_id: { in: ids }, name: user.name },
            select: { transaction_id: true, access: true },
          })
        : Promise.resolve([]),
      this.prisma.users.findMany({ select: { name: true, profile: true } }),
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

    const t = (await this.prisma.transactions.findUnique({ where: { id }, include: txnShowInclude })) as LoadedTxn;
    await this.applyExpiry(t);

    const ctx = { user, commission: this.commission, prisma: this.prisma };
    return { data: await transactionResource(t, ctx) };
  }

  /** Agents may only access transactions they own or are split into (admins: no-op). */
  private async authorizeAgentAccess(user: ResourceUser | null, t: { id: number; agent: string | null }): Promise<void> {
    if (!user || user.role !== 'agent') return;
    const name = user.name;
    // Unassigned transactions (no agent) are admin-only, even if team rows exist.
    const allowed =
      t.agent === name ||
      (!!t.agent && (await this.prisma.team_members.findFirst({ where: { transaction_id: t.id, name } })) !== null);
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
