import { ConfigService } from '@nestjs/config';
import bcrypt from 'bcryptjs';
import { PasswordHashService } from './password-hash.service';

/**
 * PHASE 1 — one source of truth for password hashing.
 *
 * WHAT WAS WRONG. Two places hashed passwords at two different costs. `AuthService` used
 * `config.bcryptRounds` (default 12) for registration and self-service changes; `UsersService` used
 * a hardcoded **10** for admin-created accounts and admin resets, ignoring the configuration.
 *
 * That mattered more than the numbers suggest: public registration is CLOSED, so an administrator
 * creates every account — which made cost 10 the cost essentially every password in the system had,
 * and made `BCRYPT_ROUNDS` a setting that changed almost nothing.
 *
 * These tests are written as the failure, not the feature.
 */

const svc = (rounds?: number) =>
  new PasswordHashService({ get: () => rounds } as unknown as ConfigService);

describe('the configured cost is the cost that is used', () => {
  it('hashes at the configured cost, not a hardcoded one', async () => {
    const hash = await svc(11).hashPassword('correct horse battery staple');
    expect(bcrypt.getRounds(hash)).toBe(11);
  });

  it('falls back to 12 when nothing is configured', async () => {
    // Matches `configuration.ts` (`int(process.env.BCRYPT_ROUNDS, 12)`), so a missing config and a
    // missing ConfigService agree rather than differing by a silent default.
    const s = svc(undefined);
    expect(s.getConfiguredCost()).toBe(12);
    expect(bcrypt.getRounds(await s.hashPassword('x'))).toBe(12);
  });

  it('produces a different hash each time for the same password', async () => {
    // Per-hash salt. Identical hashes would mean two users with one password are visibly the same.
    const s = svc(10);
    const [a, b] = [await s.hashPassword('same'), await s.hashPassword('same')];
    expect(a).not.toBe(b);
    expect(await s.verifyPassword('same', a)).toBe(true);
    expect(await s.verifyPassword('same', b)).toBe(true);
  });
});

describe('verification', () => {
  it('accepts the right password and refuses the wrong one', async () => {
    const s = svc(10);
    const hash = await s.hashPassword('right');
    expect(await s.verifyPassword('right', hash)).toBe(true);
    expect(await s.verifyPassword('wrong', hash)).toBe(false);
  });

  it('verifies a hash made at a DIFFERENT cost', async () => {
    /*
     * The property the whole upgrade rests on: the cost lives in the hash, so raising the
     * configured cost must not lock out everybody hashed at the old one.
     */
    const old = await svc(10).hashPassword('legacy');
    expect(await svc(12).verifyPassword('legacy', old)).toBe(true);
  });

  it.each([null, undefined, '', 'not-a-bcrypt-hash'])('returns false for a %s hash rather than throwing', async (bad) => {
    // A row with no usable password must fail to sign in, not crash the login route — which is what
    // `bcrypt.compareSync` did against null. A half-finished import leaves exactly these rows.
    await expect(svc(10).verifyPassword('anything', bad as string)).resolves.toBe(false);
  });
});

describe('needsRehash — which stored hashes are out of date', () => {
  it('a weaker hash needs upgrading', async () => {
    const weak = await svc(10).hashPassword('p');
    expect(svc(12).needsRehash(weak)).toBe(true);
  });

  it('a hash at the configured cost does not', async () => {
    const current = await svc(12).hashPassword('p');
    expect(svc(12).needsRehash(current)).toBe(false);
  });

  it('a STRONGER hash is left alone', async () => {
    /*
     * Deliberately one-directional. Lowering BCRYPT_ROUNDS — to cut CPU on a busy box, say — must
     * never quietly re-hash well-protected passwords down to the weaker setting.
     */
    const strong = await svc(13).hashPassword('p');
    expect(svc(10).needsRehash(strong)).toBe(false);
  });

  it('an unreadable hash is treated as upgradable, not as strong', () => {
    // Failing the other way would let a corrupt or foreign hash sit for ever, unexamined.
    expect(svc(12).needsRehash('$not$a$hash')).toBe(true);
  });

  it('a missing hash is not "upgradable" — that is a different problem', () => {
    expect(svc(12).needsRehash(null)).toBe(false);
    expect(svc(12).needsRehash('')).toBe(false);
  });
});

describe('bcrypt\'s 72-byte limit is stated once, here', () => {
  it('accepts a password at the limit', () => {
    expect(svc(10).fits('a'.repeat(72))).toBe(true);
  });

  it('refuses one past it', () => {
    expect(svc(10).fits('a'.repeat(73))).toBe(false);
  });

  it('counts BYTES, not characters', () => {
    /*
     * The case a length check gets wrong. An accented or non-Latin password reaches 72 bytes well
     * before 72 characters, and everything past that is silently ignored by bcrypt — so the part of
     * the password the user believes is protecting them would not be.
     */
    const accented = 'é'.repeat(37);              // 74 bytes, 37 characters
    expect(accented.length).toBeLessThan(72);
    expect(Buffer.byteLength(accented, 'utf8')).toBeGreaterThan(72);
    expect(svc(10).fits(accented)).toBe(false);
  });
});

describe('costOf — diagnostics', () => {
  it('reads the cost back out of a hash', async () => {
    expect(svc(10).costOf(await svc(10).hashPassword('p'))).toBe(10);
  });

  it('returns null rather than guessing', () => {
    expect(svc(10).costOf('rubbish')).toBeNull();
    expect(svc(10).costOf(null)).toBeNull();
  });
});
