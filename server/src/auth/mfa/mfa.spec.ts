import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuthUserRecord } from '../auth.types';
import { PasswordHashService } from '../password-hash.service';
import { MfaService } from './mfa.service';
import { MfaPolicyService } from './mfa-policy.service';
import { RecoveryCodeService } from './recovery-code.service';
import { TrustedDeviceService } from './trusted-device.service';
import { EmailOtpProvider, OtpDeliveryService, SmsOtpProvider, type OtpProvider } from './otp-delivery.service';
import { base32Decode, totp } from './totp';
import { decryptSecret, hashOneTimeValue } from './mfa-crypto';

/**
 * PHASE 3 — two-factor authentication against real rows.
 *
 * The TOTP arithmetic is proved against the RFCs in `totp.spec.ts` and the storage in
 * `mfa-crypto.spec.ts`. This file is about the things only real state can show: that an unconfirmed
 * factor cannot satisfy a challenge, that a code cannot be used twice, that a recovery code is spent
 * exactly once, that removing a factor costs a password, and that an administrator's reset really
 * does clear everything.
 */

const KEY = 'base64:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const originalKey = process.env.APP_KEY;
process.env.APP_KEY = KEY;

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
const tag = (): string => `${Date.now()}-${(seq += 1)}`;

afterAll(async () => {
  await prisma.$disconnect();
  if (originalKey === undefined) delete process.env.APP_KEY;
  else process.env.APP_KEY = originalKey;
});

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

/** Records what was "sent", so a test can read the code the way a person reads their inbox. */
class CapturingProvider implements OtpProvider {
  readonly sent: Array<{ destination: string; code: string }> = [];
  constructor(readonly channel: 'email' | 'sms', private readonly enabled = true) {}
  available(): boolean { return this.enabled; }
  validDestination(): boolean { return true; }
  mask(d: string): string { return `masked:${d}`; }
  async send(destination: string, code: string) { this.sent.push({ destination, code }); return { delivered: true }; }
}

function build(tx: PrismaService, opts: { emailUp?: boolean; smsUp?: boolean } = {}) {
  const email = new CapturingProvider('email', opts.emailUp ?? true);
  const sms = new CapturingProvider('sms', opts.smsUp ?? true);
  const delivery = new OtpDeliveryService(email as never, sms as never);
  const recovery = new RecoveryCodeService(tx);
  const devices = new TrustedDeviceService(tx, { get: () => ({ secure: false, sameSite: 'lax' }) } as unknown as ConfigService);
  const audit = { logModule: async () => {}, record: async () => {} } as never;
  const passwords = new PasswordHashService({ get: () => 4 } as unknown as ConfigService);
  const mfa = new MfaService(tx, recovery, devices, delivery, passwords, audit);
  return { mfa, recovery, devices, delivery, email, sms, passwords };
}

const PASSWORD = 'CorrectPassw0rd!';

async function makeUser(tx: PrismaService, overrides: Record<string, unknown> = {}): Promise<AuthUserRecord> {
  const now = new Date();
  const t = tag();
  const hasher = new PasswordHashService({ get: () => 4 } as unknown as ConfigService);
  const row = await tx.users.create({
    data: {
      name: `ZZ Mfa ${t}`, email: `zz-mfa-${t}@probe.test`, username: `zzmfa${t.replace(/-/g, '')}`,
      role: 'agent', status: 'Active', password: await hasher.hashPassword(PASSWORD),
      created_at: now, updated_at: now, ...overrides,
    },
  });
  return { ...row, user_permissions: [] } as AuthUserRecord;
}

/** A request-like object carrying only what the trusted-device code reads. */
const reqWith = (cookie?: string) => ({
  headers: cookie ? { cookie: `mfa_device=${cookie}`, 'user-agent': 'Jest' } : { 'user-agent': 'Jest' },
  ip: '127.0.0.1',
}) as never;

/** Captures `res.cookie(...)` so a test can read the token that was issued. */
function fakeRes() {
  const cookies: Record<string, string> = {};
  return {
    cookies,
    cookie: (name: string, value: string) => { cookies[name] = value; },
    clearCookie: (name: string) => { delete cookies[name]; },
  } as never as { cookies: Record<string, string> } & Record<string, unknown>;
}

