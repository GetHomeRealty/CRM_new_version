import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * Encryption for TOTP secrets at rest, and hashing for the one-time values beside them.
 *
 * WHY THIS IS NOT `meta-crypto.ts`, WHICH ALREADY DOES AES-256-GCM. Two deliberate differences, and
 * both are the reason a second copy is justified rather than a wrapper:
 *
 *   1. NO PLAINTEXT FALLBACK. `encryptToken` stores a `plain:` marker when APP_KEY is absent, and
 *      surfaces that in the UI. That is a reasonable trade for a Meta token, where the alternative
 *      is a feature that cannot be used at all. It is not a reasonable trade here: a TOTP secret in
 *      plain text is a permanent bypass of the second factor for anyone who can read the database —
 *      including a backup, a replica, or a support export. Worse, it fails silently in the one
 *      direction nobody checks, because everything keeps working. Enrolment REFUSES without a key.
 *
 *   2. A SEPARATE KEY. Derived from APP_KEY with its own domain separator, so a ciphertext from one
 *      system cannot be pasted into a column belonging to the other and decrypt.
 *
 * The one-time values — recovery codes, emailed and texted OTPs, trusted-device tokens — are not
 * encrypted but HASHED. They never need to be read back, only compared, and a hash cannot be
 * reversed by whoever holds the key.
 */

const PREFIX = 'mfa:v1:';
const DOMAIN = 'mfa-totp-secret-v1';

/** Raised when a secret would have to be stored without encryption. Never caught to "carry on". */
export class MfaKeyMissingError extends Error {
  constructor() {
    super(
      'APP_KEY is not set, so a two-factor secret cannot be stored safely. '
      + 'Set APP_KEY before enabling two-factor authentication.',
    );
    this.name = 'MfaKeyMissingError';
  }
}

/** The 32-byte key, or null when APP_KEY is absent. */
function key(): Buffer | null {
  const raw = (process.env.APP_KEY ?? '').trim();
  if (!raw) return null;
  const stripped = raw.startsWith('base64:') ? raw.slice(7) : raw;
  // Domain-separated from every other use of APP_KEY in the application.
  return createHmac('sha256', createHash('sha256').update(stripped).digest()).update(DOMAIN).digest();
}

/** Whether two-factor secrets can be stored at all. Read by the enrolment endpoint and the UI. */
export const mfaStorageAvailable = (): boolean => key() !== null;

/** Seal a TOTP secret. Throws rather than storing anything readable. */
export function encryptSecret(plaintext: string): string {
  const k = key();
  if (!k) throw new MfaKeyMissingError();

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return PREFIX + [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

/**
 * Open a sealed secret.
 *
 * Returns null rather than throwing when the value cannot be read — an APP_KEY rotated without
 * re-enrolment leaves rows that will never decrypt, and the right answer for the person holding one
 * is "set your authenticator up again", not a 500 on the login route. The caller decides that.
 */
export function decryptSecret(stored: string | null | undefined): string | null {
  const value = String(stored ?? '');
  if (!value.startsWith(PREFIX)) return null;

  const k = key();
  if (!k) return null;

  const [ivB64, tagB64, dataB64] = value.slice(PREFIX.length).split('.');
  if (!ivB64 || !tagB64 || !dataB64) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', k, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key, or a tampered ciphertext — GCM's authentication tag catches both.
    return null;
  }
}

/**
 * Hash a one-time value — a recovery code, an emailed or texted OTP, a trusted-device token.
 *
 * SHA-256 rather than bcrypt, deliberately, and the reasoning is the opposite of the password case.
 * bcrypt is slow ON PURPOSE because a password is short, memorable and often reused, so an offline
 * attacker guessing it must be made to pay per guess. These values are none of those things: every
 * one is generated here from `randomBytes` with at least 80 bits of entropy and none is chosen by a
 * person. There is no dictionary to run and no reuse to exploit, so the work factor buys nothing —
 * while the cost is real, because an OTP is checked on a login route and recovery codes are verified
 * ten at a time.
 *
 * Keyed with APP_KEY where one exists, so the stored digests are useless in another deployment.
 */
export function hashOneTimeValue(value: string): string {
  const k = key();
  const normalised = String(value ?? '').trim().toUpperCase().replace(/[\s-]/g, '');
  return k
    ? createHmac('sha256', k).update(normalised).digest('hex')
    : createHash('sha256').update(normalised).digest('hex');
}
