import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { isSuperAdmin } from '../../core/authz';

/**
 * Port of Laravel's `admin` middleware (EnsureAdmin): requires the top tier. Must run after
 * AuthGuard. 403 { message: "Administrator access required." }.
 *
 * The decision is NOT made here. This guard used to compare `role !== 'admin'` itself, which made
 * it a second source of truth alongside the permission service and four services that each wrote
 * the same comparison out again. It now asks the authorization engine, so a change to what "top
 * tier" means happens once.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!isSuperAdmin(req.authUser)) {
      throw new ForbiddenException({ message: 'Administrator access required.' });
    }
    return true;
  }
}
