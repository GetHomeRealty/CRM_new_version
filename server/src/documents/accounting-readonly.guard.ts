import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * Marks the few document routes the Accounting role may WRITE through (2026-10-22).
 *
 * The brokerage asked for Accounting to add documents and upload files, and still not change
 * anything already there. So the guard below stays a refusal by default, and only the routes
 * carrying this mark let the role through: saving the list (where `DocumentsService.bulkUpdate`
 * then creates new rows only), and the two uploads (which refuse to replace a file). Deletes,
 * validation files, reminders and drafts carry no mark and stay refused.
 */
export const ACCOUNTING_MAY_ADD = 'accountingMayAdd';
export const AccountingMayAdd = (): MethodDecorator => SetMetadata(ACCOUNTING_MAY_ADD, true);

/**
 * The Accounting role may READ a deal's documents and may not change them (brokerage request,
 * 2026-10-13) — except to add documents and files, on the routes marked `@AccountingMayAdd()`
 * (2026-10-22).
 *
 * A GUARD ON THE CONTROLLER, not a check per route: this controller has a dozen write routes -
 * bulk update, drafts, uploads, file and validation-file deletes, reminders - and a guard covers
 * the next one added too. Not `@Screen` either: these routes need `transactions: 'edit'`, which
 * this role holds and needs for the rest of its work on a deal.
 *
 * METHOD, NOT ROUTE NAME: anything that is not a read is refused unless its handler is marked.
 * Reading, previewing and downloading every document still work.
 */
@Injectable()
export class AccountingReadOnlyGuard implements CanActivate {
  /** Reads. Everything else is a change. */
  private static readonly SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

  constructor(private readonly reflector: Reflector = new Reflector()) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & { authUser?: AuthUserRecord }>();
    if (AccountingReadOnlyGuard.SAFE.has((req.method ?? '').toUpperCase())) return true;
    if (req.authUser?.role !== 'accounting') return true;
    if (this.reflector.get<boolean>(ACCOUNTING_MAY_ADD, context.getHandler())) return true;
    throw new ForbiddenException({
      message: 'Accounting can add documents and upload files, but not change or remove what is there. Ask an Admin or Documentation to make the change.',
    });
  }
}
