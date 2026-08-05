import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { encryptToken, decryptToken } from '../meta/meta-crypto';
import { isPermanentAuthFailure } from './google.service';
import { GoogleService, type TokenResponse } from './google.service';
import type { IntegrationScope } from '../email/mail-account.service';

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
  constructor(private readonly prisma: PrismaService, private readonly google: GoogleService) {}

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

  async disconnect(userId: number, scope: IntegrationScope = DEFAULT_SCOPE): Promise<void> {
    const conn = await this.find(userId, scope);
    if (!conn) return;
    if (conn.refresh_token) await this.google.revoke(decryptToken(conn.refresh_token));
    else if (conn.access_token) await this.google.revoke(decryptToken(conn.access_token));
    await this.prisma.google_connections.delete({ where: { user_id_scope: { user_id: userId, scope } } });
  }
}
