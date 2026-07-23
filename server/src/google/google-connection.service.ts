import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { encryptToken, decryptToken } from '../meta/meta-crypto';
import { GoogleService, type TokenResponse } from './google.service';

/**
 * Stores and hands out a user's Google tokens. Access and refresh tokens are held AES-256-GCM
 * encrypted (the same scheme the Meta integration uses) and never returned to the browser.
 */
@Injectable()
export class GoogleConnectionService {
  constructor(private readonly prisma: PrismaService, private readonly google: GoogleService) {}

  async find(userId: number) {
    return this.prisma.google_connections.findUnique({ where: { user_id: userId } });
  }

  /** Save the tokens from a fresh consent. A refresh token is only issued the first time, so an
   *  existing one is preserved when Google omits it on a re-consent. */
  async save(userId: number, tokens: TokenResponse, email: string | null): Promise<void> {
    const existing = await this.find(userId);
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
    if (existing) await this.prisma.google_connections.update({ where: { user_id: userId }, data });
    else await this.prisma.google_connections.create({ data: { user_id: userId, calendar_id: 'primary', ...data, created_at: now } });
  }

  /**
   * A usable access token, refreshing it first if it has expired (or is about to). Returns null if
   * the user is not connected or the refresh fails — the caller records that as a connect error.
   */
  async accessToken(userId: number): Promise<string | null> {
    const conn = await this.find(userId);
    if (!conn || !conn.is_active || !conn.access_token) return null;

    const expiresSoon = !conn.token_expires_at || conn.token_expires_at.getTime() - Date.now() < 60_000;
    if (!expiresSoon) return decryptToken(conn.access_token);

    if (!conn.refresh_token) return null;
    try {
      const refreshed = await this.google.refresh(decryptToken(conn.refresh_token));
      await this.prisma.google_connections.update({
        where: { user_id: userId },
        data: {
          access_token: encryptToken(refreshed.access_token),
          token_expires_at: new Date(Date.now() + (refreshed.expires_in ?? 3600) * 1000),
          connect_error: null, updated_at: new Date(),
        },
      });
      return refreshed.access_token;
    } catch (ex) {
      await this.recordError(userId, `Could not refresh Google access — reconnect. ${(ex as Error).message}`);
      return null;
    }
  }

  async recordError(userId: number, message: string): Promise<void> {
    await this.prisma.google_connections.updateMany({ where: { user_id: userId }, data: { connect_error: message.slice(0, 500), updated_at: new Date() } });
  }

  async touchSync(userId: number, syncToken: string | null): Promise<void> {
    await this.prisma.google_connections.update({
      where: { user_id: userId },
      data: { last_sync: new Date(), connect_error: null, ...(syncToken ? { sync_token: syncToken } : {}), updated_at: new Date() },
    });
  }

  async disconnect(userId: number): Promise<void> {
    const conn = await this.find(userId);
    if (!conn) return;
    if (conn.refresh_token) await this.google.revoke(decryptToken(conn.refresh_token));
    else if (conn.access_token) await this.google.revoke(decryptToken(conn.access_token));
    await this.prisma.google_connections.delete({ where: { user_id: userId } });
  }
}
