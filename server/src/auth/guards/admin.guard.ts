import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Port of Laravel's `admin` middleware (EnsureAdmin): requires the top 'admin'
 * role (Super Admin). Must run after AuthGuard. 403 { message: "Administrator
 * access required." }.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!req.authUser || req.authUser.role !== 'admin') {
      throw new ForbiddenException({ message: 'Administrator access required.' });
    }
    return true;
  }
}
