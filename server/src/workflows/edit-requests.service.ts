import { ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { transaction_edit_requests } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { toDateTimeString } from '../common/serialize';
import type { AuthUserRecord } from '../auth/auth.types';


import { isAdminOrAbove, isSuperAdmin } from '../core/authz';
/** §5.1 edit-approval workflow for DFT / Closed transactions. */
@Injectable()
export class EditRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async statusList(txnId: number): Promise<string[]> {
    const rows = await this.prisma.transaction_statuses.findMany({ where: { transaction_id: txnId }, select: { status: true } });
    const list = rows.map((r) => r.status);
    return list.length ? list : ['Open'];
  }

  async store(user: AuthUserRecord, txnId: number, reason: string | null, scope: string | null): Promise<Record<string, unknown>> {
    const t = await this.prisma.transactions.findFirst({ where: { id: txnId, deleted_at: null } });
    if (!t) throw new NotFoundException({ message: `No query results for model [App\\Models\\Transaction] ${txnId}.` });

    const statuses = await this.statusList(txnId);
    if (scope === 'financial') {
      if (isSuperAdmin(user)) throw new UnprocessableEntityException({ message: 'Super Admins can edit financial fields directly.' });
    } else {
      if (!isAdminOrAbove(user)) throw new ForbiddenException({ message: 'Only Admins can request edits.' });
      if (statuses.includes('Closed')) throw new ForbiddenException({ message: 'Closed transactions can only be edited by a Super Admin.' });
    }

    const dup = await this.prisma.transaction_edit_requests.findFirst({
      where: { transaction_id: txnId, scope: scope ?? null, status: 'pending' },
    });
    if (dup) throw new UnprocessableEntityException({ message: 'A request is already pending approval.' });

    const locked = statuses.filter((s) => s === 'DFT' || s === 'Closed');
    const statusAtRequest = locked.length ? locked.join(', ') : statuses[0] ?? '';
    const now = new Date();
    const req = await this.prisma.transaction_edit_requests.create({
      data: {
        transaction_id: txnId,
        status_at_request: statusAtRequest,
        scope: scope ?? null,
        requested_by: user.id,
        requested_by_name: user.name,
        reason: reason ?? null,
        status: 'pending',
        created_at: now,
        updated_at: now,
      },
    });

    await this.audit.record(txnId, { id: user.id, name: user.name }, {
      section: 'Approvals',
      field: 'Edit Request',
      action: 'Edit requested',
      source: 'Manual',
      new: req.status_at_request,
      details: reason ?? null,
    });
    return this.payload(req);
  }

  async approve(user: AuthUserRecord, reqId: number): Promise<Record<string, unknown>> {
    return this.review(user, reqId, 'approved', 'Edit approved');
  }

  async reject(user: AuthUserRecord, reqId: number): Promise<Record<string, unknown>> {
    return this.review(user, reqId, 'rejected', 'Edit rejected');
  }

  private async review(user: AuthUserRecord, reqId: number, status: string, action: string): Promise<Record<string, unknown>> {
    if (!isSuperAdmin(user)) {
      throw new ForbiddenException({ message: status === 'approved' ? 'Only a Super Admin can approve.' : 'Only a Super Admin can reject.' });
    }
    const existing = await this.prisma.transaction_edit_requests.findUnique({ where: { id: reqId } });
    if (!existing) throw new NotFoundException({ message: `No query results for model [App\\Models\\TransactionEditRequest] ${reqId}.` });

    const req = await this.prisma.transaction_edit_requests.update({
      where: { id: reqId },
      data: { status, reviewed_by: user.id, reviewed_by_name: user.name, reviewed_at: new Date(), updated_at: new Date() },
    });
    await this.audit.record(req.transaction_id, { id: user.id, name: user.name }, {
      section: 'Approvals',
      field: 'Edit Request',
      action,
      source: 'Manual',
    });
    return this.payload(req);
  }

  private payload(r: transaction_edit_requests): Record<string, unknown> {
    return {
      id: r.id,
      status: r.status,
      scope: r.scope,
      status_at_request: r.status_at_request,
      requested_by_name: r.requested_by_name,
      reason: r.reason,
      reviewed_by_name: r.reviewed_by_name,
      reviewed_at: toDateTimeString(r.reviewed_at),
      stamp: toDateTimeString(r.created_at),
    };
  }
}
