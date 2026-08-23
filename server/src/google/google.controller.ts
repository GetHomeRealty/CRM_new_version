import { Controller, Get, HttpCode, Post, Query, Req, UseGuards } from '@nestjs/common';
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
      /*
       * How many of this person's appointments Google has not received (CRM-GCAL-M01).
       *
       * Reported beside `error` because they answer different questions and both matter: `error` is
       * "the connection is unhappy", this is "and here is what it has cost you so far". A failed push
       * used to be logged and forgotten, so the honest number was unknowable from anywhere.
       */
      pending_sync: await this.sync.pendingSyncCount(user.id ?? -1, parseScope(scope) ?? 'crm'),
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

  /**
   * The Retry button beside the failed-sync count.
   *
   * Manual as well as automatic, because the sweep gives up after five attempts and a person who has
   * just fixed the cause — reconnected, or waited out a Google incident — should not have to wait
   * for a schedule or be told to edit each appointment again to nudge it. `retryNow` resets the
   * attempt count, which is the difference between this and simply waiting.
   */
  @Post('retry')
  // 200, not Nest's default 201: this creates nothing, it retries something that already exists.
  // The same house style as `CrmSettingsController.savePost`. `POST sync` beside it still answers
  // 201 and is left alone — changing a response code the client already handles is not this fix.
  @HttpCode(200)
  async retrySync(@CurrentUser() user: AuthUserRecord, @Query('scope') scope?: string): Promise<Record<string, unknown>> {
    const r = await this.sync.retryNow(user.id ?? -1, parseScope(scope) ?? 'crm');
    const left = await this.sync.pendingSyncCount(user.id ?? -1, parseScope(scope) ?? 'crm');
    /*
     * NOTHING OUTSTANDING IS NOT THE SAME AS EVERYTHING SYNCED.
     *
     * `left === 0` used to print "All N appointments reached Google", which was true while the only
     * way to stop being outstanding was to succeed. It no longer is: an event Google refuses
     * permanently — a Contact birthday it will not let any client modify — is released rather than
     * retried for ever, and that also drives the count to zero. Reporting it as "reached Google"
     * would be claiming a delivery Google explicitly declined.
     */
    const parts: string[] = [];
    if (r.recovered) parts.push(`${r.recovered} reached Google`);
    if (r.released) {
      parts.push(
        `${r.released} cannot be synced — Google does not allow changes to `
        + `${r.released === 1 ? 'it' : 'them'}, so ${r.released === 1 ? 'it is' : 'they are'} no longer listed as outstanding`,
      );
    }
    if (left) parts.push(`${left} still outstanding — check the connection below`);

    return {
      ...r, pending_sync: left,
      message: r.attempted === 0
        ? 'Everything is already up to date with Google.'
        : parts.length
          ? `${parts.join('. ')}.`
          : `None of the ${r.attempted} could be sent to Google. Check the connection below.`,
    };
  }

  @Post('disconnect')
  async disconnect(@CurrentUser() user: AuthUserRecord, @Query('scope') scope?: string): Promise<{ disconnected: boolean }> {
    await this.connections.disconnect(user.id ?? -1, parseScope(scope) ?? 'crm');
    return { disconnected: true };
  }
}
