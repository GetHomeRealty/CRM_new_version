import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CommissionService } from './commission.service';
import { isListingType } from '../reference/transaction.constants';
import {
  transactionResource,
  txnIndexInclude,
  txnShowInclude,
  type LoadedTxn,
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

    const ctx = { user, commission: this.commission, prisma: this.prisma };
    const data: Record<string, unknown>[] = [];
    for (const t of txns as LoadedTxn[]) {
      await this.applyExpiry(t);
      data.push(await transactionResource(t, ctx));
    }
    return { data };
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
