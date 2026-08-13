import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../prisma/prisma.service';
import { ACCOUNT_LOGIN_LIMIT } from '../config/rate-limits';
import { AuthService } from './auth.service';
import { PasswordHashService } from './password-hash.service';
import { PermissionService } from './permission.service';
import { AccountLockoutService } from './account-lockout.service';
import { ModuleAccessService } from '../core/module-access.service';

/**
 * PHASE 2 — what `AuthService.login` accepts, what it refuses, and what it says while doing it.
 *
 * WHY THIS FILE EXISTS. Before it, `server/src/auth/` contained tests for password HASHING and
 * nothing else: not one test for signing in, for the credentials being wrong, for a deactivated
 * account, or for the brute-force brake. The e2e suite signs in constantly, but it only ever
 * exercises the happy path — every one of those tests would still pass if `login` accepted any
 * password at all for an existing user, because none of them ever sends a wrong one.
 *
 * The session and cookie half of Phase 2 lives in `e2e/tests/auth-session-security.spec.ts`, where
 * it has to: fixation, cookie flags and CSRF are properties of an HTTP exchange and cannot be
 * observed from a service call. This file is the other half — the decisions, not the transport.
 *
 * Real rows in the dev database, inside a transaction that is rolled back.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
const tag = (): string => `${Date.now()}-${(seq += 1)}`;

afterAll(async () => { await prisma.$disconnect(); });

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const hasher = () => new PasswordHashService({ get: () => 4 } as unknown as ConfigService);

/**
 * Cost 4 throughout. These tests hash dozens of passwords and the lockout cases hash nine in a row;
 * at cost 12 that is roughly a second each and the file takes minutes. Cost is what
 * `password-hash.spec.ts` is for — here it is a fixed, uninteresting constant, and using the
 * cheapest legal one keeps a wrong-password test from being slower than the thing it tests.
 */
function authService(tx: PrismaService, lockout = new AccountLockoutService()) {
  return new AuthService(
    tx,
    new PermissionService(),
    new ModuleAccessService(tx),
    lockout,
    hasher(),
  );
}

async function makeUser(
  tx: PrismaService,
  password: string,
  overrides: Record<string, unknown> = {},
): Promise<{ id: number; email: string; username: string }> {
  const now = new Date();
  const t = tag();
  const row = await tx.users.create({
    data: {
      name: `ZZ Auth ${t}`,
      email: `zz-auth-${t}@probe.test`,
      username: `zzauth${t.replace(/-/g, '')}`,
      role: 'agent',
      status: 'Active',
      password: await hasher().hashPassword(password),
      created_at: now,
      updated_at: now,
      ...overrides,
    },
    select: { id: true, email: true, username: true },
  });
  return row as { id: number; email: string; username: string };
}

/** The status and body of whatever `login` threw. */
async function failure(fn: () => Promise<unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    await fn();
  } catch (e) {
    const err = e as { getStatus?: () => number; getResponse?: () => unknown; status?: number };
    return {
      status: err.getStatus ? err.getStatus() : (err.status ?? 0),
      body: (err.getResponse ? err.getResponse() : {}) as Record<string, unknown>,
    };
  }
  throw new Error('expected the call to be refused, but it succeeded');
}

// ============================================================================ CREDENTIALS
describe('signing in with correct credentials', () => {
  it('accepts an email address', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'CorrectPassw0rd!');
      await expect(authService(tx).login(user.email, 'CorrectPassw0rd!')).resolves.toMatchObject({ id: user.id });
    });
  });

  it('accepts a username', async () => {
    // Both columns are tried, because a username may itself be email-formatted.
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'CorrectPassw0rd!');
      await expect(authService(tx).login(user.username, 'CorrectPassw0rd!')).resolves.toMatchObject({ id: user.id });
    });
  });

  it.each([
    ['upper case', (s: string) => s.toUpperCase()],
    ['mixed case', (s: string) => s.replace(/^./, (c) => c.toUpperCase())],
  ])('matches an email typed in %s', async (_label, transform) => {
    /*
     * The account already exists once, case-insensitively: `users_email_lower_key` and the Users
     * service both treat `Priya@x.ca` and `priya@x.ca` as one person. Sign-in matching exactly
     * would mean an address stored with a capital could not be typed in lower case — and because
     * that lands on the wrong-password path, retrying a few times would lock the person out of
     * their own account.
     */
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'CorrectPassw0rd!');
      await expect(authService(tx).login(transform(user.email), 'CorrectPassw0rd!')).resolves.toMatchObject({ id: user.id });
    });
  });

  it('matches a username typed in upper case', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'CorrectPassw0rd!');
      await expect(authService(tx).login(user.username.toUpperCase(), 'CorrectPassw0rd!')).resolves.toMatchObject({ id: user.id });
    });
  });

  it('is NOT case-insensitive about the password', async () => {
    // The lookup is deliberately case-insensitive; the secret must not be.
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'CorrectPassw0rd!');
      expect((await failure(() => authService(tx).login(user.email, 'correctpassw0rd!'))).status).toBe(422);
    });
  });

  it('accepts a password with punctuation, spaces and non-Latin characters', async () => {
    // Nothing between the form and bcrypt may normalise, trim or re-encode what was typed.
    const password = 'Ünïcode ✓ pass — "quoted" \\slash\\ 100%';
    await inRollback(async (tx) => {
      const user = await makeUser(tx, password);
      await expect(authService(tx).login(user.email, password)).resolves.toMatchObject({ id: user.id });
    });
  });
});

