import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { can } from '../core/authz';

/**
 * The Invoice module is for the brokerage's financial staff, and for nobody else.
 *
 * WHAT THIS ADDS THAT `@Screen('invoice', …)` DOES NOT. The screen permission is a per-user dial an
 * administrator sets in Roles & Permissions. It was the ONLY thing standing between a principal and
 * the brokerage's whole invoice ledger, because `InvoicesService.index()` and `show()` filter on
 * `deleted_at` and nothing else — no ownership, no role. So one mistaken override
 * (`agent → invoice: view`) silently published every invoice in the brokerage: customer names,
 * amounts, balances, commission-received dates, banking-bearing documents.
 *
 * The guard closes that by requiring the ROLE as well. `invoices.access` is a named set — Super
 * Admin, Admin, Accounting — rather than a rank threshold, because `documentation` sits at the same
 * rank as `accounting` and must be refused; see the capability's own comment.
 *
 * BOTH CHECKS STILL APPLY. This does not replace the screen permission: an Accounting user whose
 * `invoice` permission is set to `none` is still refused, by `ScreenGuard`. This only makes the
 * permission unable to grant what the role should never have.
 *
 * It is deliberately a guard rather than a check inside each service method. There are fifteen
 * invoice routes across list, detail, create, edit, delete, payments, reminders, send, customers and
 * generate-from-transaction; a rule written per method is a rule that will be missing from the
 * sixteenth. Applied to the controller class, a route added later is covered by default.
 */
@Injectable()
export class InvoiceAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!can(req.authUser, 'invoices.access')) {
      throw new ForbiddenException({
        message: 'The Invoice module is limited to brokerage administration and accounting.',
      });
    }
    return true;
  }
}
