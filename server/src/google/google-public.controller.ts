import { Controller, Get, Logger, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { GoogleConnectionService } from './google-connection.service';
import { GoogleService } from './google.service';
import { GoogleStateService } from './google-state.service';
import { GoogleCalendarSyncService } from './google-calendar-sync.service';
import { GmailConnectService } from './gmail-connect.service';
import { frontendReturn, isConfigured, redirectUri } from './google.constants';

const str = (v: unknown): string => String(v ?? '').trim();

/**
 * The endpoint Google redirects the browser back to after consent. No AuthGuard and no CSRF token
 * — there is no session on a cross-site redirect from Google. It is trusted via the signed
 * `state`, which carries the user id and is verified before anything is stored. Always ends in a
 * redirect back into the SPA; the user never sees raw JSON.
 *
 * Registered before GoogleController so `/api/google/callback` is matched here, not by the guarded
 * controller. Express matches in registration order.
 */
@Controller('google')
export class GooglePublicController {
  private readonly log = new Logger(GooglePublicController.name);

  constructor(
    private readonly connections: GoogleConnectionService,
    private readonly google: GoogleService,
    private readonly state: GoogleStateService,
    private readonly sync: GoogleCalendarSyncService,
    private readonly gmail: GmailConnectService,
  ) {}

  @Get('callback')
  async callback(@Query() q: Record<string, string>, @Req() req: Request, @Res() res: Response): Promise<void> {
    const fail = (reason: string, detail = ''): void => {
      if (detail) this.log.warn(`Google OAuth callback failed (${reason}): ${detail}`);
      res.redirect(frontendReturn(`google_error=${encodeURIComponent(reason)}`));
    };

    if (str(q.error)) return fail(str(q.error));
    const code = str(q.code);
    if (!code) return fail('missing_code');
    // A bad state means forged, expired or replayed — never fall back to trusting the caller.
    const verified = this.state.verify(str(q.state));
    if (!verified) return fail('invalid_state');
    if (!isConfigured()) return fail('not_configured');
    const { userId, purpose, scope } = verified;

    try {
      const proto = str(req.headers['x-forwarded-proto']) || req.protocol || 'http';
      const host = str(req.headers['x-forwarded-host']) || str(req.headers.host);
      const uri = redirectUri(host ? `${proto}://${host}` : '');

      const tokens = await this.google.exchangeCode(code, uri);
      const email = await this.google.email(tokens.access_token);

      // Same callback finishes either a Gmail (mail) or a Calendar connect, per the signed state.
      if (purpose === 'mail') {
        await this.gmail.upsert(userId, tokens, email, scope);
        return res.redirect(frontendReturn('mail_connected=1'));
      }

      // Stored against the area that began the flow — CRM and Transaction Desk hold
      // independent calendar connections.
      await this.connections.save(userId, tokens, email, scope);
      // Pull once immediately so the calendar isn't empty right after connecting. Best-effort.
      try { await this.sync.pull(userId, scope); } catch { /* surfaced later via status */ }
      res.redirect(frontendReturn('google_connected=1'));
    } catch (ex) {
      const detail = (ex as Error).message;
      if (purpose === 'mail') {
        this.log.warn(`Gmail OAuth connect failed: ${detail}`);
        return res.redirect(frontendReturn(`mail_error=${encodeURIComponent(detail.slice(0, 140))}`));
      }
      return fail('exchange_failed', detail);
    }
  }
}
