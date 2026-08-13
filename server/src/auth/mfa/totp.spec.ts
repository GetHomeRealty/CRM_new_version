import {
  base32Decode,
  base32Encode,
  constantTimeEquals,
  formatSecretForDisplay,
  generateSecret,
  hotp,
  otpauthUri,
  timeStep,
  totp,
  verifyTotp,
} from './totp';

/**
 * PHASE 3 — the TOTP core, checked against the test vectors published in the RFCs.
 *
 * THIS IS THE POINT OF THE FILE. A hand-written second factor is only defensible if its correctness
 * is demonstrated against an external authority rather than against itself. Every expected value
 * below is copied from RFC 4648 §10 (base32), RFC 4226 Appendix D (HOTP) and RFC 6238 Appendix B
 * (TOTP) — not produced by running this implementation and pasting the output.
 *
 * If these pass, an authenticator app will agree with this server. If they were self-generated they
 * would pass just as happily while nobody could ever sign in.
 */

// ============================================================================ RFC 4648 §10
describe('base32 — RFC 4648 test vectors', () => {
  const VECTORS: Array<[string, string]> = [
    ['', ''],
    ['f', 'MY======'],
    ['fo', 'MZXQ===='],
    ['foo', 'MZXW6==='],
    ['foob', 'MZXW6YQ='],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI======'],
  ];

  it.each(VECTORS)('encodes %j', (plain, encoded) => {
    expect(base32Encode(Buffer.from(plain, 'utf8'))).toBe(encoded);
  });

  it.each(VECTORS)('decodes back to %j', (plain, encoded) => {
    expect(base32Decode(encoded).toString('utf8')).toBe(plain);
  });

  it('round-trips arbitrary bytes', () => {
    for (let length = 0; length <= 40; length += 1) {
      const bytes = Buffer.from(Array.from({ length }, (_, i) => (i * 37 + 11) % 256));
      expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    }
  });

  describe('what a person actually types', () => {
    // An authenticator shows the secret in lower case, or in space-separated groups of four. Both
    // have to decode, or manual entry fails for a reason nobody can see.
    it.each([
      ['lower case', 'mzxw6ytboi======'],
      ['grouped in fours', 'MZXW 6YTB OI'],
      ['hyphenated', 'MZXW-6YTB-OI'],
      ['unpadded', 'MZXW6YTBOI'],
    ])('accepts a secret %s', (_label, written) => {
      expect(base32Decode(written).toString('utf8')).toBe('foobar');
    });

    it('refuses a character outside the alphabet rather than guessing', () => {
      // 0, 1 and 8 are deliberately absent from base32 — they are the ones people mistake for O, I
      // and B. Silently mapping them would decode to a secret nobody has.
      expect(() => base32Decode('MZXW6YT0')).toThrow(/not a base32 character/);
      expect(() => base32Decode('MZXW6YT1')).toThrow();
      expect(() => base32Decode('MZXW6YT8')).toThrow();
    });
  });
});

// ============================================================================ RFC 4226 Appendix D
describe('HOTP — RFC 4226 test vectors', () => {
  /** The RFC's secret: the ASCII string "12345678901234567890". */
  const SECRET = Buffer.from('12345678901234567890', 'ascii');

  const EXPECTED = [
    '755224', '287082', '359152', '969429', '338314',
    '254676', '287922', '162583', '399871', '520489',
  ];

  it.each(EXPECTED.map((code, counter) => [counter, code]))('counter %i produces %s', (counter, code) => {
    expect(hotp(SECRET, counter as number)).toBe(code);
  });

  it('pads a code that is numerically short', () => {
    // The truncation is a modulo, so roughly one code in ten has a leading zero. Dropping it — by
    // returning a number rather than a string — would make one sign-in in ten fail.
    const withLeadingZero = Array.from({ length: 500 }, (_, i) => hotp(SECRET, i)).find((c) => c.startsWith('0'));
    expect(withLeadingZero).toBeDefined();
    expect(withLeadingZero).toHaveLength(6);
  });
});

// ============================================================================ RFC 6238 Appendix B
describe('TOTP — RFC 6238 test vectors', () => {
  /*
   * RFC 6238's table is stated for 8-digit codes, and its SHA-1 row uses the same 20-byte ASCII
   * secret as RFC 4226. Using the published digit count rather than this application's 6 keeps the
   * comparison against the RFC exact.
   */
  const SECRET = Buffer.from('12345678901234567890', 'ascii');

  const VECTORS: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];

  it.each(VECTORS)('at unix time %i produces %s', (seconds, code) => {
    expect(totp(SECRET, seconds * 1000, { digits: 8 })).toBe(code);
  });

  it('computes the time step the RFC describes', () => {
    expect(timeStep(59_000)).toBe(1);
    expect(timeStep(1111111109_000)).toBe(37037036);
    // The boundary: a step changes on the multiple of 30, not a second either side.
    expect(timeStep(29_999)).toBe(0);
    expect(timeStep(30_000)).toBe(1);
  });
});

