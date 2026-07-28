import { Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { GoogleConnectionService } from './google-connection.service';
import { GoogleService } from './google.service';
import { GoogleStateService } from './google-state.service';
import { GoogleCalendarSyncService } from './google-calendar-sync.service';
import { isConfigured, redirectUri } from './google.constants';
import { parseScope } from '../email/mail-account.service';

const str = (v: unknown): string => String(v ?? '').trim();

function origin(req: Request): string {
  const proto = str(req.headers['x-forwarded-proto']) || req.protocol || 'http';
  const host = str(req.headers['x-forwarded-host']) || str(req.headers.host);
  return host ? `${proto}://${host}` : '';
}

/**
 * A user's own Google Calendar connection. Guarded by authentication and scoped to the signed-in
 * user; never returns a token. Available to every user (their own calendar), so it is gated on
 * login only, not the admin settings screen.
 */
@Controller('google/calendar')
@UseGuards(AuthGuard)
export class GoogleController {
  constructor(
    private readonly connections: GoogleConnectionService,
    private readonly google: GoogleService,
    private readonly state: GoogleStateService,
    private readonly sync: GoogleCalendarSyncService,
  ) {}

  /** Whether Google sign-in is set up on this server, and this user's connection state. */
  @Get('status')
  async status(@CurrentUser() user: AuthUserRecord, @Query('scope') scope?: string): Promise<Record<string, unknown>> {
    // CRM Settings and Transaction Desk Settings hold independent connections, so the
    // status reported is the one for the area that asked. Callers that send no scope get
    // the CRM connection, which is where this card originally lived.
    const conn = await this.connections.find(user.id ?? -1, parseScope(scope) ?? 'crm');
    return {
      configured: isConfigured(),
      connected: !!(conn && conn.is_active),
      email: conn?.google_email ?? null,
      last_sync: conn?.last_sync ? conn.last_sync.toISOString() : null,
      error: conn?.connect_error ?? null,
      // Stated plainly so the UI can explain a disabled button rather than failing silently.
      setup_hint: isConfigured() ? null : 'Google sign-in is not set up on the server yet — it needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
    };
  }

  /**
   * Begin the connect flow. Returns the URL of Google's own consent screen; the browser then
   * navigates there, Google shows the account picker, and the callback finishes the handshake.
   */
  @Get('connect')
  connect(@CurrentUser() user: AuthUserRecord, @Req() req: Request, @Query('scope') scope?: string): Record<string, unknown> {
    if (!isConfigured()) {
      return { configured: false, message: 'Google sign-in is not set up on the server yet.' };
    }
    // The area is carried through the OAuth round trip in the state token, so the callback
    // stores the tokens against the side that started the flow.
    const state = this.state.issue(user.id ?? -1, 'calendar', parseScope(scope) ?? 'crm');
    const url = this.google.authUrl(state, redirectUri(origin(req)));
    return { configured: true, url };
  }

  @Post('sync')
  async syncNow(@CurrentUser() user: AuthUserRecord, @Query('scope') scope?: string): Promise<Record<string, unknown>> {
    const result = await this.sync.pull(user.id ?? -1, parseScope(scope) ?? 'crm');
    return { ...result, message: result.error ? result.error : `Synced ${result.pulled} event${result.pulled === 1 ? '' : 's'} from Google.` };
  }

  @Post('disconnect')
  async disconnect(@CurrentUser() user: AuthUserRecord, @Query('scope') scope?: string): Promise<{ disconnected: boolean }> {
    await this.connections.disconnect(user.id ?? -1, parseScope(scope) ?? 'crm');
    return { disconnected: true };
  }
}