describe('signing in with bad credentials', () => {
  it('refuses the wrong password', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'CorrectPassw0rd!');
      const { status, body } = await failure(() => authService(tx).login(user.email, 'WrongPassw0rd!'));
      expect(status).toBe(422);
      expect(body.message).toBe('The provided credentials are incorrect.');
    });
  });

  it('refuses an account that does not exist', async () => {
    await inRollback(async (tx) => {
      expect((await failure(() => authService(tx).login(`nobody-${tag()}@probe.test`, 'AnyPassw0rd!'))).status).toBe(422);
    });
  });

  it('says exactly the same thing either way — no account enumeration', async () => {
    /*
     * THE ONE THAT MATTERS HERE. If a wrong password and an unknown address answered differently,
     * the login form becomes a directory: an attacker learns which addresses are real before
     * spending a single guess on a password, and for a brokerage that is a staff list.
     *
     * Compared field by field rather than by message alone, because a difference in `errors` would
     * leak just as much and is easier to introduce by accident.
     */
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'CorrectPassw0rd!');
      const wrongPassword = await failure(() => authService(tx).login(user.email, 'WrongPassw0rd!'));
      const noSuchUser = await failure(() => authService(tx).login(`nobody-${tag()}@probe.test`, 'WrongPassw0rd!'));

      expect(noSuchUser.status).toBe(wrongPassword.status);
      expect(noSuchUser.body).toEqual(wrongPassword.body);
    });
  });

  it.each([['empty', ''], ['whitespace', '   ']])('refuses a %s password', async (_label, password) => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'CorrectPassw0rd!');
      expect((await failure(() => authService(tx).login(user.email, password))).status).toBe(422);
    });
  });

  it('refuses an empty login', async () => {
    await inRollback(async (tx) => {
      await makeUser(tx, 'CorrectPassw0rd!');
      expect((await failure(() => authService(tx).login('', 'CorrectPassw0rd!'))).status).toBe(422);
    });
  });

  it.each([
    "' OR '1'='1",
    "admin'--",
    '" OR ""="',
    '; DROP TABLE users; --',
  ])('treats %j as an ordinary miss, not a query', async (login) => {
    // Prisma binds parameters, so this is a regression guard against somebody later reaching for
    // `$queryRawUnsafe` or string interpolation in the lookup.
    await inRollback(async (tx) => {
      await makeUser(tx, 'CorrectPassw0rd!');
      expect((await failure(() => authService(tx).login(login, 'CorrectPassw0rd!'))).status).toBe(422);
    });
  });

  describe('LIKE wildcards in the login string — a real vulnerability, now closed', () => {
    /*
     * WHAT WAS WRONG. The lookup used Prisma's `mode: 'insensitive'`, which compiles to **ILIKE**,
     * and ILIKE's right-hand side is a PATTERN. The string typed into the login box was therefore
     * being used as one, so `%` and `_` were live wildcards.
     *
     * MEASURED, NOT REASONED ABOUT. With the old lookup, `login('ZZ%@probe.test', <the matching
     * account's password>)` returned that user — a successful sign-in by someone who never knew the
     * address. What it buys an attacker is a password spray with no target: an administrator hands
     * out a standard temporary password, and `%` finds somebody it fits.
     *
     * THESE TESTS ARE DELIBERATELY CONSTRUCTED SO THEY CANNOT PASS BY LUCK. Each one aims a
     * wildcard at a user whose password it also supplies, so on the old code the sign-in SUCCEEDS
     * and the test fails. A bare `%` would have been the weaker test: it matches whichever row the
     * scan reaches first, which is usually some unrelated user whose password does not match — so
     * it would have gone green against the vulnerable code and proved nothing.
     */
    it.each([
      ['a trailing % on the email', (u: { email: string }) => `${u.email.slice(0, 6)}%`],
      ['a leading % on the email', (u: { email: string }) => `%${u.email.slice(-14)}`],
      ['% for the whole local part', (u: { email: string }) => `%@${u.email.split('@')[1]}`],
      ['a single-character _ wildcard', (u: { email: string }) => u.email.replace(/^(.{4})./, '$1_')],
    ])('%s must not match', async (_label, pattern) => {
      await inRollback(async (tx) => {
        const user = await makeUser(tx, 'CorrectPassw0rd!');
        const attempt = pattern(user);
        // The pattern really would have matched — otherwise the test proves nothing.
        expect(attempt).not.toBe(user.email);

        const { status } = await failure(() => authService(tx).login(attempt, 'CorrectPassw0rd!'));
        expect(status).toBe(422);
      });
    });

    it('a wildcard aimed at a username must not match either', async () => {
      // Both columns are searched; fixing only one would leave the same hole behind a longer name.
      await inRollback(async (tx) => {
        const user = await makeUser(tx, 'CorrectPassw0rd!');
        expect((await failure(() => authService(tx).login(`${user.username.slice(0, 6)}%`, 'CorrectPassw0rd!'))).status).toBe(422);
      });
    });

    it('a bare % matches nobody', async () => {
      await inRollback(async (tx) => {
        await makeUser(tx, 'CorrectPassw0rd!');
        expect((await failure(() => authService(tx).login('%', 'CorrectPassw0rd!'))).status).toBe(422);
        expect((await failure(() => authService(tx).login('_', 'CorrectPassw0rd!'))).status).toBe(422);
      });
    });

    it('a backslash in a login is just a character', async () => {
      // The escape character in a LIKE pattern. Under equality it has no special meaning at all.
      await inRollback(async (tx) => {
        const user = await makeUser(tx, 'CorrectPassw0rd!');
        expect((await failure(() => authService(tx).login(`${user.email}\\`, 'CorrectPassw0rd!'))).status).toBe(422);
      });
    });
  });

  it('refuses a row whose password hash is empty rather than crashing', async () => {
    // What a half-finished import leaves behind. It must fail to sign in, not 500 the login route.
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'CorrectPassw0rd!', { password: '' });
      expect((await failure(() => authService(tx).login(user.email, ''))).status).toBe(422);
      expect((await failure(() => authService(tx).login(user.email, 'anything'))).status).toBe(422);
    });
  });
});