// ============================================================================ verification
describe('verifying a code', () => {
  const SECRET = Buffer.from('12345678901234567890', 'ascii');
  const NOW = 1_800_000_000_000;

  it('accepts the current code', () => {
    const result = verifyTotp(SECRET, totp(SECRET, NOW), { at: NOW });
    expect(result.valid).toBe(true);
    expect(result.step).toBe(timeStep(NOW));
  });

  it('accepts the previous and next steps, for clock drift', () => {
    /*
     * The reason the window exists at all: a phone's clock is never exactly the server's, and a
     * person needs a few seconds to read six digits and type them.
     */
    const period = 30_000;
    for (const drift of [-period, period]) {
      const result = verifyTotp(SECRET, totp(SECRET, NOW + drift), { at: NOW });
      expect(result.valid).toBe(true);
      expect(result.step).toBe(timeStep(NOW + drift));
    }
  });

  it('refuses a code two steps away', () => {
    // The window is bounded. Accepting more would multiply an attacker's guessing surface for no
    // usability gain — 90 seconds is already generous for typing six digits.
    for (const drift of [-60_000, 60_000]) {
      expect(verifyTotp(SECRET, totp(SECRET, NOW + drift), { at: NOW }).valid).toBe(false);
    }
  });

  it('reports WHICH step matched, so the caller can stop a replay', () => {
    /*
     * THE PART THE RFC LEAVES TO THE IMPLEMENTER. A code stays valid for its whole step, so anyone
     * who sees one — over a shoulder, in a screenshot, through a phishing proxy — can use it again
     * inside the window. This function holds no state and cannot prevent that; returning the step is
     * what lets `MfaService` record it and refuse anything at or below it. Without this value there
     * is no way to make a code single-use at all.
     */
    const early = verifyTotp(SECRET, totp(SECRET, NOW - 30_000), { at: NOW });
    const now = verifyTotp(SECRET, totp(SECRET, NOW), { at: NOW });
    expect(early.step).toBe(now.step - 1);
  });

  it.each([
    ['empty', ''],
    ['too short', '12345'],
    ['too long', '1234567'],
    ['letters', 'abcdef'],
    ['mixed', '12a456'],
    ['a signed number', '-12345'],
    ['whitespace only', '      '],
  ])('refuses a %s token without touching the secret', (_label, token) => {
    const result = verifyTotp(SECRET, token, { at: NOW });
    expect(result.valid).toBe(false);
    expect(result.step).toBe(-1);
  });

  it('tolerates the space authenticator apps put in the middle', () => {
    // Google Authenticator displays "123 456", and copying it brings the space along.
    const code = totp(SECRET, NOW);
    expect(verifyTotp(SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, { at: NOW }).valid).toBe(true);
  });

  it('refuses a code from a different secret', () => {
    const other = Buffer.from('09876543210987654321', 'ascii');
    expect(verifyTotp(SECRET, totp(other, NOW), { at: NOW }).valid).toBe(false);
  });

  it('never goes below step zero', () => {
    // At the unix epoch the window would reach into negative steps, which are not codes.
    expect(() => verifyTotp(SECRET, '000000', { at: 0 })).not.toThrow();
  });
});

describe('constant-time comparison', () => {
  it('is still a correct comparison', () => {
    expect(constantTimeEquals('123456', '123456')).toBe(true);
    expect(constantTimeEquals('123456', '123457')).toBe(false);
    expect(constantTimeEquals('', '')).toBe(true);
  });

  it('handles a length mismatch without throwing', () => {
    // `timingSafeEqual` throws on unequal lengths, and an exception is itself a timing signal.
    expect(constantTimeEquals('123', '123456')).toBe(false);
    expect(constantTimeEquals('123456', '')).toBe(false);
  });
});

// ============================================================================ enrolment
describe('enrolment', () => {
  it('generates a 160-bit secret, which is what RFC 4226 requires', () => {
    const secret = generateSecret();
    expect(base32Decode(secret)).toHaveLength(20);
  });

  it('generates a different secret every time', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateSecret()));
    expect(seen.size).toBe(50);
  });

  it('produces a secret an authenticator app can read back', () => {
    // The round trip that matters: what we show must decode to the key we verify against.
    const secret = generateSecret();
    expect(totp(base32Decode(secret), 1_800_000_000_000))
      .toBe(totp(base32Decode(secret.toLowerCase()), 1_800_000_000_000));
  });

  describe('the otpauth:// URI', () => {
    const uri = otpauthUri({
      issuer: 'Get Home Realty',
      account: 'someone@brokerage.ca',
      secret: 'MZXW6YTBOI',
    });

    it('carries the issuer in the label AND as a parameter', () => {
      // Both are required by the de-facto specification. With only the parameter the entry shows as
      // a bare address; with only the label some apps group it wrongly.
      expect(uri).toContain('otpauth://totp/Get%20Home%20Realty:someone%40brokerage.ca');
      expect(uri).toContain('issuer=Get+Home+Realty');
    });

    it('states the algorithm, digits and period explicitly', () => {
      expect(uri).toContain('algorithm=SHA1');
      expect(uri).toContain('digits=6');
      expect(uri).toContain('period=30');
    });

    it('is parseable, with the secret intact', () => {
      const parsed = new URL(uri);
      expect(parsed.protocol).toBe('otpauth:');
      expect(parsed.searchParams.get('secret')).toBe('MZXW6YTBOI');
    });

    it('escapes an account name that would otherwise break the label', () => {
      // A colon in the account would be read as the issuer separator and split the label wrongly.
      const awkward = otpauthUri({ issuer: 'A:B', account: 'x:y@z.ca', secret: 'MZXW6YTBOI' });
      expect(new URL(awkward).pathname).toBe('/A%3AB:x%3Ay%40z.ca');
    });
  });

  it('groups the secret in fours for manual entry', () => {
    expect(formatSecretForDisplay('MZXW6YTBOIABCD')).toBe('MZXW 6YTB OIAB CD');
  });
});
