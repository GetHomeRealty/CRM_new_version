import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * The Accounting role may READ a deal's documents and may not change them (brokerage request,
 * 2026-10-13).
 *
 * A GUARD ON THE CONTROLLER, not a check per route: this controller has a dozen write routes -
 * bulk update, drafts, uploads, file and validation-file deletes, reminders - and a guard covers
 * the next one added too. Not `@Screen` either: these routes need `transactions: 'edit'`, which
 * this role holds and needs for the rest of its work on a deal.
 *
 * METHOD, NOT ROUTE NAME: anything that is not a read is refused. Reading, previewing and
 * downloading every document still work.
 */
@Injectable()
export class AccountingReadOnlyGuard implements CanActivate {
  /** Reads. Everything else is a change. */
  private static readonly SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & { authUser?: AuthUserRecord }>();
    if (AccountingReadOnlyGuard.SAFE.has((req.method ?? '').toUpperCase())) return true;
    if (req.authUser?.role !== 'accounting') return true;
    throw new ForbiddenException({
      message: 'Documents are view-only for the Accounting role. Ask an Admin or Documentation to make the change.',
    });
  }
}
