import { BadRequestException, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { throwValidation } from '../../common/laravel-exceptions';
import { PasswordHashService } from '../password-hash.service';
import type { AuthUserRecord } from '../auth.types';
import { RecoveryCodeService } from './recovery-code.service';
import { TrustedDeviceService } from './trusted-device.service';
import { OtpDeliveryService, generateOtp, type OtpChannel } from './otp-delivery.service';
import {
  MfaKeyMissingError,
  decryptSecret,
  encryptSecret,
  hashOneTimeValue,
  mfaStorageAvailable,
} from './mfa-crypto';
import {
  base32Decode,
  formatSecretForDisplay,
  generateSecret,
  otpauthUri,
  verifyTotp,
} from './totp';

export type MfaType = 'totp' | 'email' | 'sms';

export interface MfaMethodView {
  type: MfaType;
  /** Masked for email/sms; null for totp, which has no destination. */
  destination: string | null;
  confirmed: boolean;
  last_used_at: Date | null;
  created_at: Date;
}

/** What the challenge screen needs to render itself, and nothing more. */
export interface MfaChallengeView {
  methods: Array<{ type: MfaType; destination: string | null }>;
  /** The one to try first — a TOTP app if there is one, because it needs no delivery. */
  preferred: MfaType;
  recovery_available: boolean;
}

const AUDIT_CATEGORY = 'Security';

/**
 * Two-factor authentication.
 *
 * WHAT THE THREAT MODEL IS. A password alone is one secret, and this application's passwords are
 * created by administrators, typed into a browser, and often reused elsewhere. A second factor makes
 * a stolen or guessed password insufficient on its own. That is the whole of the goal: it does not
 * defend against a compromised server, and it is not a substitute for the lockout and hashing work
 * in Phases 1 and 2 — it sits on top of both.
 *
 * EVERY READ HAPPENS BEFORE THE CALLER IS SIGNED IN. These tables are consulted DURING the login
 * challenge, so none of them may depend on an authenticated session existing. Every row is bounded
 * by `user_id` instead, which is what actually decides whose factor is being checked.
 */
@Injectable()
export class MfaService {
  private readonly log = new Logger(MfaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly recovery: RecoveryCodeService,
    private readonly devices: TrustedDeviceService,
    private readonly delivery: OtpDeliveryService,
    private readonly passwords: PasswordHashService,
    private readonly audit: AuditService,
  ) {}

  /** How long an emailed or texted code lives. Long enough for slow mail, short enough to matter. */
  static readonly OTP_TTL_MINUTES = 10;
  /** Guesses allowed against one issued code before it is burnt. */
  static readonly OTP_MAX_ATTEMPTS = 5;

  // ========================================================================== state

  /** Every method this person holds, confirmed or not. */
  async methodsFor(userId: number): Promise<MfaMethodView[]> {
    const rows = await this.prisma.user_mfa_methods.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'asc' },
    });
    return rows.map((r) => ({
      type: r.type as MfaType,
      destination: r.destination ? this.delivery.mask(r.type as OtpChannel, r.destination) : null,
      confirmed: r.confirmed_at !== null,
      last_used_at: r.last_used_at,
      created_at: r.created_at,
    }));
  }

  /**
   * The confirmed methods — the only ones that count.
   *
   * An unconfirmed row must never satisfy a challenge. Otherwise merely STARTING enrolment would be
   * enough to be challenged for a factor nobody can produce, which locks the account rather than
   * protecting it.
   */
  async activeMethods(userId: number): Promise<Array<{ type: MfaType; destination: string | null }>> {
    const rows = await this.prisma.user_mfa_methods.findMany({
      where: { user_id: userId, confirmed_at: { not: null } },
      select: { type: true, destination: true },
      orderBy: { created_at: 'asc' },
    });
    return rows.map((r) => ({ type: r.type as MfaType, destination: r.destination }));
  }

  async isEnabled(userId: number): Promise<boolean> {
    return (await this.activeMethods(userId)).length > 0;
  }

  /** What the challenge screen renders. TOTP is preferred because it needs no delivery to work. */
  async challengeView(userId: number): Promise<MfaChallengeView> {
    const active = await this.activeMethods(userId);
    return {
      methods: active.map((m) => ({
        type: m.type,
        destination: m.destination ? this.delivery.mask(m.type as OtpChannel, m.destination) : null,
      })),
      preferred: active.find((m) => m.type === 'totp')?.type ?? active[0]?.type ?? 'totp',
      recovery_available: (await this.recovery.remaining(userId)) > 0,
    };
  }

  // ========================================================================== enrolment

  /**
   * Begin TOTP enrolment: mint a secret, store it UNCONFIRMED, and return what the app needs to
   * scan it.
   *
   * The secret is returned exactly once, here. After confirmation it is never sent to a browser
   * again — there is no endpoint that reads it back, because a "show me my secret" feature would let
   * anyone with a live session clone the second factor they are supposedly being asked for.
   */
  async beginTotpEnrolment(user: AuthUserRecord, issuer: string): Promise<{
    secret: string; secret_display: string; uri: string;
  }> {
    if (!mfaStorageAvailable()) {
      // Refused rather than stored readably. A TOTP secret in plain text is a permanent bypass for
      // anyone who can read the database, a backup, or a replica.
      throw new BadRequestException({ message: new MfaKeyMissingError().message });
    }

    const secret = generateSecret();
    const now = new Date();
    await this.prisma.user_mfa_methods.upsert({
      where: { user_id_type: { user_id: user.id, type: 'totp' } },
      // Re-enrolling replaces the pending secret and clears any previous confirmation, so a half
      // finished attempt cannot leave an old secret working.
      update: { secret: encryptSecret(secret), confirmed_at: null, last_step: null, updated_at: now },
      create: {
        user_id: user.id, type: 'totp', secret: encryptSecret(secret),
        created_at: now, updated_at: now,
      },
    });

    return {
      secret,
      secret_display: formatSecretForDisplay(secret),
      uri: otpauthUri({ issuer, account: user.email, secret }),
    };
  }

  /**
   * Confirm TOTP enrolment with a code from the app, and issue recovery codes.
   *
   * The codes are returned here, at the one moment the person is looking at a screen that can show
   * them, and never again.
   */
  async confirmTotpEnrolment(user: AuthUserRecord, code: string): Promise<{ recovery_codes: string[] }> {
    const row = await this.prisma.user_mfa_methods.findUnique({
      where: { user_id_type: { user_id: user.id, type: 'totp' } },
    });
    if (!row?.secret) throwValidation({ code: ['Start setting up your authenticator app first.'] });

    const secret = decryptSecret(row.secret);
    if (!secret) {
      // APP_KEY rotated, or a tampered row. Re-enrol rather than fail forever.
      throwValidation({ code: ['This setup can no longer be read. Start again.'] });
    }

    const result = verifyTotp(base32Decode(secret), code);
    if (!result.valid) throwValidation({ code: ['That code is not right. Check the app and try again.'] });

    const now = new Date();
    await this.prisma.user_mfa_methods.update({
      where: { id: row.id },
      data: { confirmed_at: now, last_step: BigInt(result.step), last_used_at: now, updated_at: now },
    });

    const codes = await this.recovery.issue(user.id);
    await this.auditEvent(user, 'Two-factor authentication enabled', 'Authenticator app');
    return { recovery_codes: codes };
  }

  /**
   * Begin email or SMS enrolment: store the destination unconfirmed and send a code to it.
   *
   * Sending to the destination is the point — it proves the address or number is reachable BY THIS
   * PERSON before it becomes something their account depends on. An unreachable second factor is
   * indistinguishable from a lost one.
   */
  async beginOtpEnrolment(user: AuthUserRecord, channel: OtpChannel, destination: string): Promise<{ masked: string }> {
    const provider = this.delivery.provider(channel);
    if (!provider.available()) {
      throwValidation({ destination: [`${channel === 'sms' ? 'Text messaging' : 'Email'} is not set up on this system.`] });
    }
    const cleaned = String(destination ?? '').trim();
    if (!provider.validDestination(cleaned)) {
      throwValidation({ destination: [channel === 'sms' ? 'Enter a valid mobile number.' : 'Enter a valid email address.'] });
    }

    const now = new Date();
    await this.prisma.user_mfa_methods.upsert({
      where: { user_id_type: { user_id: user.id, type: channel } },
      update: { destination: cleaned, confirmed_at: null, updated_at: now },
      create: {
        user_id: user.id, type: channel, destination: cleaned,
        created_at: now, updated_at: now,
      },
    });

    await this.issueOtp(user.id, channel, cleaned);
    return { masked: provider.mask(cleaned) };
  }

  /** Confirm email/SMS enrolment with the code that was sent, and issue recovery codes. */
  async confirmOtpEnrolment(user: AuthUserRecord, channel: OtpChannel, code: string): Promise<{ recovery_codes: string[] }> {
    if (!(await this.consumeOtp(user.id, channel, code))) {
      throwValidation({ code: ['That code is not right, or it has expired.'] });
    }

    const now = new Date();
    await this.prisma.user_mfa_methods.updateMany({
      where: { user_id: user.id, type: channel },
      data: { confirmed_at: now, last_used_at: now, updated_at: now },
    });

    const codes = await this.recovery.issue(user.id);
    await this.auditEvent(user, 'Two-factor authentication enabled', channel === 'sms' ? 'Text message' : 'Email');
    return { recovery_codes: codes };
  }

  /**
   * Remove a method. Requires the account password.
   *
   * WHY THE PASSWORD IS REQUIRED TO TURN IT OFF. Without it, a session borrowed for thirty seconds
   * at an unlocked desk is enough to strip the second factor off an account — and the whole point of
   * the factor is that a session or a password alone should not be enough for something this
   * consequential. It is the same reason the change-password screen asks for the current one.
   */
  async removeMethod(user: AuthUserRecord, type: MfaType, password: string): Promise<void> {
    await this.assertPassword(user, password);

    const deleted = await this.prisma.user_mfa_methods.deleteMany({
      where: { user_id: user.id, type },
    });
    if (deleted.count === 0) throwValidation({ type: ['That method is not set up.'] });

    // Trusted devices were trusted BECAUSE a factor was held. Changing the factors invalidates that.
    await this.devices.revokeAll(user.id);

    // The last factor going means recovery codes have nothing left to recover.
    if (!(await this.isEnabled(user.id))) await this.recovery.revokeAll(user.id);

    await this.auditEvent(user, 'Two-factor method removed', this.label(type));
  }

  /** Fresh recovery codes, replacing every old one. Requires the password, for the same reason. */
  async regenerateRecoveryCodes(user: AuthUserRecord, password: string): Promise<string[]> {
    await this.assertPassword(user, password);
    const codes = await this.recovery.issue(user.id);
    await this.auditEvent(user, 'Recovery codes regenerated', null);
    return codes;
  }

  // ========================================================================== the challenge

  /**
   * Send a fresh code for a challenge or an enrolment.
   *
   * Returns nothing about whether delivery succeeded — see `OtpDeliveryService` for why. The caller
   * is not told, because the caller may not be who they say they are yet.
   */
  async sendChallengeCode(userId: number, channel: OtpChannel): Promise<void> {
    const row = await this.prisma.user_mfa_methods.findUnique({
      where: { user_id_type: { user_id: userId, type: channel } },
      select: { destination: true, confirmed_at: true },
    });
    // Silently does nothing for a method that is not set up: answering differently would tell an
    // unauthenticated caller which factors an account holds.
    if (!row?.destination || !row.confirmed_at) return;
    await this.issueOtp(userId, channel, row.destination);
  }

  /**
   * Answer a challenge. Returns true only on a genuine match.
   *
   * Accepts a TOTP code, an emailed/texted code, or a recovery code — the caller says which. A
   * recovery code is tried against the recovery table and nothing else, so a TOTP code can never be
   * spent as a recovery code or the reverse.
   */
  async verifyChallenge(
    userId: number,
    method: MfaType | 'recovery',
    code: string,
    ip: string | null,
  ): Promise<boolean> {
    if (method === 'recovery') return this.recovery.redeem(userId, code, ip);
    if (method === 'totp') return this.verifyTotpFor(userId, code);
    return this.consumeOtp(userId, method, code);
  }

  /**
   * TOTP verification, with replay refused.
   *
   * THE `last_step` CHECK IS THE POINT. A TOTP code is valid for its whole step and the window
   * either side — about 90 seconds — so without this, a code observed over a shoulder, left in a
   * screenshot, or captured by a phishing proxy can be replayed by somebody else inside that window.
   * Recording the step that was accepted and refusing anything at or below it is what makes a code
   * genuinely single-use. RFC 6238 leaves this to the implementer and it is the part most often left
   * out.
   */
  private async verifyTotpFor(userId: number, code: string): Promise<boolean> {
    const row = await this.prisma.user_mfa_methods.findUnique({
      where: { user_id_type: { user_id: userId, type: 'totp' } },
    });
    if (!row?.secret || !row.confirmed_at) return false;

    const secret = decryptSecret(row.secret);
    if (!secret) {
      this.log.warn(`The stored TOTP secret for user #${userId} could not be decrypted.`);
      return false;
    }

    const result = verifyTotp(base32Decode(secret), code);
    if (!result.valid) return false;
    if (row.last_step !== null && BigInt(result.step) <= row.last_step) {
      this.log.warn(`Refused a replayed TOTP code for user #${userId} (step ${result.step}).`);
      return false;
    }

    const now = new Date();
    await this.prisma.user_mfa_methods.update({
      where: { id: row.id },
      data: { last_step: BigInt(result.step), last_used_at: now, updated_at: now },
    });
    return true;
  }

  /** Issue and send a one-time code, replacing any outstanding one for the same channel. */
  private async issueOtp(userId: number, channel: OtpChannel, destination: string): Promise<void> {
    const code = generateOtp();
    const now = new Date();

    // Only one live code per channel. Leaving older ones valid would multiply the guessing surface
    // every time somebody pressed Resend.
    await this.prisma.mfa_challenges.updateMany({
      where: { user_id: userId, method: channel, consumed_at: null },
      data: { consumed_at: now },
    });
    await this.prisma.mfa_challenges.create({
      data: {
        user_id: userId,
        method: channel,
        code_hash: hashOneTimeValue(code),
        expires_at: new Date(now.getTime() + MfaService.OTP_TTL_MINUTES * 60 * 1000),
        created_at: now,
      },
    });

    const result = await this.delivery.dispatch(channel, destination, code, MfaService.OTP_TTL_MINUTES);
    if (!result.delivered) {
      this.log.warn(`A sign-in code for user #${userId} could not be delivered by ${channel}: ${result.reason}`);
    }
  }

  /**
   * Check and burn a one-time code.
   *
   * ATTEMPTS ARE COUNTED PER CODE. Six digits is a million possibilities, which is not many at HTTP
   * speed — the per-account lockout bounds sign-in attempts, but a challenge lives inside one
   * already-authenticated-by-password session and needs its own ceiling. Five wrong guesses burns
   * the code and a new one must be sent.
   */
  private async consumeOtp(userId: number, channel: OtpChannel, code: string): Promise<boolean> {
    const now = new Date();
    const challenge = await this.prisma.mfa_challenges.findFirst({
      where: { user_id: userId, method: channel, consumed_at: null, expires_at: { gt: now } },
      orderBy: { created_at: 'desc' },
    });
    if (!challenge) return false;

    if (challenge.attempts >= MfaService.OTP_MAX_ATTEMPTS) {
      await this.prisma.mfa_challenges.update({
        where: { id: challenge.id }, data: { consumed_at: now },
      });
      throw new HttpException(
        { message: 'Too many wrong codes. Ask for a new one.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (challenge.code_hash !== hashOneTimeValue(code)) {
      await this.prisma.mfa_challenges.update({
        where: { id: challenge.id }, data: { attempts: { increment: 1 } },
      });
      return false;
    }

    // Consuming is filtered on `consumed_at: null`, so two simultaneous correct submissions cannot
    // both succeed — the second updates nothing.
    const spent = await this.prisma.mfa_challenges.updateMany({
      where: { id: challenge.id, consumed_at: null },
      data: { consumed_at: now },
    });
    return spent.count > 0;
  }

  // ========================================================================== administration

  /**
   * An administrator clears somebody's two-factor entirely.
   *
   * THIS IS A DANGEROUS OPERATION AND IS TREATED AS ONE. It exists because people lose phones and
   * run out of recovery codes, and without it those accounts are unreachable forever. But it is also
   * exactly the operation an attacker who reaches an administrator account would use, so: it is
   * audited by name, it revokes every trusted device, and it destroys the recovery codes rather than
   * leaving old ones valid.
   *
   * It deliberately does NOT re-enrol anything. The person is returned to having no second factor and
   * must set one up again, which is the only state this application can be sure about.
   */
  async adminReset(actor: AuthUserRecord, targetUserId: number): Promise<void> {
    const target = await this.prisma.users.findUnique({
      where: { id: targetUserId },
      select: { id: true, name: true, email: true },
    });
    if (!target) throwValidation({ user: ['That user does not exist.'] });

    await this.prisma.user_mfa_methods.deleteMany({ where: { user_id: targetUserId } });
    await this.prisma.mfa_challenges.deleteMany({ where: { user_id: targetUserId } });
    await this.recovery.revokeAll(targetUserId);
    await this.devices.revokeAll(targetUserId);

    await this.audit.logModule(
      { id: actor.id, name: actor.name },
      AUDIT_CATEGORY,
      {
        section: 'Two-factor authentication',
        field: target.email,
        action: 'Reset',
        details: `${actor.name} cleared two-factor authentication for ${target.name} (${target.email}).`,
      },
    );
    this.log.warn(`User #${actor.id} reset two-factor authentication for user #${targetUserId}.`);
  }

  // ========================================================================== helpers

  /** Verify the account password, counting nothing toward the sign-in lockout. */
  private async assertPassword(user: AuthUserRecord, password: string): Promise<void> {
    if (!password || !(await this.passwords.verifyPassword(password, user.password))) {
      throwValidation({ password: ['That password is not right.'] });
    }
  }

  private label(type: MfaType): string {
    return type === 'totp' ? 'Authenticator app' : type === 'sms' ? 'Text message' : 'Email';
  }

  private async auditEvent(user: AuthUserRecord, action: string, detail: string | null): Promise<void> {
    try {
      await this.audit.logModule(
        { id: user.id, name: user.name },
        AUDIT_CATEGORY,
        {
          section: 'Two-factor authentication',
          field: user.email,
          action,
          details: detail ? `${action} — ${detail}.` : `${action}.`,
        },
      );
    } catch (err) {
      // The audit trail must not be able to fail somebody's security change.
      this.log.warn(`Could not record a two-factor audit entry: ${(err as Error).message}`);
    }
  }

  /** Whether this request's browser may skip the challenge. */
  async deviceIsTrusted(req: Request, userId: number): Promise<boolean> {
    return this.devices.isTrusted(req, userId);
  }
}