// ============================================================================ TOTP enrolment
describe('enrolling an authenticator app', () => {
  it('stores the secret ENCRYPTED, never in clear text', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { mfa } = build(tx);

      const { secret } = await mfa.beginTotpEnrolment(user, 'Get Home Realty');

      const row = await tx.user_mfa_methods.findFirst({ where: { user_id: user.id, type: 'totp' } });
      expect(row!.secret).not.toContain(secret);
      expect(row!.secret!.startsWith('mfa:v1:')).toBe(true);
      expect(decryptSecret(row!.secret)).toBe(secret);
    });
  });

  it('does not count as enabled until it is CONFIRMED', async () => {
    /*
     * THE ONE THAT MATTERS MOST HERE. If a half-finished enrolment counted, then merely opening the
     * setup screen and walking away would start challenging the account for a code nobody can
     * produce — locking somebody out by doing nothing. Starting enrolment must never weaken an
     * account, only finishing it may strengthen one.
     */
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { mfa } = build(tx);

      await mfa.beginTotpEnrolment(user, 'Issuer');
      expect(await mfa.isEnabled(user.id)).toBe(false);
      expect(await mfa.activeMethods(user.id)).toEqual([]);
    });
  });

  it('confirms with a real code and issues recovery codes', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { mfa, recovery } = build(tx);

      const { secret } = await mfa.beginTotpEnrolment(user, 'Issuer');
      const { recovery_codes } = await mfa.confirmTotpEnrolment(user, totp(base32Decode(secret)));

      expect(await mfa.isEnabled(user.id)).toBe(true);
      expect(recovery_codes).toHaveLength(RecoveryCodeService.COUNT);
      expect(await recovery.remaining(user.id)).toBe(RecoveryCodeService.COUNT);
    });
  });

  it('refuses a wrong code, and stays unconfirmed', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { mfa } = build(tx);
      await mfa.beginTotpEnrolment(user, 'Issuer');

      await expect(mfa.confirmTotpEnrolment(user, '000000')).rejects.toMatchObject({ status: 422 });
      expect(await mfa.isEnabled(user.id)).toBe(false);
    });
  });

  it('re-enrolling replaces the pending secret rather than leaving the old one usable', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { mfa } = build(tx);

      const first = await mfa.beginTotpEnrolment(user, 'Issuer');
      const second = await mfa.beginTotpEnrolment(user, 'Issuer');
      expect(second.secret).not.toBe(first.secret);

      // The abandoned secret must not confirm anything.
      await expect(mfa.confirmTotpEnrolment(user, totp(base32Decode(first.secret))))
        .rejects.toMatchObject({ status: 422 });
      await expect(mfa.confirmTotpEnrolment(user, totp(base32Decode(second.secret)))).resolves.toBeTruthy();
    });
  });
});

// ============================================================================ replay
describe('a TOTP code cannot be used twice', () => {
  it('refuses the SAME code on a second attempt', async () => {
    /*
     * RFC 6238 leaves replay to the implementer, and it is the part most often left out. A code is
     * valid for its whole step plus the window either side — about 90 seconds — so one seen over a
     * shoulder, left in a screenshot, or captured by a phishing proxy works again inside that
     * window. Recording the accepted step and refusing anything at or below it is what makes a code
     * single-use.
     */
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { mfa } = build(tx);
      const { secret } = await mfa.beginTotpEnrolment(user, 'Issuer');
      const code = totp(base32Decode(secret));
      await mfa.confirmTotpEnrolment(user, code);

      // Confirmation already consumed that step, so the very same code must not sign anyone in.
      expect(await mfa.verifyChallenge(user.id, 'totp', code, null)).toBe(false);
    });
  });

  it('refuses a code from an EARLIER step than one already used', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { mfa } = build(tx);
      const { secret } = await mfa.beginTotpEnrolment(user, 'Issuer');
      const key = base32Decode(secret);
      const now = Date.now();

      await mfa.confirmTotpEnrolment(user, totp(key, now));
      // The previous step is still inside the drift window, and must still be refused.
      expect(await mfa.verifyChallenge(user.id, 'totp', totp(key, now - 30_000), null)).toBe(false);
    });
  });

  it('accepts the NEXT step, so the next sign-in still works', async () => {
    /*
     * The replay guard must not become a lockout. Refusing everything at or below the used step is
     * the point; refusing the step ABOVE it would mean an account could be signed into exactly once
     * and never again.
     *
     * The next step's code is inside the drift window `verifyTotp` already allows, so this is the
     * real path a person takes 30 seconds later — not a contrived one.
     */
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { mfa } = build(tx);
      const { secret } = await mfa.beginTotpEnrolment(user, 'Issuer');
      const key = base32Decode(secret);
      const now = Date.now();

      await mfa.confirmTotpEnrolment(user, totp(key, now));
      const used = await tx.user_mfa_methods.findFirst({ where: { user_id: user.id, type: 'totp' } });
      expect(used!.last_step).not.toBeNull();

      expect(await mfa.verifyChallenge(user.id, 'totp', totp(key, now + 30_000), null)).toBe(true);

      // …and the recorded step moved forward with it, so THAT code is now spent too.
      const after = await tx.user_mfa_methods.findFirst({ where: { user_id: user.id, type: 'totp' } });
      expect(after!.last_step! > used!.last_step!).toBe(true);
      expect(await mfa.verifyChallenge(user.id, 'totp', totp(key, now + 30_000), null)).toBe(false);
    });
  });
});

