import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { randomInt } from 'node:crypto';
import { MailerService } from '../../email/mailer.service';
import { TwilioService } from '../../sms/twilio.service';

/**
 * WHY MAILER AND TWILIO ARE RESOLVED LAZILY RATHER THAN INJECTED.
 *
 * The obvious wiring — `AuthModule` imports `EmailModule` and `SmsModule` — does not work here, and
 * it is worth recording why so nobody spends the afternoon rediscovering it. Both of those modules
 * already import `AuthModule` for the auth guards, so importing them back closes a cycle. Wrapping
 * both ends in `forwardRef` moves the failure rather than fixing it: `EmailModule` also imports
 * `SettingsModule`, which imports `AuthModule` in turn, so the cycle simply reappears one level
 * further out. Measured, not predicted — the application refused to boot at each step.
 *
 * Resolving through `ModuleRef` with `strict: false` asks the application for a provider that is
 * already constructed somewhere in the graph, which is exactly what these are. It keeps this feature
 * from reshaping the module graph of three unrelated modules to send a text message.
 *
 * The cost is that a missing provider becomes a runtime failure rather than a boot failure, so both
 * providers log loudly and report the code as undelivered rather than throwing into the sign-in
 * path. `e2e/tests/mfa.spec.ts` asserts that `GET /api/mfa` reports `email` among its available
 * channels against a running application, which is what proves the lookup really resolves.
 */

export type OtpChannel = 'email' | 'sms';

export interface OtpDeliveryResult {
  /** Whether the code left this application. False means nothing was sent and nobody will receive one. */
  delivered: boolean;
  /** Why not, for the audit trail and the log. Never shown to the person signing in — see below. */
  reason?: string;
}

/**
 * A channel that can carry a one-time code.
 *
 * The abstraction exists so a third channel — a push notification, an authenticator callback, a
 * different SMS vendor — is a new class rather than another branch in the middle of the sign-in
 * path. Each provider answers two questions: can it deliver at all right now, and where would it
 * deliver to.
 */
export interface OtpProvider {
  readonly channel: OtpChannel;
  /** Whether this channel is configured. An unconfigured channel must not be offered for enrolment. */
  available(): boolean;
  /** The masked form shown in the interface — never the full address or number. */
  mask(destination: string): string;
  /** Whether a destination is plausibly addressable by this channel. */
  validDestination(destination: string): boolean;
  send(destination: string, code: string, expiresInMinutes: number): Promise<OtpDeliveryResult>;
}

/** Six digits, uniformly distributed. */
export function generateOtp(digits = 6): string {
  const max = 10 ** digits;
  // `randomInt` is rejection-sampled by node, so this has none of the modulo bias that
  // `randomBytes(4).readUInt32BE() % 1000000` quietly introduces.
  return String(randomInt(0, max)).padStart(digits, '0');
}

@Injectable()
export class EmailOtpProvider implements OtpProvider {
  readonly channel = 'email' as const;
  private readonly log = new Logger(EmailOtpProvider.name);

  constructor(private readonly moduleRef: ModuleRef) {}

  /** The mailer, fetched from the application graph on first use. Null if it is not there. */
  private mailer(): MailerService | null {
    try {
      return this.moduleRef.get(MailerService, { strict: false });
    } catch {
      this.log.error('MailerService could not be resolved — two-factor codes cannot be emailed.');
      return null;
    }
  }

  available(): boolean {
    // Mail is configured per brokerage and always present in this deployment; the mailer resolves a
    // sender itself and throws if it cannot, which `send` reports rather than propagates.
    return this.mailer() !== null;
  }

  validDestination(destination: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(destination ?? '').trim());
  }

  /** `p****a@brokerage.ca` — enough to recognise your own address, not enough to learn someone's. */
  mask(destination: string): string {
    const [local, domain] = String(destination ?? '').split('@');
    if (!domain) return '•••';
    const head = local.slice(0, 1);
    const tail = local.length > 2 ? local.slice(-1) : '';
    return `${head}${'•'.repeat(Math.max(1, local.length - head.length - tail.length))}${tail}@${domain}`;
  }

  async send(destination: string, code: string, expiresInMinutes: number): Promise<OtpDeliveryResult> {
    const subject = `${code} is your sign-in code`;
    /*
     * The code is in the SUBJECT as well as the body, deliberately: it is what makes the message
     * usable from a lock-screen notification without opening the mailbox, and every service that
     * sends these does it. It is not a leak — anyone who can read the subject can read the body.
     */
    const html = `
      <p>Your sign-in code is:</p>
      <p style="font-size:28px;font-weight:700;letter-spacing:4px;margin:16px 0">${code}</p>
      <p>It expires in ${expiresInMinutes} minutes and can be used once.</p>
      <p style="color:#666">If you did not try to sign in, your password may be known to someone else.
      Change it, and tell an administrator.</p>
    `;
    const mailer = this.mailer();
    if (!mailer) return { delivered: false, reason: 'mailer_unavailable' };
    try {
      await mailer.sendDirect(destination, subject, html);
      return { delivered: true };
    } catch (err) {
      this.log.warn(`Could not email a sign-in code: ${(err as Error).message}`);
      return { delivered: false, reason: 'email_failed' };
    }
  }
}