// ============================================================================ ACCOUNT STATE
describe('a deactivated account', () => {
  it('cannot sign in even with the right password', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'CorrectPassw0rd!', { status: 'Inactive' });
      const { status, body } = await failure(() => authService(tx).login(user.email, 'CorrectPassw0rd!'));
      expect(status).toBe(422);
      expect(String(body.message)).toMatch(/inactive/i);
    });
  });

  it('does not count toward the lockout — it is not an attack', async () => {
    /*
     * A correct password against a disabled account is almost always the person who was disabled,
     * trying again. Counting it would mean their address is locked for everyone, including whoever
     * re-enables it, and it tells an attacker nothing they could use.
     */
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'CorrectPassw0rd!', { status: 'Inactive' });
      const lockout = new AccountLockoutService();
      const svc = authService(tx, lockout);

      for (let i = 0; i < ACCOUNT_LOGIN_LIMIT.limit + 2; i += 1) {
        expect((await failure(() => svc.login(user.email, 'CorrectPassw0rd!'))).status).toBe(422);
      }
      // Still 422 "inactive", never 429 — the counter was never touched.
      expect(() => lockout.assertNotLocked(user.email)).not.toThrow();
    });
  });

  it('is resolved to null by loadUser, so an existing session dies too', async () => {
    /*
     * Deactivation has to reach the session somebody is already holding. Checking status only at
     * sign-in would mean an account closed on Friday afternoon kept working until its cookie
     * expired — the guard calls this on every request, which is what closes that window.
     */
    await inRollback(async (tx) => {
      const active = await makeUser(tx, 'CorrectPassw0rd!');
      const inactive = await makeUser(tx, 'CorrectPassw0rd!', { status: 'Inactive' });
      const svc = authService(tx);

      await expect(svc.loadUser(active.id)).resolves.toMatchObject({ id: active.id });
      await expect(svc.loadUser(inactive.id)).resolves.toBeNull();
      await expect(svc.loadUser(-1)).resolves.toBeNull();
    });
  });

  it('only "Inactive" shuts an account out — an unrecognised status does not', async () => {
    /*
     * Both readers spell the rule as `(status ?? 'Active') === 'Inactive'`, so anything that is not
     * exactly that string is allowed in. Worth pinning down, because the alternative reading — an
     * allow-list of known-good statuses — is a plausible-looking change that would lock out every
     * account carrying a value somebody added later.
     *
     * The column itself is NOT NULL DEFAULT 'Active' (checked against the schema, which is why the
     * `?? 'Active'` in both readers is belt-and-braces rather than a live path), so the null case
     * cannot be reached from the database at all.
     */
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'CorrectPassw0rd!', { status: 'Suspended' });
      const svc = authService(tx);
      await expect(svc.login(user.email, 'CorrectPassw0rd!')).resolves.toMatchObject({ id: user.id });
      await expect(svc.loadUser(user.id)).resolves.toMatchObject({ id: user.id });
    });
  });

  it('defaults a new account to Active without being told', async () => {
    await inRollback(async (tx) => {
      const t = tag();
      const now = new Date();
      const row = await tx.users.create({
        data: {
          name: `ZZ Default ${t}`, email: `zz-default-${t}@probe.test`, username: `zzdefault${t.replace(/-/g, '')}`,
          role: 'agent', password: await hasher().hashPassword('CorrectPassw0rd!'), created_at: now, updated_at: now,
        },
        select: { id: true, status: true },
      });
      expect(row.status).toBe('Active');
      await expect(authService(tx).loadUser(row.id)).resolves.toMatchObject({ id: row.id });
    });
  });
});

