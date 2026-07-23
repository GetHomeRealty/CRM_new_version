import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PermissionService } from '../permission.service';
import { SCREEN_META, type ScreenMeta } from '../decorators';

/**
 * Port of Laravel's `screen:<name>,<level>` middleware (EnsureScreenAccess).
 * Reads the @Screen() metadata and checks the user's effective permission. Must
 * run after AuthGuard. 403 { message: "You don't have permission to perform this
 * action." }.
 */
@Injectable()
export class ScreenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const meta = this.reflector.getAllAndOverride<ScreenMeta | undefined>(SCREEN_META, [
      context.getHandler(),
      context.getClass(),
    ]);
    // No @Screen on the route → nothing to enforce here.
    if (!meta) return true;

    const user = context.switchToHttp().getRequest<Request>().authUser;
    const allowed =
      !!user &&
      this.permissions.can(user.role || 'agent', user.user_permissions, meta.screen, meta.level);

    if (!allowed) {
      throw new ForbiddenException({ message: "You don't have permission to perform this action." });
    }
    return true;
  }
}