@Injectable()
export class SmsOtpProvider implements OtpProvider {
  readonly channel = 'sms' as const;
  private readonly log = new Logger(SmsOtpProvider.name);

  constructor(private readonly moduleRef: ModuleRef) {}

  /** The SMS gateway, fetched from the application graph on first use. Null if it is not there. */
  private twilio(): TwilioService | null {
    try {
      return this.moduleRef.get(TwilioService, { strict: false });
    } catch {
      this.log.error('TwilioService could not be resolved — two-factor codes cannot be texted.');
      return null;
    }
  }

  available(): boolean {
    // Both halves matter: the provider has to exist AND the gateway has to be configured. Offering
    // SMS enrolment on a deployment with no Twilio credentials would let somebody lock their account
    // behind a factor that can never be delivered.
    return this.twilio()?.configured() === true;
  }

  validDestination(destination: string): boolean {
    // Deliberately loose. Numbers arrive as `416-555-0100`, `+1 416 555 0100` or `(416) 555-0100`,
    // and Twilio is the authority on what it can actually reach — this only rejects what is plainly
    // not a number at all.
    const digits = String(destination ?? '').replace(/\D/g, '');
    return digits.length >= 10 && digits.length <= 15;
  }

  /** `•••-•••-0100` — the last four, which is what a person recognises their own number by. */
  mask(destination: string): string {
    const digits = String(destination ?? '').replace(/\D/g, '');
    if (digits.length < 4) return '•••';
    return `•••-•••-${digits.slice(-4)}`;
  }

  async send(destination: string, code: string, expiresInMinutes: number): Promise<OtpDeliveryResult> {
    const body = `${code} is your sign-in code. It expires in ${expiresInMinutes} minutes. `
      + 'If you did not try to sign in, change your password.';
    const twilio = this.twilio();
    if (!twilio) return { delivered: false, reason: 'sms_unavailable' };
    try {
      /*
       * `TwilioService.send` THROWS a BadRequestException on every failure — an unconfigured
       * gateway, an unreachable API, a Twilio error code, or a response with no message id — and
       * only ever returns on success. So the catch below is the whole of the failure handling, and
       * a returned value needs no further checking. (Checked against the implementation rather than
       * assumed: an earlier draft here tested `result.sid` for a falsy value that can never occur.)
       */
      const { sid } = await twilio.send(destination, body);
      this.log.log(`Sign-in code sent by SMS (${sid}).`);
      return { delivered: true };
    } catch (err) {
      this.log.warn(`Could not text a sign-in code: ${(err as Error).message}`);
      return { delivered: false, reason: 'sms_failed' };
    }
  }
}

/**
 * The registry the rest of the module talks to.
 *
 * WHY A DELIVERY FAILURE IS NOT REPORTED TO THE PERSON SIGNING IN. `dispatch` returns the result so
 * the caller can log and audit it, but the sign-in response says the same thing either way. Telling
 * an unauthenticated caller "that number is unreachable" or "no code was sent" turns the challenge
 * into an oracle for which accounts exist and which have a working second factor. The person who
 * genuinely did not receive a code has a Resend button, and the failure is in the log for whoever
 * has to explain it.
 */
@Injectable()
export class OtpDeliveryService {
  private readonly providers: Record<OtpChannel, OtpProvider>;

  constructor(email: EmailOtpProvider, sms: SmsOtpProvider) {
    this.providers = { email, sms };
  }

  provider(channel: OtpChannel): OtpProvider {
    const found = this.providers[channel];
    if (!found) throw new Error(`No provider for the "${channel}" channel.`);
    return found;
  }

  /** The channels that are configured well enough to be offered for enrolment. */
  availableChannels(): OtpChannel[] {
    return (Object.keys(this.providers) as OtpChannel[]).filter((c) => this.providers[c].available());
  }

  mask(channel: OtpChannel, destination: string): string {
    return this.provider(channel).mask(destination);
  }

  async dispatch(
    channel: OtpChannel,
    destination: string,
    code: string,
    expiresInMinutes: number,
  ): Promise<OtpDeliveryResult> {
    const provider = this.provider(channel);
    if (!provider.available()) return { delivered: false, reason: `${channel}_not_configured` };
    return provider.send(destination, code, expiresInMinutes);
  }
}