// ============================================================================ BRUTE FORCE
describe('the per-account lockout', () => {
  it('locks the account after the configured number of failures', async () => {
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'CorrectPassw0rd!');
      const svc = authService(tx);

      for (let i = 0; i < ACCOUNT_LOGIN_LIMIT.limit; i += 1) {
        expect((await failure(() => svc.login(user.email, `Wrong${i}!`))).status).toBe(422);
      }

      const locked = await failure(() => svc.login(user.email, 'Wrong-again!'));
      expect(locked.status).toBe(429);
      expect(locked.body.retry_after).toEqual(expect.any(Number));
    });
  });

  it('locks out the CORRECT password too, once tripped', async () => {
    /*
     * The point of the control. A lockout that still let the right password through would be no
     * defence at all — the attacker's very next guess is the one that works.
     */
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'CorrectPassw0rd!');
      const svc = authService(tx);
      for (let i = 0; i < ACCOUNT_LOGIN_LIMIT.limit; i += 1) {
        await failure(() => svc.login(user.email, `Wrong${i}!`));
      }
      expect((await failure(() => svc.login(user.email, 'CorrectPassw0rd!'))).status).toBe(429);
    });
  });

  it('a correct password before the limit clears the count', async () => {
    // Somebody who mistypes twice and then succeeds must not carry those failures forward.
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'CorrectPassw0rd!');
      const svc = authService(tx);

      for (let i = 0; i < ACCOUNT_LOGIN_LIMIT.limit - 1; i += 1) {
        await failure(() => svc.login(user.email, `Wrong${i}!`));
      }
      await expect(svc.login(user.email, 'CorrectPassw0rd!')).resolves.toBeTruthy();

      // The budget is full again rather than one short.
      for (let i = 0; i < ACCOUNT_LOGIN_LIMIT.limit - 1; i += 1) {
        expect((await failure(() => svc.login(user.email, `Wrong${i}!`))).status).toBe(422);
      }
    });
  });

  it('locking one account does not lock another', async () => {
    await inRollback(async (tx) => {
      const victim = await makeUser(tx, 'CorrectPassw0rd!');
      const colleague = await makeUser(tx, 'CorrectPassw0rd!');
      const svc = authService(tx);

      for (let i = 0; i < ACCOUNT_LOGIN_LIMIT.limit; i += 1) {
        await failure(() => svc.login(victim.email, `Wrong${i}!`));
      }
      expect((await failure(() => svc.login(victim.email, 'CorrectPassw0rd!'))).status).toBe(429);
      await expect(svc.login(colleague.email, 'CorrectPassw0rd!')).resolves.toBeTruthy();
    });
  });

  it('counts email and username against the SAME budget as far as case goes', async () => {
    // Normalised on the way in, so `Agent@x.test` and `agent@x.test` cannot be attacked as two.
    await inRollback(async (tx) => {
      const user = await makeUser(tx, 'CorrectPassw0rd!');
      const svc = authService(tx);
      for (let i = 0; i < ACCOUNT_LOGIN_LIMIT.limit; i += 1) {
        await failure(() => svc.login(i % 2 === 0 ? user.email : user.email.toUpperCase(), `Wrong${i}!`));
      }
      expect((await failure(() => svc.login(user.email.toUpperCase(), 'CorrectPassw0rd!'))).status).toBe(429);
    });
  });
});

