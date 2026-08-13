import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { encryptToken, decryptToken } from '../meta/meta-crypto';
import { isPermanentAuthFailure } from './google.service';
import { GoogleService, type TokenResponse } from './google.service';
import type { IntegrationScope } from '../email/mail-account.service';
import { GOOGLE_ORIGIN_CREATED_BY } from './google.constants';
import { CacheService } from '../redis/cache.service';

/**
 * CRM Settings and Transaction Desk Settings hold INDEPENDENT Google connections, so every
 * lookup here is keyed on (user, area). Connecting a calendar on one side does not connect
 * one on the other. Callers that predate the split default to 'crm', which is where the
 * Google Calendar card originally lived.
 */
const DEFAULT_SCOPE: IntegrationScope = 'crm';

/**
 * Stores and hands out a user's Google tokens. Access and refresh tokens are held AES-256-GCM
 * encrypted (the same scheme the Meta integration uses) and never returned to the browser.
 */
@Injectable()
export class GoogleConnectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly google: GoogleService,
    /**
     * Only used to drop the dashboard's cached appointment tiles on disconnect. Optional so every
     * existing construction — including this service's specs — keeps working, and a no-op when
     * Redis is not configured, which is what `CacheService.forget` already does on its own.
     */
    private readonly cache?: CacheService,
  ) {}

  async find(userId: number, scope: IntegrationScope = DEFAULT_SCOPE) {
    return this.prisma.google_connections.findUnique({ where: { user_id_scope: { user_id: userId, scope } } });
  }

  /** Save the tokens from a fresh consent. A refresh token is only issued the first time, so an
   *  existing one is preserved when Google omits it on a re-consent. */
  async save(userId: number, tokens: TokenResponse, email: string | null, scope: IntegrationScope = DEFAULT_SCOPE): Promise<void> {
    const existing = await this.find(userId, scope);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (tokens.expires_in ?? 3600) * 1000);
    const refresh = tokens.refresh_token
      ? encryptToken(tokens.refresh_token)
      : existing?.refresh_token ?? null;

    const data = {
      google_email: email ?? existing?.google_email ?? null,
      access_token: encryptToken(tokens.access_token),
      refresh_token: refresh,
      token_expires_at: expiresAt,
      scopes: tokens.scope ?? existing?.scopes ?? null,
      is_active: true,
      connect_error: null,
      // A fresh consent invalidates any prior incremental cursor.
      sync_token: null,
      updated_at: now,
    };
    if (existing) await this.prisma.google_connections.update({ where: { user_id_scope: { user_id: userId, scope } }, data });
    else await this.prisma.google_connections.create({ data: { user_id: userId, scope, calendar_id: 'primary', ...data, created_at: now } });
  }

  /**
   * A usable access token, refreshing it first if it has expired (or is about to). Returns null if
   * the user is not connected or the refresh fails — the caller records that as a connect error.
   */
  async accessToken(userId: number, scope: IntegrationScope = DEFAULT_SCOPE): Promise<string | null> {
    const conn = await this.find(userId, scope);
    if (!conn || !conn.is_active || !conn.access_token) return null;

    const expiresSoon = !conn.token_expires_at || conn.token_expires_at.getTime() - Date.now() < 60_000;
    if (!expiresSoon) return decryptToken(conn.access_token);

    if (!conn.refresh_token) return null;
    try {
      const refreshed = await this.google.refresh(decryptToken(conn.refresh_token));
      await this.prisma.google_connections.update({
        where: { user_id_scope: { user_id: userId, scope } },
        data: {
          access_token: encryptToken(refreshed.access_token),
          token_expires_at: new Date(Date.now() + (refreshed.expires_in ?? 3600) * 1000),
          connect_error: null, updated_at: new Date(),
        },
      });
      return refreshed.access_token;
    } catch (ex) {
      /*
       * PERMANENT AND TEMPORARY ARE NOT THE SAME FAILURE (CRM-GCAL-M02).
       *
       * This recorded one message for both and left `is_active` true in either case. So a revoked
       * grant — which only reconnecting fixes — read exactly like Google having a bad minute, and an
       * agent was told to reconnect a working integration every time the network hiccuped.
       *
       * Now: `invalid_grant` and friends DEACTIVATE the connection, which is what stops the retry
       * sweep from spending attempts on a credential that cannot come back and is what makes the
       * screen able to say "reconnect" and mean it. Anything else — a 503, a rate limit, a socket
       * timeout — leaves the connection ACTIVE and merely notes what happened, because the next
       * attempt will very likely work and making somebody re-consent for that would be the worse bug.
       */
      if (isPermanentAuthFailure(ex)) {
        await this.deactivate(
          userId, scope,
          'Google access was revoked or has expired. Reconnect Google Calendar to start syncing again.',
        );
      } else {
        await this.recordError(
          userId,
          `Could not reach Google to refresh access — this is usually temporary and will be retried. ${(ex as Error).message}`,
          scope,
        );
      }
      return null;
    }
  }

  /**
   * Stop using a connection whose credential cannot recover, and say so.
   *
   * `is_active: false` is what `accessToken` already checks first, so nothing further is attempted
   * for this user until they reconnect — no sweep attempts, no pushes, no pulls. The tokens are left
   * in place rather than cleared: reconnecting overwrites them, and wiping them here would lose the
   * calendar id and the sync token for no gain.
   */
  async deactivate(userId: number, scope: IntegrationScope, message: string): Promise<void> {
    await this.prisma.google_connections.updateMany({
      where: { user_id: userId, scope },
      data: { is_active: false, connect_error: message.slice(0, 500), updated_at: new Date() },
    });
  }

  async recordError(userId: number, message: string, scope: IntegrationScope = DEFAULT_SCOPE): Promise<void> {
    await this.prisma.google_connections.updateMany({ where: { user_id: userId, scope }, data: { connect_error: message.slice(0, 500), updated_at: new Date() } });
  }

  async touchSync(userId: number, syncToken: string | null, scope: IntegrationScope = DEFAULT_SCOPE): Promise<void> {
    await this.prisma.google_connections.update({
      where: { user_id_scope: { user_id: userId, scope } },
      data: { last_sync: new Date(), connect_error: null, ...(syncToken ? { sync_token: syncToken } : {}), updated_at: new Date() },
    });
  }

  /**
   * Disconnect one area's Google Calendar, and take its events off the calendar with it.
   *
   * THE EVENTS ARE THE POINT. Revoking the token and deleting the row used to be the whole of this
   * method, which left every event ever pulled from that calendar sitting in `calendar_events` with
   * `deleted_at IS NULL`. The connection was gone, nothing would ever sync them again, and they
   * stayed on the agent's calendar for ever — the disconnect appeared to do nothing.
   */
  async disconnect(userId: number, scope: IntegrationScope = DEFAULT_SCOPE): Promise<{ hidden: number }> {
    const conn = await this.find(userId, scope);
    if (!conn) return { hidden: 0 };
    if (conn.refresh_token) await this.google.revoke(decryptToken(conn.refresh_token));
    else if (conn.access_token) await this.google.revoke(decryptToken(conn.access_token));
    await this.prisma.google_connections.delete({ where: { user_id_scope: { user_id: userId, scope } } });
    const hidden = await this.hideSyncedEvents(userId, scope);
    await this.forgetDashboardTiles(userId);
    return { hidden };
  }

  /**
   * Drop this user's cached dashboard so its appointment tiles do not out-live the disconnect.
   *
   * The CRM dashboard counts calendar events and is cached per user for twenty seconds, so without
   * this the "appointments in the next 30 days" figure would keep counting events that have just
   * left the calendar. Twenty seconds is not long, but the tile and the Calendar screen disagreeing
   * at all is the kind of thing that gets reported as the disconnect not having worked.
   *
   * Both privilege variants are dropped because the key carries one — a super admin and an ordinary
   * agent hold separate entries — and only the caller's own keys are touched.
   */
  private async forgetDashboardTiles(userId: number): Promise<void> {
    if (!this.cache) return;
    await Promise.all([
      this.cache.forget('dashboard', `crm:${userId}:own`),
      this.cache.forget('dashboard', `crm:${userId}:sa`),
    ]);
  }

  /**
   * Hide the events that came from the calendar just disconnected. Returns how many.
   *
   * WHAT IS AND IS NOT TOUCHED, in the order the conditions matter:
   *
   *   created_by  is the ONLY safe test of origin. `google_calendar_id` is set in both directions —
   *               an agent's own appointment carries one the moment it is mirrored out — so
   *               filtering on it would delete their own work. See GOOGLE_ORIGIN_CREATED_BY.
   *   user_id     one agent's disconnect never reaches another's calendar.
   *   domain      the disconnected AREA only, so disconnecting CRM leaves the Transaction Desk's
   *               events exactly where they are, even when both connect the same Google account.
   *   deleted_at  already-deleted rows are left alone, so a disconnect cannot overwrite the record
   *               of when an agent deleted something.
   *
   * THE `domain IS NULL` CASE, which is not hypothetical — there are 99 such events in development
   * and 266 in QA. They pre-date the CRM/Desk split and, by `areaWhere`, show on BOTH calendars;
   * nothing records which connection they came from. Hiding them on any disconnect would strip
   * events from an area that is still connected, and hiding them on none would leave Google events
   * on a calendar with no Google. So they are hidden only when the OTHER area has no connection
   * either — at which point no Google connection remains and no Google event should be visible,
   * whichever calendar it originally came from. While the other area is still connected they are
   * left, and its next pull stamps them with a real area, which settles the ambiguity for good.
   */
  private async hideSyncedEvents(userId: number, scope: IntegrationScope): Promise<number> {
    const other: IntegrationScope = scope === 'crm' ? 'desk' : 'crm';
    const otherStillConnected = await this.prisma.google_connections.count({ where: { user_id: userId, scope: other } }) > 0;
    const now = new Date();

    const { count } = await this.prisma.calendar_events.updateMany({
      where: {
        user_id: userId,
        created_by: GOOGLE_ORIGIN_CREATED_BY,
        deleted_at: null,
        ...(otherStillConnected
          ? { domain: scope }
          : { OR: [{ domain: scope }, { domain: null }] }),
      },
      // Both are written. `deleted_at` is what every calendar query already filters on, so it is
      // what actually removes the events from the screen; `google_disconnected_at` is what lets a
      // reconnect tell these apart from appointments the agent deleted, and bring back only these.
      data: { deleted_at: now, google_disconnected_at: now, updated_at: now },
    });
    return count;
  }
}
