import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../email/mailer.service';
import { PasswordHashService } from './password-hash.service';
import { throwValidation } from '../common/laravel-exceptions';

/**
 * "I have forgotten my password."
 *
 * There was no way back into an account without an administrator, so this is the whole journey:
 * ask for a link, receive one, choose a new password.
 *
 * THE THREE RULES THAT MAKE IT SAFE, and each is a decision rather than a default.
 *
 *   THE TOKEN IS NEVER STORED. `password_reset_tokens.token` holds a SHA-256 of it, and the
 *   plaintext exists only in the email. A leaked database backup therefore yields nothing that can
 *   be replayed — anyone reading the table sees hashes, exactly as with a password column.
 *
 *   THE ANSWER NEVER REVEALS WHETHER AN ACCOUNT EXISTS. `request()` returns the same message for a
 *   real address, an unknown one and a disabled one, and returns it on the same beat - the email
 *   goes out after the reply rather than before it. An endpoint that says "no such user" is an
 *   account-enumeration oracle anyone can query, and one that merely takes half a second longer to
 *   say nothing is the same oracle read with a stopwatch. This one is unauthenticated by necessity,
 *   so it must survive being asked a million times.
 *
 *   USING IT ENDS EVERY OTHER SESSION. Somebody resetting a password they believe was stolen has
 *   to end the thief's access; leaving those sessions alive would make the reset cosmetic. This is
 *   the same `endSessionsFor` that changing a password from inside the application performs.
 *
 * SINGLE USE AND TIME LIMITED. The row is deleted the moment it is spent, and `email` is the
 * table's primary key, so requesting a second link invalidates the first by construction rather
 * than by a cleanup nobody would remember to run.
 */
@Injectable()
export class PasswordResetService {
  private readonly log = new Logger(PasswordResetService.name);

  /** Long enough to read the email at leisure, short enough that a forwarded one goes stale. */
  static readonly TOKEN_TTL_MINUTES = 60;

