import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from '../auth.service';
import { MobileSessionService } from '../mobile-session.service';
import { requestedMarket, resolveMarket } from '../../common/market';

/**
 * Authentication for browser session cookies and revocable native bearer sessions. Loads the user
 * (with permission overrides) and attaches it to the request. Mirrors Laravel's `auth:sanctum` —
 * 401 { message: "Unauthenticated." }.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly mobileSessions: MobileSessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    let userId = req.session?.userId ?? req.mobileUserId;
    if (!userId) {
      const mobile = await this.mobileSessions.authenticate(req.headers.authorization);
      if (mobile) {
        userId = mobile.userId;
        req.mobileUserId = mobile.userId;
        req.mobileSessionSid = mobile.sid;
      }
    }
    if (!userId) {
      throw new UnauthorizedException({ message: 'Unauthenticated.' });
    }
    const user = await this.auth.loadUser(userId);
    if (!user) {
      throw new UnauthorizedException({ message: 'Unauthenticated.' });
    }
    // The country this request works in (India desk, 16 Oct 2026): the one the top-bar switch asked
    // for if this person may use it, otherwise Canada. Every deal read narrows to it.
    user.market = resolveMarket(requestedMarket(req), user.markets);
    req.authUser = user;
    return true;
  }
}
