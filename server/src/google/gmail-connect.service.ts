import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LaravelCryptService } from '../common/laravel-crypt.service';
import type { TokenResponse } from './google.service';
import type { IntegrationScope } from '../email/mail-account.service';

/**
 * Turns a completed Google OAuth (mail scope) into a personal `mail_accounts` row that sends and
 * receives through Gmail with XOAUTH2. The account is marked with `encryption = 'oauth'` and its
 * `password` column holds the ENCRYPTED refresh token (never a real password) — the mailer and the
 * IMAP poller both branch on that sentinel. No schema change: an existing column is repurposed.
 */
@Injectable()
export class GmailConnectService {
  private readonly log = new Logger(GmailConnectService.name);

  constructor(private readonly prisma: PrismaService, private readonly crypt: LaravelCryptService) {}

  /** The sentinel written to `encryption` so send/receive know to use OAuth instead of a password. */
  static readonly OAUTH = 'oauth';

  async upsert(userId: number, tokens: TokenResponse, email: string | null, scope: IntegrationScope = 'crm'): Promise<void> {
    const address = (email ?? '').trim();
    if (!address) throw new Error('Google did not return an email address for this account.');

    const encRefresh = tokens.refresh_token ? this.crypt.encryptString(tokens.refresh_token) : null;

    const existing = await this.prisma.mail_accounts.findFirst({
      // Scoped: CRM Settings and Transaction Desk Settings hold separate connections, so the
      // same Gmail address connected on both sides is two independent rows, not one shared one.
      where: { user_id: userId, scope, encryption: GmailConnectService.OAUTH, from_email: { equals: address, mode: 'insensitive' } },
    });

    if (existing) {
      // Reconnect: refresh the stored token only if Google returned a new one (it omits the refresh
      // token when the user had already granted consent), and re-enable the account.
      await this.prisma.mail_accounts.update({
        where: { id: existing.id },
        data: { is_active: true, sync_error: null, updated_at: new Date(), ...(encRefresh ? { password: encRefresh } : {}) },
      });
      this.log.log(`Reconnected Gmail account ${address} for user ${userId}`);
      return;
    }

    if (!encRefresh) {
      // No refresh token and no existing account to fall back on — Google only returns one on first
      // consent. Ask the user to revoke and reconnect so a fresh refresh token is issued.
      throw new Error('Google did not return a refresh token. Remove this app under your Google account access settings, then connect again.');
    }

    // First personal account a user connects becomes their default sender.
    const hasDefault = await this.prisma.mail_accounts.findFirst({ where: { user_id: userId, scope, is_default: true }, select: { id: true } });
    const now = new Date();
    await this.prisma.mail_accounts.create({
      data: {
        name: address, from_name: null, from_email: address,
        host: 'smtp.gmail.com', port: 587, username: address,
        password: encRefresh, encryption: GmailConnectService.OAUTH,
        is_active: true, is_default: !hasDefault, user_id: userId,
        // Without this the account has no area and, because the lists match strictly, would
        // show in neither CRM nor Transaction Desk — a connect that silently does nothing.
        scope,
        imap_host: 'imap.gmail.com', imap_port: 993, imap_encryption: 'ssl', inbound_enabled: true,
        created_at: now, updated_at: now,
      },
    });
    this.log.log(`Connected Gmail account ${address} for user ${userId}`);
  }
}
