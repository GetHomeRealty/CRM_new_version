import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AUTH_LIMIT } from '../config/rate-limits';
import type { AuthUserRecord } from './auth.types';
import { CurrentUser } from './decorators';
import { SsoAuthorizeDto, SsoTokenDto } from './dto/sso.dto';
import { AuthGuard } from './guards/auth.guard';
import { SsoAuthorizationService, type SsoIdentity } from './sso-authorization.service';

@Controller('sso')
export class SsoController {
  constructor(private readonly sso: SsoAuthorizationService) {}

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
}