// ============================================================================ recovery codes
describe('recovery codes', () => {
  it('are stored hashed, never readably', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { recovery } = build(tx);
      const codes = await recovery.issue(user.id);

      const rows = await tx.mfa_recovery_codes.findMany({ where: { user_id: user.id } });
      expect(rows).toHaveLength(RecoveryCodeService.COUNT);
      for (const row of rows) expect(codes).not.toContain(row.code_hash);
      expect(rows.some((r) => r.code_hash === hashOneTimeValue(codes[0]))).toBe(true);
    });
  });

  it('each works exactly once', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { recovery } = build(tx);
      const codes = await recovery.issue(user.id);

      expect(await recovery.redeem(user.id, codes[0], '127.0.0.1')).toBe(true);
      expect(await recovery.redeem(user.id, codes[0], '127.0.0.1')).toBe(false);
      expect(await recovery.remaining(user.id)).toBe(RecoveryCodeService.COUNT - 1);
    });
  });

  it('are accepted however they were transcribed', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { recovery } = build(tx);
      const codes = await recovery.issue(user.id);
      expect(await recovery.redeem(user.id, codes[0].toLowerCase().replace('-', ' '), null)).toBe(true);
    });
  });

  it('belong to ONE person', async () => {
    // A code is a full sign-in. If it worked against another account it would be a master key.
    await inRollback(async (tx) => {
      const mine = await makeUser(tx);
      const theirs = await makeUser(tx);
      const { recovery } = build(tx);
      const codes = await recovery.issue(mine.id);

      expect(await recovery.redeem(theirs.id, codes[0], null)).toBe(false);
      expect(await recovery.remaining(mine.id)).toBe(RecoveryCodeService.COUNT);
    });
  });

  it('regenerating invalidates every old one', async () => {
    /*
     * "Regenerate" is what somebody does after leaving a printed list behind, or emailing it to
     * themselves. Adding to the list rather than replacing it would leave every one of those
     * working, which is the opposite of the action they just took.
     */
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { recovery } = build(tx);
      const old = await recovery.issue(user.id);
      const fresh = await recovery.issue(user.id);

      expect(await recovery.redeem(user.id, old[0], null)).toBe(false);
      expect(await recovery.redeem(user.id, fresh[0], null)).toBe(true);
    });
  });

  it('a wrong code is simply refused', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { recovery } = build(tx);
      await recovery.issue(user.id);
      expect(await recovery.redeem(user.id, 'ZZZZZ-ZZZZZ', null)).toBe(false);
      expect(await recovery.redeem(user.id, '', null)).toBe(false);
    });
  });
});

