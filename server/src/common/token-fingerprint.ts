import { createHash } from 'node:crypto';

/**
 * A short, one-way fingerprint of a secret, for proving IDENTITY in logs without disclosing VALUE.
 *
 * WHY THIS EXISTS. "Is the token we are refreshing the one Google issued at 15:07, or the one it
 * revoked at 15:06:45?" cannot be answered from a log that says only "refresh failed", and must not
 * be answered by printing the token. A truncated SHA-256 answers exactly that question and nothing
 * else: two log lines carrying the same fingerprint are the same credential; different fingerprints
 * are different credentials.
 *
 * FINGERPRINT THE PLAINTEXT, NEVER THE CIPHERTEXT. The stored value is Laravel-encrypted with a
 * random IV, so the same refresh token encrypts to a different blob every time it is written.
 * Hashing what is in the column would therefore make one unchanged credential look like a new one
 * on every save — the precise opposite of what this is for.
 *
 * NON-REVERSIBLE, AND DELIBERATELY SHORT. Twelve hex characters is 48 bits: ample to tell a handful
 * of credentials apart in a log file, useless for recovering the input. A refresh token is
 * high-entropy, so there is no dictionary to run against it — but the truncation means even a
 * full-strength digest is not being handed out.
 */
export function tokenFingerprint(plaintext: string | null | undefined): string {
  const s = (plaintext ?? '').trim();
  if (!s) return 'none';
  return createHash('sha256').update(s).digest('hex').slice(0, 12);
}
