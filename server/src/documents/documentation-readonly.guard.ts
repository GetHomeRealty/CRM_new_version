import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * The Documentation role may READ this transaction's documents and may not change them.
 *
 * WHY A GUARD AND NOT ELEVEN CHECKS. This controller has eleven write routes — bulk update, draft
 * submit and delete, four file uploads, two file deletes, the validation file, reminders — and the
 * twelfth is the one somebody adds without remembering this rule. A guard at the controller covers
 * every route that exists and every route that will exist, which is the only version of this that
 * stays true.
 *
 * WHY NOT `@Screen`. These routes are gated on `transactions: 'edit'`, which this role HOLDS and
 * needs: it edits conditions, clients, the co-op brokerage and the rest of a deal's paperwork
 * through the same screen permission. Removing that would take away the role's actual job. The
 * restriction is about one resource, so it is expressed against that resource.
 *
 * METHOD, NOT ROUTE NAME. Anything that is not a read is refused, so a write disguised as a POST
 * to a cheerful-sounding path is still a write.
 *
 * WHAT THIS DOES NOT TOUCH. The `mandatory` edit request — where this role ASKS a Super Admin to
 * change whether a document is required — lives on the edit-requests controller and is untouched;
 * see `EditRequestsService`, where 'mandatory' is listed among the scopes anybody below Super
 * Admin may raise. That is the authorized route for this role to affect a document, and it still
 * works. So does reading, searching and downloading every document on the deal.
 *
 * ADDED 2026-10-13, when the brokerage asked for every Transaction Quick Action to be strictly
 * view-only for this role. Documents was the one that was genuinely editable — both halves, the
 * screen and the API — so this is the half that a request made outside the screen meets.
 */
@Injectable()
export class DocumentationReadOnlyGuard implements CanActivate {
  /** Reads. Everything else is a change. */
  private static readonly SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & { authUser?: AuthUserRecord }>();
    if (DocumentationReadOnlyGuard.SAFE.has((req.method ?? '').toUpperCase())) return true;
    if (req.authUser?.role !== 'documentation') return true;
    throw new ForbiddenException({
      message: 'Documents are view-only for the Documentation role. Ask an Admin to make the change.',
    });
  }
}