// ============================================================================ email / SMS codes
describe('emailed and texted codes', () => {
  it('are delivered, and verify', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { mfa, email } = build(tx);

      await mfa.beginOtpEnrolment(user, 'email', 'someone@brokerage.ca');
      expect(email.sent).toHaveLength(1);

      await mfa.confirmOtpEnrolment(user, 'email', email.sent[0].code);
      expect(await mfa.isEnabled(user.id)).toBe(true);
    });
  });

  it('a code works once and no more', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { mfa, email } = build(tx);
      await mfa.beginOtpEnrolment(user, 'email', 'someone@brokerage.ca');
      await mfa.confirmOtpEnrolment(user, 'email', email.sent[0].code);

      expect(await mfa.verifyChallenge(user.id, 'email', email.sent[0].code, null)).toBe(false);
    });
  });

  it('asking for a new code invalidates the previous one', async () => {
    /*
     * Otherwise every press of Resend would add another live code, multiplying the guessing surface
     * — and somebody who presses it five times would have five valid codes outstanding at once.
     */
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { mfa, email } = build(tx);
      await mfa.beginOtpEnrolment(user, 'email', 'someone@brokerage.ca');
      await mfa.confirmOtpEnrolment(user, 'email', email.sent[0].code);

      await mfa.sendChallengeCode(user.id, 'email');
      await mfa.sendChallengeCode(user.id, 'email');
      const [, first, second] = email.sent;

      expect(await mfa.verifyChallenge(user.id, 'email', first.code, null)).toBe(false);
      expect(await mfa.verifyChallenge(user.id, 'email', second.code, null)).toBe(true);
    });
  });

  it('burns the code after too many wrong guesses', async () => {
    /*
     * Six digits is a million possibilities, which is not many at HTTP speed. The per-account
     * lockout bounds sign-in attempts; a challenge lives inside one already-password-authenticated
     * session and needs its own ceiling.
     */
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { mfa, email } = build(tx);
      await mfa.beginOtpEnrolment(user, 'email', 'someone@brokerage.ca');
      await mfa.confirmOtpEnrolment(user, 'email', email.sent[0].code);
      await mfa.sendChallengeCode(user.id, 'email');
      const real = email.sent[1].code;
      const wrong = real === '000000' ? '111111' : '000000';

      for (let i = 0; i < MfaService.OTP_MAX_ATTEMPTS; i += 1) {
        expect(await mfa.verifyChallenge(user.id, 'email', wrong, null)).toBe(false);
      }
      // The ceiling is reached: even the RIGHT code is now refused, and a new one must be sent.
      await expect(mfa.verifyChallenge(user.id, 'email', real, null)).rejects.toMatchObject({ status: 429 });
    });
  });

  it('an expired code is refused', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { mfa, email } = build(tx);
      await mfa.beginOtpEnrolment(user, 'email', 'someone@brokerage.ca');
      await mfa.confirmOtpEnrolment(user, 'email', email.sent[0].code);
      await mfa.sendChallengeCode(user.id, 'email');

      await tx.mfa_challenges.updateMany({
        where: { user_id: user.id, consumed_at: null },
        data: { expires_at: new Date(Date.now() - 1000) },
      });
      expect(await mfa.verifyChallenge(user.id, 'email', email.sent[1].code, null)).toBe(false);
    });
  });

  it('sending for a method that is not set up does nothing, and says nothing', async () => {
    // Answering differently would tell an unauthenticated caller which factors an account holds.
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { mfa, sms } = build(tx);
      await expect(mfa.sendChallengeCode(user.id, 'sms')).resolves.toBeUndefined();
      expect(sms.sent).toHaveLength(0);
    });
  });

  it('refuses enrolment on a channel this deployment cannot deliver on', async () => {
    // Otherwise somebody locks their account behind a factor that can never arrive.
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { mfa } = build(tx, { smsUp: false });
      await expect(mfa.beginOtpEnrolment(user, 'sms', '416-555-0100')).rejects.toMatchObject({ status: 422 });
    });
  });
});

// ============================================================================ removing a factor
describe('removing a factor', () => {
  it('requires the account password', async () => {
    /*
     * Without this, a session borrowed for thirty seconds at an unlocked desk is enough to strip the
     * second factor off an account — and the entire point of the factor is that a session alone
     * should not be enough for something this consequential.
     */
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { mfa } = build(tx);
      const { secret } = await mfa.beginTotpEnrolment(user, 'Issuer');
      await mfa.confirmTotpEnrolment(user, totp(base32Decode(secret)));

      await expect(mfa.removeMethod(user, 'totp', 'WrongPassw0rd!')).rejects.toMatchObject({ status: 422 });
      expect(await mfa.isEnabled(user.id)).toBe(true);

      await mfa.removeMethod(user, 'totp', PASSWORD);
      expect(await mfa.isEnabled(user.id)).toBe(false);
    });
  });

  it('drops the recovery codes once the last factor is gone', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { mfa, recovery } = build(tx);
      const { secret } = await mfa.beginTotpEnrolment(user, 'Issuer');
      await mfa.confirmTotpEnrolment(user, totp(base32Decode(secret)));
      expect(await recovery.remaining(user.id)).toBe(RecoveryCodeService.COUNT);

      await mfa.removeMethod(user, 'totp', PASSWORD);
      expect(await recovery.remaining(user.id)).toBe(0);
    });
  });
});

