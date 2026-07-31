import { ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LeadAuditService } from './lead-audit.service';
import { isSuperAdmin } from '../core/authz';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * Moving a book of leads from one person to another.
 *
 * THE PROBLEM THIS SOLVES. An agent's leads are confidential to them, which is what the brokerage
 * asked for — and it means that when an agent leaves, their book becomes invisible to everybody,
 * including the administrator, with no screen able to reassign it because the reassignment control
 * lives on a lead nobody can open any more.
 *
 * THE SHAPE OF THE ANSWER. The transfer is keyed on the OWNER, not on individual leads: "move this
 * person's book to that person". The administrator never names, opens, lists or reads a single
 * lead, so recovering a book does not become a way to read one. Nothing here returns lead content —
 * only how many moved.
 *
 * WHAT IT CANNOT DO, said plainly. An administrator could transfer a working agent's book to
 * themselves and then read it. There is no arrangement in which somebody can restore access and
 * also be unable to obtain it; the honest goal is that the only route in is impossible to use
 * QUIETLY. So every transfer is written to the audit trail with both names and a count, the losing
 * agent's list visibly empties, and there is no partial or silent form of this operation.
 */
@Injectable()
export class LeadTransferService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: LeadAuditService,
  ) {}

  /**
   * How many leads each person owns.
   *
   * Counts only — no names, no contact details, nothing about who the leads are. This is what an
   * administrator needs to know that a departing agent has a book worth moving, and it is the most
   * that can be shown without breaking the confidentiality the transfer exists to work around.
   */
  async books(actor: AuthUserRecord | null): Promise<{ user_id: number; name: string; role: string; leads: number }[]> {
    this.assertMayTransfer(actor);
    const [users, owned] = await Promise.all([
      this.prisma.users.findMany({ select: { id: true, name: true, role: true }, orderBy: { name: 'asc' } }),
      this.prisma.leads.groupBy({ by: ['owner_user_id'], where: { deleted_at: null }, _count: true }),
    ]);
    const count = new Map(owned.map((o) => [o.owner_user_id, o._count]));
    return users.map((u) => ({ user_id: u.id, name: u.name, role: u.role ?? 'agent', leads: count.get(u.id) ?? 0 }));
  }

  /** Move every lead owned by one person to another. Returns only a count. */
  async transfer(actor: AuthUserRecord | null, fromUserId: number, toUserId: number): Promise<{ moved: number; from: string; to: string }> {
    this.assertMayTransfer(actor);
    if (fromUserId === toUserId) {
      throw new UnprocessableEntityException({ message: 'Choose two different people.' });
    }

    const [from, to] = await Promise.all([
      this.prisma.users.findUnique({ where: { id: fromUserId }, select: { id: true, name: true } }),
      this.prisma.users.findUnique({ where: { id: toUserId }, select: { id: true, name: true, status: true } }),
    ]);
    if (!from) throw new NotFoundException({ message: 'That person no longer exists.' });
    if (!to) throw new NotFoundException({ message: 'That person no longer exists.' });
    if ((to.status ?? 'Active') === 'Inactive') {
      throw new UnprocessableEntityException({
        message: `${to.name}'s account is inactive, so the book would be invisible again the moment it moved.`,
      });
    }

    // The assignment moves with ownership. Leaving it pointing at the person who left would keep
    // the lead visible to an account that is on its way out, which is the opposite of the intent.
    const moved = await this.prisma.leads.updateMany({
      where: { owner_user_id: fromUserId, deleted_at: null },
      data: { owner_user_id: toUserId, updated_at: new Date() },
    });
    await this.prisma.leads.updateMany({
      where: { assigned_to: fromUserId, deleted_at: null },
      data: { assigned_to: toUserId, updated_at: new Date() },
    });

    await this.audit.record(
      actor as AuthUserRecord,
      'Lead ownership transferred',
      `${from.name} → ${to.name}`,
      `${moved.count} lead${moved.count === 1 ? '' : 's'} moved. The books of both people change from this point.`,
    );

    return { moved: moved.count, from: from.name, to: to.name };
  }

  /**
   * Only the top tier, and never quietly.
   *
   * This is the one route by which somebody can reach leads that are not theirs, so it is held to
   * the narrowest role the application has rather than to a screen permission that an administrator
   * could grant around.
   */
  private assertMayTransfer(actor: AuthUserRecord | null): void {
    if (!isSuperAdmin(actor)) {
      throw new ForbiddenException({
        message: 'Only a Super Admin can move a book of leads, and every transfer is recorded.',
      });
    }
  }
}
