import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PermissionService } from '../permission.service';
import { SCREEN_META, type ScreenMeta } from '../decorators';
import { ModuleAccessService } from '../../core/module-access.service';
import { AREA_LABEL, isArea, SCREEN_DOMAIN } from '../../common/domain';

/**
 * Port of Laravel's `screen:<name>,<level>` middleware (EnsureScreenAccess).
 * Reads the @Screen() metadata and checks the user's effective permission. Must
 * run after AuthGuard. 403 { message: "You don't have permission to perform this
 * action." }.
 *
 * It also answers the question ABOVE that one: may this person open the module the screen belongs
 * to at all? `AreaGuard` asks that for the handful of endpoints taking an explicit `?area=`, which
 * left module access enforced on four controllers out of forty-six — the navigation hid the CRM
 * from a Desk-only user, and the API served it to them anyway. Every screen already declares its
 * name here and `SCREEN_DOMAIN` already says which module owns each screen, so the check belongs
 * where the screen is declared rather than in another decorator nobody remembers to add.
 *
 * The two checks stay separate because they answer different questions. A module decides whether an
 * area exists for you; the permission map decides which screens inside it you may open. Module
 * first, since "you have not got the CRM" is the more useful answer of the two.
 */
@Injectable()
export class ScreenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionService,
    private readonly modules: ModuleAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.getAllAndOverride<ScreenMeta | undefined>(SCREEN_META, [
      context.getHandler(),
      context.getClass(),
    ]);
    // No @Screen on the route → nothing to enforce here.
    if (!meta) return true;

    const user = context.switchToHttp().getRequest<Request>().authUser;

    const area = SCREEN_DOMAIN[meta.screen];
    // 'common' screens belong to both areas, and an unknown screen is not one this map has an
    // opinion about. Neither is gated — inventing a module for a screen nobody classified would
    // lock people out of it on the strength of a missing entry.
    if (user && isArea(area)) {
      // The rows came with the user, so this costs no query; `assignedFrom` reads them the same way
      // `assigned` reads its own. A user loaded without them falls back to asking.
      const assigned = user.user_modules
        ? this.modules.assignedFrom(user.user_modules)
        : await this.modules.assigned(user.id);
      const licence = await this.modules.licence();
      const licensed = area === 'crm' ? licence.crm : licence.desk;

      if (!assigned.includes(area) || !licensed) {
        throw new ForbiddenException({
          message: licensed
            ? `You do not have access to ${AREA_LABEL[area]}. An administrator can assign it under Settings → Users.`
            : `${AREA_LABEL[area]} is not part of this subscription.`,
        });
      }
    }

    const allowed =
      !!user &&
      this.permissions.can(user.role || 'agent', user.user_permissions, meta.screen, meta.level);

    if (!allowed) {
      throw new ForbiddenException({ message: "You don't have permission to perform this action." });
    }
    return true;
  }
}