// ============================================================================ trusted devices
describe('trusted devices', () => {
  it('a trusted browser skips the challenge; an unknown one does not', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { devices } = build(tx);
      const res = fakeRes();

      expect(await devices.isTrusted(reqWith(), user.id)).toBe(false);
      await devices.trust(reqWith(), res as never, user.id);

      const token = res.cookies.mfa_device;
      expect(token).toBeTruthy();
      expect(await devices.isTrusted(reqWith(token), user.id)).toBe(true);
    });
  });

  it('the token is stored HASHED', async () => {
    // A database read must not yield a working second-factor bypass.
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { devices } = build(tx);
      const res = fakeRes();
      await devices.trust(reqWith(), res as never, user.id);

      const row = await tx.mfa_trusted_devices.findFirst({ where: { user_id: user.id } });
      expect(row!.token_hash).not.toBe(res.cookies.mfa_device);
      expect(row!.token_hash).toBe(hashOneTimeValue(res.cookies.mfa_device));
    });
  });

  it('is bound to ONE account', async () => {
    await inRollback(async (tx) => {
      const mine = await makeUser(tx);
      const theirs = await makeUser(tx);
      const { devices } = build(tx);
      const res = fakeRes();
      await devices.trust(reqWith(), res as never, mine.id);

      expect(await devices.isTrusted(reqWith(res.cookies.mfa_device), theirs.id)).toBe(false);
    });
  });

  it('stops working once expired', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { devices } = build(tx);
      const res = fakeRes();
      await devices.trust(reqWith(), res as never, user.id);

      await tx.mfa_trusted_devices.updateMany({
        where: { user_id: user.id }, data: { expires_at: new Date(Date.now() - 1000) },
      });
      expect(await devices.isTrusted(reqWith(res.cookies.mfa_device), user.id)).toBe(false);
    });
  });

  it('stops working once revoked', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { devices } = build(tx);
      const res = fakeRes();
      await devices.trust(reqWith(), res as never, user.id);

      expect(await devices.revokeAll(user.id)).toBe(1);
      expect(await devices.isTrusted(reqWith(res.cookies.mfa_device), user.id)).toBe(false);
    });
  });

  it('changing the factors revokes every trusted device', async () => {
    /*
     * A device was trusted BECAUSE a factor was held. Removing or replacing that factor is what
     * somebody does after losing a device — leaving the old ones trusted would defeat the action.
     */
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { mfa, devices } = build(tx);
      const { secret } = await mfa.beginTotpEnrolment(user, 'Issuer');
      await mfa.confirmTotpEnrolment(user, totp(base32Decode(secret)));

      const res = fakeRes();
      await devices.trust(reqWith(), res as never, user.id);
      await mfa.removeMethod(user, 'totp', PASSWORD);

      expect(await devices.isTrusted(reqWith(res.cookies.mfa_device), user.id)).toBe(false);
    });
  });

  it('a nonsense cookie is simply not trusted', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { devices } = build(tx);
      expect(await devices.isTrusted(reqWith('not-a-real-token'), user.id)).toBe(false);
    });
  });
});

// ============================================================================ admin reset
describe('an administrator clearing somebody two-factor', () => {
  it('removes the methods, the recovery codes and the trusted devices together', async () => {
    /*
     * Half a reset is worse than none. Leaving a trusted device behind would mean the account the
     * administrator just "secured" still has a browser that skips the challenge entirely.
     */
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, { role: 'admin' });
      const user = await makeUser(tx);
      const { mfa, recovery, devices } = build(tx);

      const { secret } = await mfa.beginTotpEnrolment(user, 'Issuer');
      await mfa.confirmTotpEnrolment(user, totp(base32Decode(secret)));
      const res = fakeRes();
      await devices.trust(reqWith(), res as never, user.id);

      await mfa.adminReset(admin, user.id);

      expect(await mfa.isEnabled(user.id)).toBe(false);
      expect(await mfa.methodsFor(user.id)).toEqual([]);
      expect(await recovery.remaining(user.id)).toBe(0);
      expect(await devices.isTrusted(reqWith(res.cookies.mfa_device), user.id)).toBe(false);
    });
  });

  it('refuses a user that does not exist', async () => {
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, { role: 'admin' });
      const { mfa } = build(tx);
      await expect(mfa.adminReset(admin, -1)).rejects.toMatchObject({ status: 422 });
    });
  });
});

