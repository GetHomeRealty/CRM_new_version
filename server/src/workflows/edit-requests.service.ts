import { ForbiddenException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { transaction_edit_requests } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { toDateTimeString } from '../common/serialize';
import type { AuthUserRecord } from '../auth/auth.types';


import { isAdminOrAbove, isSuperAdmin, superAdminRoles } from '../core/authz';
import { NotificationDispatcher } from '../notifications/notification-dispatcher.service';
/** §5.1 edit-approval workflow for DFT / Closed transactions. */
@Injectable()
export class EditRequestsService {
  private readonly log = new Logger(EditRequestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    /*
     * OPTIONAL, like every other dispatcher dependency in this codebase, and for the same reason:
     * the existing specs construct this service directly with a Prisma client and an audit
     * service. They test who may request and who may approve, not who gets told, and making this
     * required would have rewritten all of them to add a feature none of them exercise.
     *
     * Absent, the workflow behaves exactly as it did before notifications existed.
     */
    private readonly dispatcher?: NotificationDispatcher,
  ) {}

  /**
   * The people this workflow lets review a request — and therefore the only people told one has
   * arrived.
   *
   * DERIVED FROM THE SAME AUTHZ SOURCE AS THE APPROVE GUARD. `review()` below refuses anybody who
   * is not `isSuperAdmin`, and `superAdminRoles()` is that predicate's role list. Hard-coding
   * 'admin' here instead would be a second, quieter answer to "who may approve" that could drift
   * from the one actually enforced.
   *
   * Active accounts only: a deactivated reviewer cannot act on it.
   */
  private async reviewers(): Promise<number[]> {
    const rows = await this.prisma.users.findMany({
      where: { role: { in: superAdminRoles() }, status: 'Active' },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /**
   * Tell the reviewers, in the bell, that there is something waiting.
   *
   * NEVER FAILS THE REQUEST. The request is the record and the notification is the courtesy —
   * exactly the stance `transaction-review.service.ts` takes about its own sends. A dispatcher
   * that throws must not leave the requester with an error for a request that was in fact filed.
   *
   * THE DEDUPE KEY IS THE REQUEST'S OWN ID, which is what makes this safe to retry. A row is
   * created once per pending request — `store` refuses a second one for the same deal and scope
   * while one is pending — so the id identifies the submission, and a re-dispatch of the same id
   * is dropped by the ledger rather than ringing the bell twice. Re-reading a page raises nothing
   * at all: this runs on the POST that creates the row, not on any read.
   */
  private async notifyReviewers(req: transaction_edit_requests, property: string | null): Promise<void> {
    if (!this.dispatcher) return;
    try {
      const ids = await this.reviewers();
      if (!ids.length) return;
      const what = req.scope ? `${req.scope} fields` : 'this deal';
      await this.dispatcher.dispatchMany(ids, {
        category: 'approval_requested',
        title: 'Approval requested',
        // Enough to recognise WHICH request without opening it: who asked, which deal, what for.
        body: `${req.requested_by_name || 'Someone'} asked to edit ${what} on ${property || `deal #${req.transaction_id}`}.`
          + (req.reason ? ` Reason: ${req.reason}` : ''),
        // Opens the deal; `approvals` is what the detail page reads to show the approval section.
        link: `/desk/transactions/${req.transaction_id}?section=approvals`,
        dedupeKey: `edit-request:${req.id}`,
        channels: ['in_app'],
      });
    } catch (err) {
      this.log.error(`Edit request ${req.id}: could not notify reviewers — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async statusList(txnId: number): Promise<string[]> {
    const rows = await this.prisma.transaction_statuses.findMany({ where: { transaction_id: txnId }, select: { status: true } });
    const list = rows.map((r) => r.status);
    return list.length ? list : ['Open'];
  }

  async store(user: AuthUserRecord, txnId: number, reason: string | null, scope: string | null): Promise<Record<string, unknown>> {
    const t = await this.prisma.transactions.findFirst({ where: { id: txnId, deleted_at: null } });
    if (!t) throw new NotFoundException({ message: `No query results for model [App\\Models\\Transaction] ${txnId}.` });

    const statuses = await this.statusList(txnId);
    // TD-159 - 'mandatory' joins 'financial' as a scope anybody below Super Admin may ASK about,
    // rather than one only an Admin may raise on a locked deal. The two behave identically: the
    // top tier does not queue a request to itself.
    if (scope === 'financial' || scope === 'mandatory') {
      if (isSuperAdmin(user)) {
        throw new UnprocessableEntityException({
          message: scope === 'financial'
            ? 'Super Admins can edit financial fields directly.'
            : 'Super Admins can change whether a document is Mandatory directly.',
        });
      }
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
    // After the row and the audit entry, so a notification can never be the only trace of a
    // request that failed to save.
    await this.notifyReviewers(req, t.property);
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
