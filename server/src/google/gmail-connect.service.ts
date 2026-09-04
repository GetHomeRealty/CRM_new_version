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
      // Reconnect the same Hub mailbox regardless of which area started OAuth.
      where: { user_id: userId, encryption: GmailConnectService.OAUTH, from_email: { equals: address, mode: 'insensitive' } },
    });

    if (existing) {
      /*
       * Reconnect: take the refresh token only if Google returned a NEW one. Google omits it when
       * consent was already standing, in which case this row keeps the credential it already had.
       *
       * WHY `sync_error` IS NOT BLANKET-CLEARED ANY MORE.
       *
       * It used to be cleared on every reconnect, including the branch where no new token arrived.
       * That reported a repair that had not happened: the row kept the SAME credential — possibly
       * the very one Google had revoked — while the screen showed a freshly connected account with
       * no error. Reconnecting then looked like it worked, failed again on the next poll minutes
       * later, and the obvious response was to reconnect again. Observed on this deployment:
       * `precon@` reconnected at 05:42 and rejected by Google with `invalid_grant` on a credential
       * stored the same morning.
       *
       * So the error is cleared only when a NEW token actually replaced the old one. When the token
       * was preserved and the account was already failing, the message is replaced with the one
       * instruction that does resolve it — Google only re-issues a refresh token after the app's
       * access is removed, so consenting again to a grant that already exists cannot help.
       *
       * A preserved token on a HEALTHY account is left completely alone: nothing changed, so
       * nothing is claimed either way, and the next successful poll keeps it clear.
       */
      const preservedAfterFailure = !encRefresh && !!existing.sync_error;
      await this.prisma.mail_accounts.update({
        where: { id: existing.id },
        data: {
          is_active: true,
          updated_at: new Date(),
          ...(encRefresh
            ? { password: encRefresh, sync_error: null }
            : preservedAfterFailure
              ? {
                sync_error:
                  'Google did not issue a new authorisation for this mailbox, so it is still using the '
                  + 'one that was already failing. Signing in again cannot replace it while that access '
                  + 'is still granted. Remove this app at myaccount.google.com (Security -> '
                  + 'Third-party apps with account access), then connect the mailbox again.',
              }
              : {}),
        },
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
    const hasDefault = await this.prisma.mail_accounts.findFirst({ where: { user_id: userId, is_default: true }, select: { id: true } });
    const now = new Date();
    await this.prisma.mail_accounts.create({
      data: {
        name: address, from_name: null, from_email: address,
        host: 'smtp.gmail.com', port: 587, username: address,
        password: encRefresh, encryption: GmailConnectService.OAUTH,
        is_active: true, is_default: !hasDefault, user_id: userId,
        // Null is the shared Hub scope used by both CRM and Transactions.
        scope: null,
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