// ============================================================================ policy
describe('the enrolment policy', () => {
  const policyFor = (tx: PrismaService) => new MfaPolicyService(tx);

  it('requires nothing by default', async () => {
    // Installing this feature must not change anybody's sign-in until a brokerage decides otherwise.
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      expect(await policyFor(tx).obligationFor(user, false)).toEqual({ state: 'none' });
    });
  });

  it('asks nothing of somebody already enrolled', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const policy = policyFor(tx);
      await policy.set('agent', true, 0);
      expect(await policy.obligationFor(user, true)).toEqual({ state: 'none' });
    });
  });

  it('gives a grace period rather than locking everyone out at once', async () => {
    /*
     * Switching the policy on is one click that would otherwise lock out every covered person
     * immediately — including, on a bad day, the administrator who just clicked it.
     */
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const policy = policyFor(tx);
      await policy.set('agent', true, 7);

      const result = await policy.obligationFor(user, false);
      expect(result.state).toBe('grace');
      expect((result as { days_left: number }).days_left).toBeGreaterThan(0);
    });
  });

  it('becomes overdue once the grace period passes', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const policy = policyFor(tx);
      await policy.set('agent', true, 7);

      const later = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
      expect(await policy.obligationFor(user, false, later)).toEqual({ state: 'overdue' });
    });
  });

  it('measures the grace from the LATER of the policy change and the account', async () => {
    /*
     * Somebody hired after the policy was set must get their own full window, not a deadline that
     * expired before they had an account.
     */
    await inRollback(async (tx) => {
      const policy = policyFor(tx);
      await policy.set('agent', true, 7);

      const newHire = await makeUser(tx, { created_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) });
      const wellAfterThePolicy = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
      expect((await policy.obligationFor(newHire, false, wellAfterThePolicy)).state).toBe('grace');
    });
  });

  it('applies only to the role it names', async () => {
    /*
     * Evaluated a few seconds ahead rather than at `Date.now()`, and that is not a fudge — it is
     * `updated_at` being `TIMESTAMP(0)`. Postgres ROUNDS a second-precision timestamp to the nearest
     * second rather than truncating, so a policy written at 12:00:00.850 is stored as 12:00:01 and
     * sits up to half a second in the future. With `grace_days: 0` that briefly reads as "grace"
     * instead of "overdue".
     *
     * Harmless in practice — a deadline measured in days is not affected by half a second — but it
     * is why this assertion does not use the current instant, and it is a real property of the
     * column rather than flakiness in the test.
     */
    await inRollback(async (tx) => {
      const agent = await makeUser(tx, { role: 'agent' });
      const accounting = await makeUser(tx, { role: 'accounting' });
      const policy = policyFor(tx);
      await policy.set('agent', true, 0);

      const inAMoment = new Date(Date.now() + 5000);
      expect((await policy.obligationFor(agent, false, inAMoment)).state).toBe('overdue');
      expect(await policy.obligationFor(accounting, false, inAMoment)).toEqual({ state: 'none' });
    });
  });

  it('turning the requirement off asks nothing again', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const policy = policyFor(tx);
      await policy.set('agent', true, 0);
      await policy.set('agent', false, 0);
      expect(await policy.obligationFor(user, false)).toEqual({ state: 'none' });
    });
  });
});

// ============================================================================ challenge routing
describe('answering a challenge', () => {
  it('a recovery code cannot be spent as a TOTP code, or the reverse', async () => {
    // The caller names the method, and each is checked against its own store only.
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { mfa } = build(tx);
      const { secret } = await mfa.beginTotpEnrolment(user, 'Issuer');
      const { recovery_codes } = await mfa.confirmTotpEnrolment(user, totp(base32Decode(secret)));

      expect(await mfa.verifyChallenge(user.id, 'totp', recovery_codes[0], null)).toBe(false);
      // And the recovery code is still unspent, having been tried down the wrong path.
      expect(await mfa.verifyChallenge(user.id, 'recovery', recovery_codes[0], null)).toBe(true);
    });
  });

  it('an account with no factor cannot be challenged into one', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx);
      const { mfa } = build(tx);
      expect(await mfa.verifyChallenge(user.id, 'totp', '000000', null)).toBe(false);
      expect(await mfa.verifyChallenge(user.id, 'recovery', 'ZZZZZ-ZZZZZ', null)).toBe(false);
    });
  });

  it('one person factor cannot answer for another', async () => {
    await inRollback(async (tx) => {
      const mine = await makeUser(tx);
      const theirs = await makeUser(tx);
      const { mfa } = build(tx);
      const { secret } = await mfa.beginTotpEnrolment(mine, 'Issuer');
      await mfa.confirmTotpEnrolment(mine, totp(base32Decode(secret)));

      // A code that is genuinely valid — for somebody else.
      expect(await mfa.verifyChallenge(theirs.id, 'totp', totp(base32Decode(secret), Date.now() + 30_000), null))
        .toBe(false);
    });
  });
});

