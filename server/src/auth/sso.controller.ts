import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AUTH_LIMIT } from '../config/rate-limits';
import type { AuthUserRecord } from './auth.types';
import { CurrentUser } from './decorators';
import { MobileSsoTokenDto, SsoAuthorizeDto, SsoTokenDto } from './dto/sso.dto';
import { AuthGuard } from './guards/auth.guard';
import { SsoAuthorizationService, type SsoIdentity } from './sso-authorization.service';
import { MobileSessionService } from './mobile-session.service';

@Controller('sso')
export class SsoController {
  constructor(
    private readonly sso: SsoAuthorizationService,
    private readonly mobileSessions: MobileSessionService,
  ) {}

  /**
   * Called by the CRM browser only after the ordinary password/MFA flow has created a session.
   * The returned URL contains a temporary code, never a password or user profile.
   */
  @Post('authorize')
  @UseGuards(AuthGuard)
  @Throttle({ default: AUTH_LIMIT })
  @HttpCode(200)
  async authorize(
    @CurrentUser() user: AuthUserRecord,
    @Body() body: SsoAuthorizeDto,
  ): Promise<{ redirect_url: string; expires_in: number }> {
    const issued = await this.sso.issue(user, {
      clientId: body.client_id,
      redirectUri: body.redirect_uri,
      codeChallenge: body.code_challenge,
    });
    const destination = new URL(body.redirect_uri);
    destination.searchParams.set('code', issued.code);
    destination.searchParams.set('state', body.state);
    return { redirect_url: destination.toString(), expires_in: issued.expiresIn };
  }

  /**
   * Called by Precon's server, not by a browser. It is CSRF-exempt because it has no CRM session;
   * the client secret, PKCE verifier, exact callback URI and one-time code authenticate the call.
   */
  @Post('token')
  @Throttle({ default: AUTH_LIMIT })
  @HttpCode(200)
  token(@Body() body: SsoTokenDto): Promise<SsoIdentity> {
    return this.sso.exchange({
      clientId: body.client_id,
      clientSecret: body.client_secret,
      redirectUri: body.redirect_uri,
      code: body.code,
      codeVerifier: body.code_verifier,
    });
  }

  @Post('mobile/token')
  @Throttle({ default: AUTH_LIMIT })
  @HttpCode(200)
  async mobileToken(@Body() body: MobileSsoTokenDto) {
    const redeemed = await this.sso.exchangeMobile({
      clientId: body.client_id,
      redirectUri: body.redirect_uri,
      code: body.code,
      codeVerifier: body.code_verifier,
    });
    const session = await this.mobileSessions.issue(redeemed.userId);
    return {
      token_type: 'Bearer',
      access_token: session.accessToken,
      expires_in: session.expiresIn,
      user: redeemed.identity,
    };
  }

  @Post('mobile/logout')
  @UseGuards(AuthGuard)
  @HttpCode(204)
  async mobileLogout(@CurrentUser() _user: AuthUserRecord, @Req() req: Request): Promise<void> {
    // AuthGuard has already validated and attached the native session. Cookie-only calls do not
    // revoke an unrelated mobile device.
    if (req.mobileSessionSid) await this.mobileSessions.revoke(req.mobileSessionSid);
  }
}
