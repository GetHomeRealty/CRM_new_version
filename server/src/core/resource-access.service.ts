import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isAgent } from './authz';

/**
 * Ownership — the authorization question the tenant filter cannot answer.
 *
 * Tenant isolation stops one brokerage reading another's records. It says nothing about one agent
 * reading a colleague's, because both rows belong to the same company and the filter is satisfied.
 * That second question has to be asked per resource, and it was being asked in some places and not
 * others: `GET /api/transactions/:id` refused an agent who had no part in the deal, while
 * `GET /api/transactions/:id/messages` handed over the whole chat thread. Found by signing in as a
 * real agent and asking, not by reading the code.
 *
 * The rule itself is unchanged and still the transaction list's rule: an agent may reach a deal
 * they are named on, or one they are split into. An unassigned deal is nobody's, and therefore
 * administrators only. Everyone above agent is unaffected.
 *
 * Kept here rather than in the transactions service so anything hanging off a transaction — chat,
 * documents, invoices, the next thing — asks the same question in the same words, instead of each
 * one deciding for itself whether to ask at all.
 */
@Injectable()
export class ResourceAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Throw unless this person may reach this transaction.
   *
   * A missing transaction is a 404 whether or not the caller could have seen it — the answer to
   * "does deal 812 exist?" must not depend on who is asking, or the error code becomes a way to
   * enumerate other people's deals.
   */
  async assertTransaction(user: { id?: number; name?: string | null; role?: string | null } | null, transactionId: number): Promise<void> {
    const txn = await this.prisma.transactions.findFirst({
      where: { id: transactionId, deleted_at: null },
      select: { id: true, agent: true },
    });
    if (!txn) {
      throw new NotFoundException({ message: `No query results for model [App\\Models\\Transaction] ${transactionId}.` });
    }
    if (!user || !isAgent(user)) return;

    const name = user.name ?? '';
    // An unassigned deal has no agent to be, so team rows on it grant nothing.
    const allowed =
      txn.agent === name ||
      (!!txn.agent && (await this.prisma.team_members.findFirst({ where: { transaction_id: txn.id, name } })) !== null);

    if (!allowed) {
      throw new ForbiddenException({ message: 'You do not have access to this transaction.' });
    }
  }
}