// ============================================================================ two channels, not one
/**
 * Email and mobile are two separate factors, and every layer has to keep them that way.
 *
 * THE DEFECT THIS BLOCK IS THE FLOOR UNDER. On the settings screen both rows were bound to one
 * piece of state, so typing an address into "Email address" also filled "Mobile number" and a phone
 * number typed afterwards overwrote the address. That was a client bug and it is fixed there — but
 * "the two are independent" is a claim about the whole stack, and a screen is the easiest place for
 * it to be quietly re-broken. These assertions hold the server end of it: separate rows, separate
 * destinations, separate live codes, separate confirmation, separate removal.
 */
describe('email and mobile are two separate factors', () => {
  /** Enrol both channels for one person, unconfirmed, and return where each was sent. */
  async function bothStarted(tx: PrismaService) {
    const { mfa, email, sms } = build(tx);
    const user = await makeUser(tx);
    await mfa.beginOtpEnrolment(user, 'email', 'first@probe.test');
    await mfa.beginOtpEnrolment(user, 'sms', '416-555-0100');
    return { mfa, email, sms, user };
  }

  const destinations = async (tx: PrismaService, userId: number): Promise<Record<string, string | null>> => {
    const rows = await tx.user_mfa_methods.findMany({ where: { user_id: userId }, select: { type: true, destination: true } });
    return Object.fromEntries(rows.map((r) => [r.type, r.destination]));
  };

  it('stores one row per channel, each with its own destination', async () => {
    await inRollback(async (tx) => {
      const { user } = await bothStarted(tx);
      expect(await destinations(tx, user.id)).toEqual({
        email: 'first@probe.test',
        sms: '416-555-0100',
      });
    });
  });

  it('changing the email address leaves the mobile number exactly as it was', async () => {
    /*
     * THE SHAPE OF THE ORIGINAL COMPLAINT. Entering an address updated both fields; whichever was
     * saved last was the only one that had ever really existed.
     */
    await inRollback(async (tx) => {
      const { mfa, user } = await bothStarted(tx);

      await mfa.beginOtpEnrolment(user, 'email', 'second@probe.test');

      expect(await destinations(tx, user.id)).toEqual({
        email: 'second@probe.test',
        sms: '416-555-0100',          // untouched
      });
    });
  });

  it('changing the mobile number leaves the email address exactly as it was', async () => {
    await inRollback(async (tx) => {
      const { mfa, user } = await bothStarted(tx);

      await mfa.beginOtpEnrolment(user, 'sms', '416-555-0199');

      expect(await destinations(tx, user.id)).toEqual({
        email: 'first@probe.test',    // untouched
        sms: '416-555-0199',
      });
    });
  });

  it('sends each code to its own destination and nowhere else', async () => {
    await inRollback(async (tx) => {
      const { email, sms } = await bothStarted(tx);

      expect(email.sent.map((s) => s.destination)).toEqual(['first@probe.test']);
      expect(sms.sent.map((s) => s.destination)).toEqual(['416-555-0100']);
      // The codes themselves are different too — one is not a copy of the other.
      expect(email.sent[0].code).not.toBe(sms.sent[0].code);
    });
  });

  it('an emailed code cannot confirm the mobile factor, or the reverse', async () => {
    await inRollback(async (tx) => {
      const { mfa, email, sms, user } = await bothStarted(tx);

      await expect(mfa.confirmOtpEnrolment(user, 'sms', email.sent[0].code)).rejects.toThrow();
      await expect(mfa.confirmOtpEnrolment(user, 'email', sms.sent[0].code)).rejects.toThrow();

      // And neither wrong attempt confirmed anything.
      const rows = await tx.user_mfa_methods.findMany({ where: { user_id: user.id }, select: { confirmed_at: true } });
      expect(rows.every((r) => r.confirmed_at === null)).toBe(true);
    });
  });

  it('asking for a new email code leaves a live mobile code alone', async () => {
    /*
     * Resend is per channel. `issueOtp` supersedes the live code for the channel it was asked
     * about — if it superseded every channel, pressing "send another code" on the email row would
     * silently invalidate a text somebody was already reading off their phone.
     */
    await inRollback(async (tx) => {
      const { mfa, email, sms, user } = await bothStarted(tx);
      const textedCode = sms.sent[0].code;

      await mfa.beginOtpEnrolment(user, 'email', 'first@probe.test');   // resend, same address

      // A second email code was sent, and the first no longer works.
      expect(email.sent).toHaveLength(2);
      await expect(mfa.confirmOtpEnrolment(user, 'email', email.sent[0].code)).rejects.toThrow();
      // The texted one, meanwhile, is still good.
      await expect(mfa.confirmOtpEnrolment(user, 'sms', textedCode)).resolves.toBeDefined();
    });
  });

  it('confirming one channel leaves the other unconfirmed and still pending', async () => {
    await inRollback(async (tx) => {
      const { mfa, email, user } = await bothStarted(tx);

      await mfa.confirmOtpEnrolment(user, 'email', email.sent[0].code);

      const rows = await mfa.methodsFor(user.id);
      expect(rows.find((m) => m.type === 'email')?.confirmed).toBe(true);
      expect(rows.find((m) => m.type === 'sms')?.confirmed).toBe(false);
    });
  });

  it('removing one channel leaves the other with its destination intact', async () => {
    await inRollback(async (tx) => {
      const { mfa, email, sms, user } = await bothStarted(tx);
      await mfa.confirmOtpEnrolment(user, 'email', email.sent[0].code);
      await mfa.confirmOtpEnrolment(user, 'sms', sms.sent[0].code);

      await mfa.removeMethod(user, 'email', PASSWORD);

      expect(await destinations(tx, user.id)).toEqual({ sms: '416-555-0100' });
    });
  });

  it('shows each one masked in its own way, so neither is mistaken for the other', () => {
    // Real providers rather than the capturing stub: masking is what the settings screen displays
    // beside each factor, and an address masked as a phone number would be the same confusion
    // wearing a new hat.
    const real = new OtpDeliveryService(
      new EmailOtpProvider(null as never) as never,
      new SmsOtpProvider(null as never) as never,
    );

    expect(real.mask('email', 'patricia@brokerage.ca')).toBe('p••••••a@brokerage.ca');
    expect(real.mask('sms', '416-555-0100')).toBe('•••-•••-0100');
  });
});

