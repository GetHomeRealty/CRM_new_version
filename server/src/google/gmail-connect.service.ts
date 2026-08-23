import { assertCanConnectEmail } from '../email/agent-email-limit';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LaravelCryptService } from '../common/laravel-crypt.service';
import type { TokenResponse } from './google.service';
import type { IntegrationScope } from '../email/mail-account.service';
import { tokenFingerprint } from '../common/token-fingerprint';
// Which OAuth client minted the token being stored — recorded so a saved credential can be
// matched against the client it will later be refreshed with.
import { mailClientId } from './google.constants';

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
      /*
       * PROVES WHICH CREDENTIAL THIS ROW NOW HOLDS.
       *
       * A Google audit log showing REVOKE at 15:06:45 and GRANT at 15:07:00 does not say whether
       * THIS row took the new token — and if it kept the revoked one, every later refresh fails
       * with `invalid_grant` while the account looks freshly reconnected. The fingerprint is the
       * only way to tell those apart without printing the token: compare it against the one logged
       * at refresh time. Same fingerprint = same credential.
       *
       * `preserved` is the case to watch. Google omits the refresh token when consent was already
       * standing, and the row then keeps whatever it had — which is correct when the old token is
       * still good, and is exactly the trap when the user has just revoked it.
       */
      this.log.log(
        `Gmail credential SAVED — operation=gmail.reconnect account=#${existing.id} email=${address} user=${userId} `
        + `oauth_client_project=${mailClientId().split('-')[0] || 'unknown'} `
        + `refresh_token_returned=${tokens.refresh_token ? 'yes' : 'no'} `
        + `action=${encRefresh ? 'REPLACED' : 'PRESERVED-existing'} `
        + `refresh_fingerprint=${tokenFingerprint(encRefresh ? tokens.refresh_token : this.crypt.decryptString(existing.password))} `
        + `at=${new Date().toISOString()}`,
      );
      return;
    }

    if (!encRefresh) {
      // No refresh token and no existing account to fall back on — Google only returns one on first
      // consent. Ask the user to revoke and reconnect so a fresh refresh token is issued.
      throw new Error('Google did not return a refresh token. Remove this app under your Google account access settings, then connect again.');
    }

    // An agent may hold one account per area. Checked here and not only on the manual form,
    // because connecting through Google reaches this point without touching that form — and it is
    // checked AFTER the reconnect branch above, so re-authorising an account the agent already has
    // is never refused.
    await assertCanConnectEmail(this.prisma, userId, scope);

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
    /*
     * A NEW ROW, not the one that was failing. Logged with the same fields as the reconnect branch
     * so the two are comparable: the lookup above is keyed on `user_id`, so the SAME mailbox
     * connected while signed in as a DIFFERENT CRM user lands here and creates a second row. The
     * original row keeps its old credential and goes on failing, while the person who clicked
     * Reconnect sees a healthy account. The account id in this line is what reveals that.
     */
    const created = await this.prisma.mail_accounts.findFirst({
      where: { user_id: userId, scope, from_email: { equals: address, mode: 'insensitive' } },
      orderBy: { id: 'desc' }, select: { id: true },
    });
    this.log.log(
      `Gmail credential SAVED — operation=gmail.connect-new account=#${created?.id ?? '?'} email=${address} user=${userId} `
      + `oauth_client_project=${mailClientId().split('-')[0] || 'unknown'} `
      + `refresh_token_returned=${tokens.refresh_token ? 'yes' : 'no'} action=NEW-ROW `
      + `refresh_fingerprint=${tokenFingerprint(tokens.refresh_token)} at=${new Date().toISOString()}`,
    );
    this.log.log(`Connected Gmail account ${address} for user ${userId}`);
  }
}
