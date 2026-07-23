import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from '../auth.service';

/**
 * Session-cookie authentication (Sanctum-contract emulation). Requires a logged-in
 * session; loads the user (with permission overrides) and attaches it to the
 * request. Mirrors Laravel's `auth:sanctum` — 401 { message: "Unauthenticated." }.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const userId = req.session?.userId;
    if (!userId) {
      throw new UnauthorizedException({ message: 'Unauthenticated.' });
    }
    const user = await this.auth.loadUser(userId);
    if (!user) {
      throw new UnauthorizedException({ message: 'Unauthenticated.' });
    }
    req.authUser = user;
    return true;
  }
}