  /**
   * The delivery still in flight, exposed so a test can wait for it.
   *
   * `request()` deliberately returns before the email is sent (see the note where it is assigned),
   * which would otherwise make "was the right thing sent" untestable without a sleep.
   */
  lastDelivery: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordHashService,
    /*
     * MAILER RESOLVED LAZILY, NOT INJECTED — the same reason `OtpDeliveryService` does it, recorded
     * there in full. `AuthModule` cannot import `EmailModule`: `EmailModule` already imports
     * `AuthModule` for the guards, and `forwardRef` only moves the cycle, because `EmailModule` also
     * imports `SettingsModule`, which imports `AuthModule` again.
     *
     * `strict: false` asks the application for a provider already constructed elsewhere in the
     * graph. The cost is that a missing mailer is a runtime failure rather than a boot failure —
     * which is why `request()` logs and swallows a send failure instead of throwing into an
     * unauthenticated endpoint.
     */
    private readonly moduleRef: ModuleRef,
  ) {}

  private mailer(): MailerService | null {
    try {
      return this.moduleRef.get(MailerService, { strict: false });
    } catch {
      return null;
    }
  }

  /** 32 random bytes. Not a UUID: this is a credential, and it should be as unguessable as one. */
  static newToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  static hash(token: string): string {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
  }

  /**
   * Compare in constant time, so the number of matching characters cannot be measured.
   *
   * Both sides are fixed-length SHA-256 hex, so a length mismatch means malformed input rather than
   * a near miss — and `timingSafeEqual` throws on unequal lengths, which is why it is checked first.
   */
  static matches(candidateToken: string, storedHash: string): boolean {
    const candidate = Buffer.from(PasswordResetService.hash(candidateToken));
    const stored = Buffer.from(String(storedHash ?? ''));
    if (candidate.length !== stored.length) return false;
    return crypto.timingSafeEqual(candidate, stored);
  }

  static isExpired(createdAt: Date | null | undefined, now = new Date()): boolean {
    if (!createdAt) return true;
    return now.getTime() - createdAt.getTime() > PasswordResetService.TOKEN_TTL_MINUTES * 60_000;
  }

  /**
   * Send a reset link, if that address belongs to an account that may sign in.
   *
   * Returns the same thing regardless — see the enumeration note above. A failure to SEND is logged
   * and swallowed for the same reason: "we could not email you" tells an attacker the address was
   * real, and tells a legitimate user nothing they can act on.
   */
  async request(rawIdentifier: string, frontendUrl: string): Promise<{ message: string }> {
    const answer = {
      message: 'If that account exists, a reset link is on its way to the email address on it. '
        + 'Check the inbox, and the spam folder if it does not arrive shortly.',
    };
    const identifier = String(rawIdentifier ?? '').trim();
    if (!identifier) return answer;

    const user = await this.prisma.users.findFirst({
      /*
       * USERNAME **OR** EMAIL, exactly as signing in accepts either.
       *
       * This looked at `email` alone, and the sign-in form above it asks for a USERNAME — which on
       * this deployment differs from the email on most accounts ("Aswini" against
       * "aswinikuna786@gmail.com"). So the natural thing to type was the one thing that matched
       * nothing, and because the reply deliberately never says whether an account exists, the page
       * reported success and no mail ever came. Somebody locked out is the least likely person to
       * know which of the two a form wants.
       *
       * Case-insensitive on both, because the unique indexes are on `lower(email)` and
       * `lower(username)` — an exact match would miss an account somebody can perfectly well log
       * into.
       *
       * THE LINK STILL GOES TO THE ACCOUNT'S EMAIL, never to what was typed. Accepting a username
       * widens how the account is FOUND; it does not widen where the credential is sent.
       */
      where: {
        OR: [
          { email: { equals: identifier, mode: 'insensitive' } },
          { username: { equals: identifier, mode: 'insensitive' } },
        ],
      },
      select: { id: true, name: true, email: true, status: true },
    });

    // A disabled account is deliberately treated exactly like a missing one — no link, same answer.
    if (!user || user.status !== 'Active') return answer;

    const token = PasswordResetService.newToken();
    const now = new Date();
    await this.prisma.password_reset_tokens.upsert({
      // `email` is the primary key, so an upsert is what makes a new request replace the old link
      // rather than leaving two valid ones alive.
      where: { email: user.email },
      create: { email: user.email, token: PasswordResetService.hash(token), created_at: now },
      update: { token: PasswordResetService.hash(token), created_at: now },
    });

    const link = `${String(frontendUrl).replace(/\/+$/, '')}/reset-password`
      + `?token=${encodeURIComponent(token)}&email=${encodeURIComponent(user.email)}`;

    /*
     * THE SEND IS NOT AWAITED, and that is the enumeration defence rather than a speed tweak.
     *
     * Returning only once the SMTP round trip finished made the reply take 412ms for an account
     * that exists and 0ms for one that does not - measured, not supposed. The message was identical
     * either way, so nothing was DISCLOSED, but a stopwatch answered the question the wording
     * refuses to: anybody could have tested an address list against this endpoint and learned who
     * banks with the brokerage. Handing the work off means both paths return on the same beat.
     *
     * THE TOKEN ROW IS STILL WRITTEN SYNCHRONOUSLY above, because the link must not be able to
     * arrive before the row it depends on exists.
     *
     * WHAT REMAINS is the cost of that one write, a few milliseconds against an unknown address's
     * none. It is not constant time, and this comment should not pretend otherwise - but it sits
     * inside ordinary network jitter, where the SMTP round trip stood a hundredfold clear of it.
     *
     * `.catch()` IS LOAD-BEARING: an unawaited rejection would otherwise take the process down on
     * a mail outage, which is precisely when somebody needs to get back into their account.
     */
    this.lastDelivery = (async () => {
      const mailer = this.mailer();
      if (!mailer) throw new Error('No mailer is available in this process.');
      await mailer.sendDirect(user.email, 'Reset your password', this.body(user.name, link));
    })().catch((err) => {
      this.log.error(`Could not send a password reset to user #${user.id}: ${err instanceof Error ? err.message : String(err)}`);
    });

    return answer;
  }

  /**
   * Spend the token and set the new password.
   *
   * Deliberately vague on failure: expired, wrong, and never-issued all produce one message. Telling
   * them apart would let somebody probe which addresses have a reset pending.
   */
  async reset(
    rawEmail: string, token: string, password: string, confirmation: string,
    endSessionsFor: (userId: number) => Promise<unknown>,
  ): Promise<{ message: string }> {
    const invalid = (): never => throwValidation({
      token: ['That reset link is invalid or has expired. Request a new one from the sign-in page.'],
    });

    const email = String(rawEmail ?? '').trim();
    const row = email
      ? await this.prisma.password_reset_tokens.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } })
      : null;
    if (!row || !token) invalid();

    if (!PasswordResetService.matches(token, row!.token)) invalid();
    if (PasswordResetService.isExpired(row!.created_at)) {
      // Cleared on sight: an expired row is not a credential and should not sit in the table.
      await this.prisma.password_reset_tokens.delete({ where: { email: row!.email } }).catch(() => undefined);
      invalid();
    }

    const user = await this.prisma.users.findFirst({
      where: { email: { equals: row!.email, mode: 'insensitive' } },
      select: { id: true, status: true },
    });
    if (!user || user.status !== 'Active') invalid();

    if (password !== confirmation) {
      throwValidation({ password: ['The password field confirmation does not match.'] });
    }
    if (!this.passwords.fits(password)) {
      throwValidation({
        password: [
          `The password must not be longer than ${PasswordHashService.MAX_PASSWORD_BYTES} bytes — `
          + 'anything past that is ignored when it is stored, so it would not really be part of your password.',
        ],
      });
    }

    await this.prisma.users.update({
      where: { id: user!.id },
      data: { password: await this.passwords.hashPassword(password), updated_at: new Date() },
    });
    // SINGLE USE. Deleted before the sessions are ended so that a failure there cannot leave a
    // spent token usable a second time.
    await this.prisma.password_reset_tokens.delete({ where: { email: row!.email } }).catch(() => undefined);
    await endSessionsFor(user!.id);

    this.log.log(`Password reset completed for user #${user!.id}.`);
    return { message: 'Your password has been reset. Sign in with your new password.' };
  }

  /**
   * Plain, personal, and one link.
   *
   * No branding, no images, no tracking: this is a security message, and the recipient has to be
   * able to tell it from the phishing mail that imitates it. It is also the one email where a
   * marketing-shaped layout would actively teach people the wrong habit.
   */
  private body(name: string | null, link: string): string {
    const who = String(name ?? '').trim().split(/\s+/)[0] || 'there';
    return `<p>Hi ${this.escape(who)},</p>`
      + '<p>Somebody asked to reset the password on your Get Home Realty account. '
      + `Use the link below within ${PasswordResetService.TOKEN_TTL_MINUTES} minutes:</p>`
      + `<p><a href="${link}">Reset your password</a></p>`
      + '<p>If that was not you, you can ignore this email — your password has not changed, and '
      + 'the link stops working on its own.</p>';
  }

  private escape(s: string): string {
    return s.replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
    ));
  }
}
