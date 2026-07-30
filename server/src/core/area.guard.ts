import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ModuleAccessService } from './module-access.service';
import { AREA_LABEL, isArea, type Area } from '../common/domain';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * Refuses a request that names an area the caller may not open.
 *
 * The area-scoped endpoints already take `?area=crm|desk` — the inbox, the calendar, the to-do list,
 * the audit trail, the dashboards. Hiding a module in the navigation stops people finding it; this
 * stops them reaching it anyway by typing a URL or replaying a request, which is the difference
 * between a menu and a permission.
 *
 * Deliberately narrow:
 *
 *   - A request with no `area` is untouched. Most of the API is not area-scoped, and inventing an
 *     area for those requests would guess at something the caller never said.
 *   - An unreadable area falls through to the service's own `parseArea`, which has a defined
 *     fallback. Rejecting here would turn a typo into a 403 rather than a sensible default.
 *   - Screen permissions are unaffected and still apply. This answers "may you open this module at
 *     all", not "what may you do inside it".
 */
@Injectable()
export class AreaGuard implements CanActivate {
  constructor(private readonly modules: ModuleAccessService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const raw = (req.query?.area ?? req.body?.area) as unknown;
    if (!isArea(raw)) return true;

    const area = raw as Area;
    // `authUser`, not `user` — that is where AuthGuard puts it and what the CurrentUser decorator
    // reads. Reading the wrong property here does not fail loudly: it yields undefined, the guard
    // decides there is nobody to check, and every request passes.
    const userId = (req.authUser as AuthUserRecord | undefined)?.id;
    // No authenticated user is the auth guard's business, not this one's.
    if (!userId) return true;

    if (await this.modules.canOpen(userId, area)) return true;

    // Says which of the two reasons it is, because "no access" sends an administrator hunting through
    // permissions when the actual answer is that the module was never bought.
    const licence = await this.modules.licence();
    const licensed = area === 'crm' ? licence.crm : licence.desk;
    throw new ForbiddenException({
      message: licensed
        ? `You do not have access to ${AREA_LABEL[area]}. An administrator can assign it under Settings → Users.`
        : `${AREA_LABEL[area]} is not part of this subscription.`,
    });
  }
}
