import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { isSuperAdmin } from '../../core/authz';
import { deskTeamLeadIdOf } from '../../users/team-lead';

/**
 * The door to approving and rejecting requests: a Super Admin, as before, or - since 25 Oct 2026 - a
 * Documentation / Accounting Team Lead. The service then checks the request is from the lead's OWN
 * team (workflows/team-review.ts `mayDecide`); this only keeps everybody else out at the door, as
 * `AdminGuard` did. Must run after AuthGuard.
 */
@Injectable()
export class DeskReviewerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const u = req.authUser;
    // 30 Oct 2026 - Documentation members too: they approve an agent's new listing expiry date. The
    // service's `mayDecide` still limits them to that one kind of request.
    if (!isSuperAdmin(u) && deskTeamLeadIdOf(u) === null && u?.role !== 'documentation') {
      throw new ForbiddenException({ message: 'Administrator access required.' });
    }
    return true;
  }
}
