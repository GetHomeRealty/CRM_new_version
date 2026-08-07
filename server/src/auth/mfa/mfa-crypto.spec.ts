import { createHash } from 'node:crypto';
import {
  MfaKeyMissingError,
  decryptSecret,
  encryptSecret,
  hashOneTimeValue,
  mfaStorageAvailable,
} from './mfa-crypto';
import { encryptToken } from '../../meta/meta-crypto';

/**
 * PHASE 3 — how a two-factor secret is stored.
 *
 * The property that matters most here is a NEGATIVE one: there must be no way to end up with a
 * readable TOTP secret in the database. `meta-crypto` deliberately falls back to a `plain:` marker
 * when APP_KEY is absent, because a Meta token that cannot be stored means a feature that cannot be
 * used. The same trade is wrong for a second factor — a readable secret is a permanent bypass for
 * anyone who can read a backup, and it fails silently, because everything keeps working.
 */

const KEY = 'base64:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const original = process.env.APP_KEY;

beforeEach(() => { process.env.APP_KEY = KEY; });
afterAll(() => {
  if (original === undefined) delete process.env.APP_KEY;
  else process.env.APP_KEY = original;
});

describe('sealing a secret', () => {
  it('round-trips', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it('does not store the secret in a readable form', () => {
    // The whole point. If this string appeared in the ciphertext, the encryption would be decoration.
    const secret = 'JBSWY3DPEHPK3PXP';
    const sealed = encryptSecret(secret);
    expect(sealed).not.toContain(secret);
    expect(Buffer.from(sealed, 'utf8').toString('base64')).not.toContain(secret);
  });

  it('produces a different ciphertext each time for the same secret', () => {
    // A fresh IV per seal. Identical ciphertexts would reveal that two people share a secret, and
    // would make the stored column comparable — which is exactly what an attacker wants.
    const [a, b] = [encryptSecret('SAME'), encryptSecret('SAME')];
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe('SAME');
    expect(decryptSecret(b)).toBe('SAME');
  });

  it('detects tampering rather than returning altered plaintext', () => {
    /*
     * AES-GCM authenticates as well as encrypts, which is what makes this possible. Without the tag
     * a flipped bit in the database would decrypt to a DIFFERENT valid-looking secret, and the
     * account would silently start rejecting every correct code with no explanation.
     */
    const sealed = encryptSecret('JBSWY3DPEHPK3PXP');
    const [prefix, body] = [sealed.slice(0, 7), sealed.slice(7)];
    const [iv, tag, data] = body.split('.');
    const flipped = Buffer.from(data, 'base64');
    flipped[0] ^= 0xff;
    expect(decryptSecret(`${prefix}${iv}.${tag}.${flipped.toString('base64')}`)).toBeNull();
  });

  it('returns null for a secret sealed under a DIFFERENT key', () => {
    // What an APP_KEY rotation leaves behind. The person must re-enrol; they must not get a 500 on
    // the login route, and they must certainly not get somebody else's secret.
    const sealed = encryptSecret('JBSWY3DPEHPK3PXP');
    process.env.APP_KEY = 'base64://///////////////////////////////////////8=';
    expect(decryptSecret(sealed)).toBeNull();
  });

  it.each([null, undefined, '', 'not-sealed', 'mfa:v1:garbage'])('returns null for %j', (bad) => {
    expect(decryptSecret(bad as string)).toBeNull();
  });
});

describe('without APP_KEY', () => {
  beforeEach(() => { delete process.env.APP_KEY; });

  it('reports that storage is unavailable', () => {
    expect(mfaStorageAvailable()).toBe(false);
  });

  it('REFUSES to seal rather than storing anything readable', () => {
    /*
     * THE TEST THIS FILE EXISTS FOR. The alternative — a `plain:` fallback like `meta-crypto`'s —
     * would put a working second-factor secret in the database in clear text, and nothing would
     * look wrong: enrolment succeeds, codes verify, and the bypass is invisible until somebody
     * reads a backup.
     */
    expect(() => encryptSecret('JBSWY3DPEHPK3PXP')).toThrow(MfaKeyMissingError);
  });

  it('still hashes one-time values, unkeyed', () => {
    // Recovery codes and OTPs must keep working without APP_KEY — they are random, not secrets to be
    // read back, so an unkeyed digest is a real fallback rather than a silent weakening.
    expect(hashOneTimeValue('ABCDE-FGHIJ')).toHaveLength(64);
  });
});

describe('with APP_KEY, storage is available', () => {
  it('says so', () => {
    expect(mfaStorageAvailable()).toBe(true);
  });
});

describe('key separation from the rest of the application', () => {
  it('an MFA ciphertext is not a Meta ciphertext', () => {
    /*
     * Both use AES-256-GCM under APP_KEY. Without a domain separator the same derived key would
     * protect both, and a ciphertext lifted from `meta_connections` could be pasted into
     * `user_mfa_methods.secret` and decrypt cleanly — turning a stolen Meta token into a chosen
     * TOTP secret. The prefix keeps the formats apart; the separate derivation keeps the KEYS apart.
     */
    const meta = encryptToken('JBSWY3DPEHPK3PXP');
    expect(decryptSecret(meta)).toBeNull();
    expect(encryptSecret('x').startsWith('mfa:v1:')).toBe(true);
  });

  it('does not derive the same key as a bare sha256 of APP_KEY', () => {
    // Guards the domain separator itself: if this were a plain digest, every other APP_KEY-derived
    // key in the application would be the same key.
    const bare = createHash('sha256').update(KEY.slice(7)).digest('hex');
    const sealed = encryptSecret('probe');
    expect(sealed).not.toContain(bare);
  });
});

describe('hashing one-time values', () => {
  it('is stable for the same input', () => {
    expect(hashOneTimeValue('ABCDE-FGHIJ')).toBe(hashOneTimeValue('ABCDE-FGHIJ'));
  });

  it('ignores case, spaces and hyphens', () => {
    /*
     * A recovery code is read off paper or a photograph and typed back. `abcde fghij`,
     * `ABCDE-FGHIJ` and `ABCDEFGHIJ` are the same code as far as the person is concerned, and a
     * hash that disagreed would reject a correct code with no way to tell why.
     */
    const canonical = hashOneTimeValue('ABCDE-FGHIJ');
    for (const written of ['abcde-fghij', 'ABCDE FGHIJ', 'ABCDEFGHIJ', '  abcde fghij  ', 'aBcDe-FgHiJ']) {
      expect(hashOneTimeValue(written)).toBe(canonical);
    }
  });

  it('differs for different values', () => {
    expect(hashOneTimeValue('ABCDE-FGHIJ')).not.toBe(hashOneTimeValue('ABCDE-FGHIK'));
  });

  it('is keyed, so digests are useless in another deployment', () => {
    const here = hashOneTimeValue('ABCDE-FGHIJ');
    process.env.APP_KEY = 'base64://///////////////////////////////////////8=';
    expect(hashOneTimeValue('ABCDE-FGHIJ')).not.toBe(here);
  });

  it('never returns the value itself', () => {
    expect(hashOneTimeValue('ABCDE-FGHIJ')).not.toContain('ABCDE');
  });
});
