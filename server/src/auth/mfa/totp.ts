import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP — RFC 6238, built on HOTP — RFC 4226, with RFC 4648 base32.
 *
 * WHY THIS IS HAND-WRITTEN RATHER THAN A DEPENDENCY. The whole of it is an HMAC, a truncation and a
 * base32 alphabet — under a hundred lines of arithmetic with published test vectors for every part.
 * A second-factor implementation is exactly the kind of code that should be verifiable by reading
 * it, and `totp.spec.ts` checks it against the vectors in the RFCs themselves rather than against
 * whatever this file happens to do.
 *
 * It is also the only reasonable way to keep the dependency surface of an authentication path at
 * zero. Every package added here is a package that can be taken over, and this one would sit
 * directly on the sign-in route.
 *
 * SHA-1 IS CORRECT HERE and is not a weakness. RFC 6238 specifies HMAC-SHA1, every authenticator
 * app (Google Authenticator, Authy, 1Password, Microsoft Authenticator) implements that and most
 * ignore the `algorithm` parameter in the enrolment URI entirely. The attack HMAC-SHA1 needs to
 * resist is forging a 6-digit code within 30 seconds without the key; SHA-1's collision weaknesses
 * do not bear on HMAC at all. Choosing SHA-256 here would break scanning in common apps and buy
 * nothing.
 */

// ============================================================================ base32 (RFC 4648)

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32-encode, with `=` padding, exactly as RFC 4648 specifies. */
export function base32Encode(input: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  // Whatever is left is padded on the RIGHT with zero bits to reach a full 5-bit group.
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];

  while (out.length % 8 !== 0) out += '=';
  return out;
}

/**
 * Base32-decode. Case-insensitive, and spaces and padding are ignored.
 *
 * Both of those matter in practice rather than in theory: authenticator apps present the secret in
 * lower case or in space-separated groups of four, and somebody typing it in by hand will copy it
 * back the way they saw it.
 */
export function base32Decode(input: string): Buffer {
  const cleaned = String(input ?? '').toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const char of cleaned) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`"${char}" is not a base32 character.`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ============================================================================ HOTP / TOTP

/** The default everywhere in this file: 6 digits, 30-second steps, HMAC-SHA1 — RFC 6238's own. */
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;

/**
 * HOTP — RFC 4226 §5.3. HMAC the counter, take the dynamic-truncation offset from the low nibble of
 * the last byte, read four bytes there, mask the sign bit, and keep the last `digits` decimal places.
 */
export function hotp(secret: Buffer, counter: number, digits: number = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  // The counter is a 64-bit big-endian integer. Written as two 32-bit halves because a JS number
  // cannot hold 64 bits exactly, and `writeBigUInt64BE` would mean converting on every call.
  message.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  message.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The RFC 6238 time step for a moment — the counter HOTP is given. */
export function timeStep(at: Date | number = Date.now(), period: number = TOTP_PERIOD_SECONDS): number {
  const ms = at instanceof Date ? at.getTime() : at;
  return Math.floor(ms / 1000 / period);
}

/** The code for a moment. */
export function totp(
  secret: Buffer,
  at: Date | number = Date.now(),
  { digits = TOTP_DIGITS, period = TOTP_PERIOD_SECONDS }: { digits?: number; period?: number } = {},
): string {
  return hotp(secret, timeStep(at, period), digits);
}

export interface TotpVerification {
  /** Whether the code matched inside the accepted window. */
  valid: boolean;
  /**
   * The step the code belonged to. Callers MUST persist this and refuse anything at or below it
   * next time — see `verifyTotp`.
   */
  step: number;
}

/**
 * Check a code, allowing for clock drift.
 *
 * ON THE WINDOW. A window of 1 accepts the previous, current and next step — 90 seconds in total.
 * That is the usual recommendation and it is a genuine trade: it exists because a phone's clock and
 * a server's clock are never exactly aligned, and because a person needs a few seconds to read six
 * digits and type them. Widening it further multiplies an attacker's guessing surface for no
 * usability gain.
 *
 * ON REPLAY, which the RFC leaves to the implementer and which is easy to omit. A code stays valid
 * for its whole step, so anyone who observes one — over a shoulder, in a screenshot, in a phishing
 * proxy — can use it again within the window. `step` is returned so the caller can record it and
 * refuse anything at or below it afterwards, which is what makes a code single-use. `MfaService`
 * does exactly that; this function deliberately cannot, because it holds no state.
 *
 * COMPARISON IS CONSTANT TIME. The margin on a six-digit code is thin, but a timing oracle on a
 * secret comparison is free to remove and there is no reason to leave one in.
 */
export function verifyTotp(
  secret: Buffer,
  token: string,
  {
    at = Date.now(),
    window = 1,
    digits = TOTP_DIGITS,
    period = TOTP_PERIOD_SECONDS,
  }: { at?: Date | number; window?: number; digits?: number; period?: number } = {},
): TotpVerification {
  const candidate = String(token ?? '').replace(/\s/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(candidate)) return { valid: false, step: -1 };

  const current = timeStep(at, period);
  for (let drift = -window; drift <= window; drift += 1) {
    const step = current + drift;
    if (step < 0) continue;
    if (constantTimeEquals(hotp(secret, step, digits), candidate)) return { valid: true, step };
  }
  return { valid: false, step: -1 };
}

/** Length-safe constant-time string comparison. */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  // `timingSafeEqual` throws on a length mismatch, which would itself be a timing signal. Comparing
  // a value against itself keeps the work identical, and the length check decides the result.
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

// ============================================================================ enrolment

/**
 * A fresh 160-bit secret — the size RFC 4226 §4 requires and what every authenticator app expects.
 * Returned base32-encoded, because that is the only form these apps accept.
 */
export function generateSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

/**
 * The `otpauth://` URI an authenticator app scans.
 *
 * Both the issuer and the account name are percent-encoded, and the issuer appears twice — in the
 * label and as a parameter — which is what the de-facto specification requires and what makes the
 * entry read "Get Home Realty (someone@brokerage.ca)" rather than just an address.
 */
export function otpauthUri({
  issuer,
  account,
  secret,
  digits = TOTP_DIGITS,
  period = TOTP_PERIOD_SECONDS,
}: {
  issuer: string;
  account: string;
  secret: string;
  digits?: number;
  period?: number;
}): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(digits),
    period: String(period),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * The secret grouped in fours, for someone typing it in by hand because their camera will not focus.
 * Every enrolment screen that shows a QR code should show this too.
 */
export function formatSecretForDisplay(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? []).join(' ');
}
