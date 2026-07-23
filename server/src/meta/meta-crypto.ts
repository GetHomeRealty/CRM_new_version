import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Encryption for Meta access tokens at rest.
 *
 * A long-lived Facebook user or Page token grants read access to a client's lead ads for
 * ~60 days, so it is a credential, not a record. The source system stored these in plain text;
 * here they are sealed with AES-256-GCM under a key derived from APP_KEY and are never returned
 * to the browser.
 *
 * If APP_KEY is absent the value is stored with a `plain:` marker rather than silently looking
 * encrypted — `tokenStorageIsSecure()` reports that, and the UI surfaces it.
 */

const PREFIX_ENC = 'enc:v1:';
const PREFIX_PLAIN = 'plain:';

const rawKey = (): string => (process.env.APP_KEY ?? '').trim();

/** 32-byte key from APP_KEY, whatever length or encoding it happens to be. */
function key(): Buffer | null {
  const k = rawKey();
  if (!k) return null;
  const stripped = k.startsWith('base64:') ? k.slice(7) : k;
  return createHash('sha256').update(stripped).digest();
}

export const tokenStorageIsSecure = (): boolean => key() !== null;

export function encryptToken(plaintext: string): string {
  const k = key();
  const value = String(plaintext ?? '');
  if (!k) return PREFIX_PLAIN + value;

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX_ENC + [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

/**
 * Reverses `encryptToken`. Returns '' rather than throwing when a value can't be read — a stored
 * token that no longer decrypts (APP_KEY rotated) should surface as "reconnect", not a 500.
 */
export function decryptToken(stored: string): string {
  const value = String(stored ?? '');
  if (value.startsWith(PREFIX_PLAIN)) return value.slice(PREFIX_PLAIN.length);
  if (!value.startsWith(PREFIX_ENC)) return value; // written before encryption existed

  const k = key();
  if (!k) return '';
  const [ivB64, tagB64, dataB64] = value.slice(PREFIX_ENC.length).split('.');
  if (!ivB64 || !tagB64 || !dataB64) return '';
  try {
    const decipher = createDecipheriv('aes-256-gcm', k, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

/** Last four characters only — enough to tell two tokens apart in a log, useless if leaked. */
export const tokenHint = (token: string): string =>
  token ? `…${token.slice(-4)}` : '';