describe('the lockout window', () => {
  /*
   * Time is moved rather than waited on — the window is fifteen minutes. `Date.now` is the only
   * clock `AccountLockoutService` reads, which is what makes this testable at all.
   */
  const at = (ms: number) => jest.spyOn(Date, 'now').mockReturnValue(ms);
  afterEach(() => { jest.restoreAllMocks(); });

  it('expires, and the account works again afterwards', async () => {
    const lockout = new AccountLockoutService();
    const T0 = 1_800_000_000_000;

    at(T0);
    for (let i = 0; i < ACCOUNT_LOGIN_LIMIT.limit; i += 1) lockout.recordFailure('someone@probe.test');
    expect(() => lockout.assertNotLocked('someone@probe.test')).toThrow();

    at(T0 + ACCOUNT_LOGIN_LIMIT.ttl + 1);
    expect(() => lockout.assertNotLocked('someone@probe.test')).not.toThrow();
  });

  it('is still locked one millisecond before the window ends', async () => {
    // The boundary, in the direction that matters: expiring early would shorten the control.
    const lockout = new AccountLockoutService();
    const T0 = 1_800_000_000_000;

    at(T0);
    for (let i = 0; i < ACCOUNT_LOGIN_LIMIT.limit; i += 1) lockout.recordFailure('someone@probe.test');

    at(T0 + ACCOUNT_LOGIN_LIMIT.ttl - 1);
    expect(() => lockout.assertNotLocked('someone@probe.test')).toThrow();
  });

  it('does not slide — failures spread across the window still expire together', async () => {
    /*
     * The window starts at the FIRST failure and is not extended by later ones. Stated as a test
     * because the alternative is a plausible-looking change: a sliding window would let a patient
     * attacker hold an account locked indefinitely, one guess at a time, as a denial of service
     * against a colleague who has done nothing.
     */
    const lockout = new AccountLockoutService();
    const T0 = 1_800_000_000_000;
    const step = Math.floor(ACCOUNT_LOGIN_LIMIT.ttl / (ACCOUNT_LOGIN_LIMIT.limit + 1));

    for (let i = 0; i < ACCOUNT_LOGIN_LIMIT.limit; i += 1) {
      at(T0 + i * step);
      lockout.recordFailure('someone@probe.test');
    }
    at(T0 + ACCOUNT_LOGIN_LIMIT.limit * step);
    expect(() => lockout.assertNotLocked('someone@probe.test')).toThrow();

    at(T0 + ACCOUNT_LOGIN_LIMIT.ttl + 1);
    expect(() => lockout.assertNotLocked('someone@probe.test')).not.toThrow();
  });

  it('reports how long is left, in seconds', async () => {
    const lockout = new AccountLockoutService();
    const T0 = 1_800_000_000_000;

    at(T0);
    for (let i = 0; i < ACCOUNT_LOGIN_LIMIT.limit; i += 1) lockout.recordFailure('someone@probe.test');

    at(T0 + 60_000);
    try {
      lockout.assertNotLocked('someone@probe.test');
      throw new Error('expected a lockout');
    } catch (e) {
      const body = (e as { getResponse?: () => unknown }).getResponse?.() as { retry_after?: number };
      expect(body.retry_after).toBe(Math.ceil((ACCOUNT_LOGIN_LIMIT.ttl - 60_000) / 1000));
    }
  });
});