// ============================================================================ per-channel validation
/**
 * Each channel judges its own destination, so a value meant for one field cannot be saved into the
 * other. This is the server's half of "they are separate fields": even if a screen handed it the
 * wrong one, it would be refused rather than stored.
 */
describe('each channel validates its own kind of destination', () => {
  const email = new EmailOtpProvider(null as never);
  const sms = new SmsOtpProvider(null as never);

  it('the email channel takes an address and refuses a phone number', () => {
    expect(email.validDestination('patricia@brokerage.ca')).toBe(true);
    expect(email.validDestination('416-555-0100')).toBe(false);
    expect(email.validDestination('+1 416 555 0100')).toBe(false);
  });

  it('the mobile channel takes a number in the forms people actually write, and refuses an address', () => {
    expect(sms.validDestination('416-555-0100')).toBe(true);
    expect(sms.validDestination('+1 416 555 0100')).toBe(true);
    expect(sms.validDestination('(416) 555-0100')).toBe(true);
    expect(sms.validDestination('patricia@brokerage.ca')).toBe(false);
  });

  it('neither accepts blank, and neither accepts the other channel\'s value', () => {
    for (const provider of [email, sms]) {
      expect(provider.validDestination('')).toBe(false);
      expect(provider.validDestination('   ')).toBe(false);
    }
    // A number too short to dial and an address with no domain: plainly neither.
    expect(sms.validDestination('12345')).toBe(false);
    expect(email.validDestination('patricia@')).toBe(false);
  });

  it('the service refuses a mismatched destination rather than storing it', async () => {
    await inRollback(async (tx) => {
      // Real providers, so the validators above are the ones the endpoint actually consults.
      const delivery = new OtpDeliveryService(
        new EmailOtpProvider(null as never) as never,
        new SmsOtpProvider(null as never) as never,
      );
      const passwords = new PasswordHashService({ get: () => 4 } as unknown as ConfigService);
      const mfa = new MfaService(
        tx, new RecoveryCodeService(tx),
        new TrustedDeviceService(tx, { get: () => ({ secure: false, sameSite: 'lax' }) } as unknown as ConfigService),
        delivery, passwords, { logModule: async () => {}, record: async () => {} } as never,
      );
      const user = await makeUser(tx);

      // A phone number offered as an email address, and an address offered as a number.
      await expect(mfa.beginOtpEnrolment(user, 'email', '416-555-0100')).rejects.toThrow();
      await expect(mfa.beginOtpEnrolment(user, 'sms', 'patricia@brokerage.ca')).rejects.toThrow();

      // Nothing was written by either refusal.
      expect(await tx.user_mfa_methods.count({ where: { user_id: user.id } })).toBe(0);
    });
  });
});
