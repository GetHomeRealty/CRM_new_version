import { Controller, Get, Req, UseGuards, Query } from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { parseScope } from '../email/mail-account.service';
import { GoogleService } from './google.service';
import { GoogleStateService } from './google-state.service';
import { isMailConfigured, redirectUri } from './google.constants';

const str = (v: unknown): string => String(v ?? '').trim();

function origin(req: Request): string {
  const proto = str(req.headers['x-forwarded-proto']) || req.protocol || 'http';
  const host = str(req.headers['x-forwarded-host']) || str(req.headers.host);
  return host ? `${proto}://${host}` : '';
}

/**
 * "Connect Gmail" for connecting a personal Gmail account to send/receive mail. Available to
 * every signed-in user (their own mailbox). Returns Google's consent-screen URL; the browser
 * navigates there and Google returns to the shared `/api/google/callback`, which finishes the mail
 * connect based on the signed state's purpose.
 */
@Controller('google/mail')
@UseGuards(AuthGuard)
export class GoogleMailController {
  constructor(private readonly google: GoogleService, private readonly state: GoogleStateService) {}

  @Get('connect')
  connect(@CurrentUser() user: AuthUserRecord, @Req() req: Request, @Query('scope') scope?: string): Record<string, unknown> {
    /*
     * `isMailConfigured`, not `isConfigured`. The Gmail connect may run on its own Google project,
     * and the failure mode this guards against is the expensive one: with only half a pair set, the
     * flow starts, the person picks an account and grants access to their entire mailbox, and only
     * then does the token exchange answer `invalid_client`. Refusing on the button is the honest
     * version of the same answer.
     */
    if (!isMailConfigured()) {
      return { configured: false, message: 'Google sign-in for mail is not set up on the server yet.' };
    }
    // The area (CRM vs Transaction Desk) rides through the round trip inside the signed
    // state, so the callback stores the account against the side that started the connect.
    const state = this.state.issue(user.id ?? -1, 'mail', parseScope(scope) ?? 'crm');
    const url = this.google.mailAuthUrl(state, redirectUri(origin(req)));
    return { configured: true, url };
  }
}
