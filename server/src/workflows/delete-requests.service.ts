import { ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { transaction_delete_requests } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { toDateTimeString } from '../common/serialize';
import type { AuthUserRecord } from '../auth/auth.types';

import { isAdminOrAbove, isAgent, isSuperAdmin } from '../core/authz';
const SECTION = 'Approvals';

/** Transaction deletion approval workflow: agent → admin forwards → super admin approves/rejects. */
@Injectable()
export class DeleteRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async store(user: AuthUserRecord, txnId: number, reason: string): Promise<Record<string, unknown>> {
    if (!isAgent(user)) throw new ForbiddenException({ message: 'Only agents raise deletion requests.' });
    const t = await this.prisma.transactions.findFirst({ where: { id: txnId, deleted_at: null } });
    if (!t) throw new NotFoundException({ message: `No query results for model [App\\Models\\Transaction] ${txnId}.` });
    if (t.agent !== user.name) throw new ForbiddenException({ message: 'You can only request deletion of your own transactions.' });

    const inProgress = await this.prisma.transaction_delete_requests.findFirst({
      where: { transaction_id: txnId, status: { in: ['pending', 'forwarded'] } },
    });
    if (inProgress) throw new UnprocessableEntityException({ message: 'A deletion request is already in progress for this transaction.' });

    const now = new Date();
    const req = await this.prisma.transaction_delete_requests.create({
      data: {
        transaction_id: txnId,
        requested_by: user.id,
        requested_by_name: user.name,
        reason,
        status: 'pending',
        created_at: now,
        updated_at: now,
      },
    });
    await this.audit.record(txnId, { id: user.id, name: user.name }, {
      section: SECTION, field: 'Deletion Request', action: 'Deletion requested', source: 'Manual', details: reason,
    });
    return this.payload(req);
  }

  async forward(user: AuthUserRecord, reqId: number, reason: string | null): Promise<Record<string, unknown>> {
    if (!isAdminOrAbove(user)) throw new ForbiddenException({ message: 'Administrator access required.' });
    const existing = await this.load(reqId);
    if (existing.status !== 'pending') throw new UnprocessableEntityException({ message: 'This request can no longer be forwarded.' });

    const req = await this.prisma.transaction_delete_requests.update({
      where: { id: reqId },
      data: {
        status: 'forwarded',
        forwarded_by: user.id,
        forwarded_by_name: user.name,
        forward_reason: reason ?? null,
        updated_at: new Date(),
      },
    });
    await this.audit.record(req.transaction_id, { id: user.id, name: user.name }, {
      section: SECTION, field: 'Deletion Request', action: 'Forwarded to Super Admin', source: 'Manual', details: reason ?? null,
    });
    return this.payload(req);
  }

  async approve(user: AuthUserRecord, reqId: number): Promise<{ message: string; deleted: boolean }> {
    if (!isSuperAdmin(user)) throw new ForbiddenException({ message: 'Only a Super Admin can approve deletion.' });
    const existing = await this.load(reqId);
    if (existing.status !== 'pending' && existing.status !== 'forwarded') {
      throw new UnprocessableEntityException({ message: 'This request is already resolved.' });
    }

    // Resolve the request first so a restored transaction doesn't show a stale banner.
    await this.prisma.transaction_delete_requests.update({
      where: { id: reqId },
      data: { status: 'approved', reviewed_by: user.id, reviewed_by_name: user.name, reviewed_at: new Date(), updated_at: new Date() },
    });

    const transaction = await this.prisma.transactions.findUnique({ where: { id: existing.transaction_id } });
    if (transaction) {
      await this.audit.record(transaction.id, { id: user.id, name: user.name }, {
        section: 'Basic Information',
        action: 'Record removed',
        source: 'Manual',
        details: `Trade #${transaction.trade_no} deleted (approved) — recoverable from Recycle Bin`,
      });
      await this.prisma.transactions.update({ where: { id: transaction.id }, data: { deleted_at: new Date() } });
    }
    return { message: 'Transaction deleted', deleted: true };
  }

  async reject(user: AuthUserRecord, reqId: number): Promise<Record<string, unknown>> {
    if (!isAdminOrAbove(user)) throw new ForbiddenException({ message: 'Administrator access required.' });
    const existing = await this.load(reqId);
    const req = await this.prisma.transaction_delete_requests.update({
      where: { id: reqId },
      data: { status: 'rejected', reviewed_by: user.id, reviewed_by_name: user.name, reviewed_at: new Date(), updated_at: new Date() },
    });
    const transaction = await this.prisma.transactions.findUnique({ where: { id: existing.transaction_id } });
    if (transaction) {
      await this.audit.record(transaction.id, { id: user.id, name: user.name }, {
        section: SECTION, field: 'Deletion Request', action: 'Deletion rejected', source: 'Manual',
      });
    }
    return this.payload(req);
  }

  private async load(reqId: number): Promise<transaction_delete_requests> {
    const r = await this.prisma.transaction_delete_requests.findUnique({ where: { id: reqId } });
    if (!r) throw new NotFoundException({ message: `No query results for model [App\\Models\\TransactionDeleteRequest] ${reqId}.` });
    return r;
  }

  private payload(r: transaction_delete_requests): Record<string, unknown> {
    return {
      id: r.id,
      transaction_id: r.transaction_id,
      status: r.status,
      reason: r.reason,
      requested_by_name: r.requested_by_name,
      forwarded_by_name: r.forwarded_by_name,
      forward_reason: r.forward_reason,
      reviewed_by_name: r.reviewed_by_name,
      stamp: toDateTimeString(r.created_at),
    };
  }
}
