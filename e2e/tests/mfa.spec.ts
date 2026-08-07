import { expect, test, type APIRequestContext } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { ACCOUNTS, API_BASE, PASSWORD } from './helpers';

/**
 * PHASE 3 — two-factor authentication, end to end through the real HTTP stack.
 *
 * The arithmetic is proved against the RFCs in `server/src/auth/mfa/totp.spec.ts` and the state
 * machine against real rows in `mfa.spec.ts`. What only a real request can show is the part that
 * matters most: that a correct password ALONE stops being enough, that the half-finished sign-in
 * reaches nothing, and that the challenge endpoints are bounded by the same authorization as
 * everything else.
 *
 * Every test works on a throwaway account it creates and deletes, never on the shared fixtures —
 * enrolling a second factor on `agent@test.local` would break every other spec in the suite.
 */

const SESSION_COOKIE = 'laravel_session';

/*
 * An INDEPENDENT TOTP implementation, written from RFC 6238 rather than imported from the server.
 *
 * Importing the server's `totp.ts` would make this suite agree with the implementation by
 * construction — if the server's dynamic truncation were wrong, both sides would be wrong together
 * and every test here would still pass. Twenty lines of duplication buys a genuinely independent
 * check that a third party (an authenticator app) would agree too.
 */
function base32ToBuffer(secret: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = secret.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    value = (value << 5) | alphabet.indexOf(c);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

function totpCode(secret: string, atMs = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / 30);
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac('sha1', base32ToBuffer(secret)).update(msg).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16)
    | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 1_000_000).padStart(6, '0');
}

/**
 * The code for the NEXT time step.
 *
 * Confirming enrolment spends the current step — that is the replay defence doing its job — so a
 * challenge answered with the same code moments later is correctly refused. Discovered by running
 * these tests, not by reading the code: three of them failed with 422 until this existed.
 *
 * The next step is inside the drift window the server already allows, so this is the ordinary path
 * a person takes when they glance back at their phone, not a contrivance.
 */
const nextCode = (secret: string): string => totpCode(secret, Date.now() + 30_000);

async function csrf(ctx: APIRequestContext): Promise<string> {
  await ctx.get(`${API_BASE}/sanctum/csrf-cookie`);
  const state = await ctx.storageState();
  return decodeURIComponent(state.cookies.find((c) => c.name === 'XSRF-TOKEN')?.value ?? '');
}

async function post(ctx: APIRequestContext, path: string, data?: unknown) {
  const token = await csrf(ctx);
  return ctx.post(`${API_BASE}${path}`, {
    headers: { 'X-XSRF-TOKEN': token, 'X-Requested-With': 'XMLHttpRequest' },
    data: data ?? {},
  });
}

async function signIn(ctx: APIRequestContext, email: string, password = PASSWORD) {
  return post(ctx, '/api/login', { username: email, password });
}

/** Sign the admin context in first, then create the probe account. */
async function withProbeUser(
  playwright: { request: { newContext: () => Promise<APIRequestContext> } },
  fn: (probe: { id: number; email: string }, admin: APIRequestContext) => Promise<void>,
) {
  const admin = await playwright.request.newContext();
  try {
    const li = await signIn(admin, ACCOUNTS.superAdmin.email);
    expect(li.status()).toBe(200);

    const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const email = `zz-mfa-${stamp}@probe.test`;
    const res = await post(admin, '/api/users', {
      name: `ZZ Mfa ${stamp}`,
      username: `zzmfa${stamp}`,
      email,
      password: PASSWORD,
      password_confirmation: PASSWORD,
      role: 'agent',
      status: 'Active',
      profile: { mobile: '416-555-0100', gender: 'Other' },
    });
    test.skip(res.status() >= 300, `could not create a probe user (${res.status()})`);
    const id = (await res.json()).id as number;

    try {
      await fn({ id, email }, admin);
    } finally {
      const token = await csrf(admin);
      await admin.delete(`${API_BASE}/api/users/${id}`, { headers: { 'X-XSRF-TOKEN': token } });
    }
  } finally {
    await admin.dispose();
  }
}

/** Enrol TOTP on a freshly signed-in context and return the secret + recovery codes. */
async function enrolTotp(ctx: APIRequestContext): Promise<{ secret: string; recovery: string[] }> {
  const begin = await post(ctx, '/api/mfa/totp/begin');
  expect(begin.status(), 'TOTP enrolment must be available — APP_KEY must be set').toBe(200);
  const { secret } = await begin.json();

  const confirm = await post(ctx, '/api/mfa/confirm', { type: 'totp', code: totpCode(secret) });
  expect(confirm.status()).toBe(200);
  return { secret, recovery: (await confirm.json()).recovery_codes };
}

// ============================================================ nothing changes for everyone else
test.describe('an account with no second factor', () => {
  test('signs in exactly as before', async ({ playwright }) => {
    /*
     * THE REGRESSION THAT MATTERS MOST. Two-factor ships switched off, and installing it must not
     * change a single sign-in until somebody enrols. If this fails, the feature has locked out a
     * brokerage that never asked for it.
     */
    const ctx = await playwright.request.newContext();
    try {
      const res = await signIn(ctx, ACCOUNTS.agent.email);
      expect(res.status()).toBe(200);

      const body = await res.json();
      expect(body.mfa_required).toBeUndefined();
      expect(body.user.email).toBe(ACCOUNTS.agent.email);
      expect((await ctx.get(`${API_BASE}/api/user`)).status()).toBe(200);
    } finally { await ctx.dispose(); }
  });

  test('reports two-factor as off, with the channels this server can deliver on', async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      await signIn(ctx, ACCOUNTS.agent.email);
      const status = await (await ctx.get(`${API_BASE}/api/mfa`)).json();

      expect(status.enabled).toBe(false);
      expect(status.methods).toEqual([]);
      expect(status.obligation).toEqual({ state: 'none' });
      /*
       * Also the wiring check. `OtpDeliveryService` resolves the mailer through `ModuleRef` rather
       * than a module import — see the comment there for why — so this is what proves the lookup
       * actually finds it in a running application rather than failing quietly at first use.
       */
      expect(status.available_channels).toContain('email');
    } finally { await ctx.dispose(); }
  });
});

// ============================================================ the challenge
test.describe('once a second factor is enrolled', () => {
  test('a correct password alone is no longer enough', async ({ playwright }) => {
    await withProbeUser(playwright, async (probe) => {
      const enrol = await playwright.request.newContext();
      try {
        await signIn(enrol, probe.email);
        await enrolTotp(enrol);
      } finally { await enrol.dispose(); }

      // A fresh browser: the password is right, and it does not get in.
      const fresh = await playwright.request.newContext();
      try {
        const res = await signIn(fresh, probe.email);
        expect(res.status()).toBe(200);

        const body = await res.json();
        expect(body.mfa_required, 'the password alone must produce a challenge').toBe(true);
        // No identity is handed out at the challenge — a password has been proved, nothing more.
        expect(body.user).toBeUndefined();
        expect(body.challenge.methods.map((m: { type: string }) => m.type)).toContain('totp');

        // And the half-finished session reaches nothing.
        expect((await fresh.get(`${API_BASE}/api/user`)).status()).toBe(401);
      } finally { await fresh.dispose(); }
    });
  });

  test('a valid code completes the sign-in', async ({ playwright }) => {
    await withProbeUser(playwright, async (probe) => {
      let secret = '';
      const enrol = await playwright.request.newContext();
      try {
        await signIn(enrol, probe.email);
        ({ secret } = await enrolTotp(enrol));
      } finally { await enrol.dispose(); }

      const fresh = await playwright.request.newContext();
      try {
        await signIn(fresh, probe.email);
        const before = (await fresh.storageState()).cookies.find((c) => c.name === SESSION_COOKIE)?.value;

        const answer = await post(fresh, '/api/login/mfa', { method: 'totp', code: nextCode(secret) });
        expect(answer.status()).toBe(200);
        expect((await answer.json()).user.email).toBe(probe.email);

        expect((await fresh.get(`${API_BASE}/api/user`)).status()).toBe(200);

        // The identifier changes again at the second step — the fixation fix has no gap in the
        // middle of a two-step sign-in.
        const after = (await fresh.storageState()).cookies.find((c) => c.name === SESSION_COOKIE)?.value;
        expect(after).not.toBe(before);
      } finally { await fresh.dispose(); }
    });
  });

  test('a wrong code is refused and signs nobody in', async ({ playwright }) => {
    await withProbeUser(playwright, async (probe) => {
      const enrol = await playwright.request.newContext();
      try {
        await signIn(enrol, probe.email);
        await enrolTotp(enrol);
      } finally { await enrol.dispose(); }

      const fresh = await playwright.request.newContext();
      try {
        await signIn(fresh, probe.email);
        const answer = await post(fresh, '/api/login/mfa', { method: 'totp', code: '000000' });
        expect(answer.status()).toBe(422);
        expect((await fresh.get(`${API_BASE}/api/user`)).status()).toBe(401);
      } finally { await fresh.dispose(); }
    });
  });

  test('the same code cannot be replayed', async ({ playwright }) => {
    /*
     * A TOTP code is valid for about 90 seconds, so one seen over a shoulder or captured by a
     * phishing proxy is reusable inside that window unless the server records the step it accepted.
     * Two independent browsers, one code — only the first may get in.
     */
    await withProbeUser(playwright, async (probe) => {
      let secret = '';
      const enrol = await playwright.request.newContext();
      try {
        await signIn(enrol, probe.email);
        ({ secret } = await enrolTotp(enrol));
      } finally { await enrol.dispose(); }

      const code = nextCode(secret);
      const first = await playwright.request.newContext();
      const second = await playwright.request.newContext();
      try {
        await signIn(first, probe.email);
        await signIn(second, probe.email);

        expect((await post(first, '/api/login/mfa', { method: 'totp', code })).status()).toBe(200);
        expect(
          (await post(second, '/api/login/mfa', { method: 'totp', code })).status(),
          'the second use of one code must be refused',
        ).toBe(422);
        expect((await second.get(`${API_BASE}/api/user`)).status()).toBe(401);
      } finally { await first.dispose(); await second.dispose(); }
    });
  });

  test('a recovery code signs in, once', async ({ playwright }) => {
    await withProbeUser(playwright, async (probe) => {
      let recovery: string[] = [];
      const enrol = await playwright.request.newContext();
      try {
        await signIn(enrol, probe.email);
        ({ recovery } = await enrolTotp(enrol));
      } finally { await enrol.dispose(); }

      expect(recovery.length).toBeGreaterThan(0);

      const a = await playwright.request.newContext();
      try {
        await signIn(a, probe.email);
        expect((await post(a, '/api/login/mfa', { method: 'recovery', code: recovery[0] })).status()).toBe(200);
        expect((await a.get(`${API_BASE}/api/user`)).status()).toBe(200);
      } finally { await a.dispose(); }

      const b = await playwright.request.newContext();
      try {
        await signIn(b, probe.email);
        expect(
          (await post(b, '/api/login/mfa', { method: 'recovery', code: recovery[0] })).status(),
          'a spent recovery code must not work again',
        ).toBe(422);
      } finally { await b.dispose(); }
    });
  });

  test('a challenge cannot be answered without one in progress', async ({ playwright }) => {
    // Straight to the endpoint with no password step at all.
    const ctx = await playwright.request.newContext();
    try {
      expect((await post(ctx, '/api/login/mfa', { method: 'totp', code: '123456' })).status()).toBe(401);
    } finally { await ctx.dispose(); }
  });

  test('one person\'s challenge cannot be answered with another person\'s code', async ({ playwright }) => {
    await withProbeUser(playwright, async (victim) => {
      await withProbeUser(playwright, async (attacker) => {
        let attackerSecret = '';
        for (const [who, keep] of [[victim, false], [attacker, true]] as const) {
          const ctx = await playwright.request.newContext();
          try {
            await signIn(ctx, who.email);
            const { secret } = await enrolTotp(ctx);
            if (keep) attackerSecret = secret;
          } finally { await ctx.dispose(); }
        }

        const fresh = await playwright.request.newContext();
        try {
          await signIn(fresh, victim.email);
          // A genuinely valid code — for the wrong account.
          const res = await post(fresh, '/api/login/mfa', { method: 'totp', code: nextCode(attackerSecret) });
          expect(res.status()).toBe(422);
          expect((await fresh.get(`${API_BASE}/api/user`)).status()).toBe(401);
        } finally { await fresh.dispose(); }
      });
    });
  });
});

// ============================================================ trusted devices
test.describe('remembering a device', () => {
  test('skips the challenge next time, and only for that browser', async ({ playwright }) => {
    await withProbeUser(playwright, async (probe) => {
      let secret = '';
      const enrol = await playwright.request.newContext();
      try {
        await signIn(enrol, probe.email);
        ({ secret } = await enrolTotp(enrol));
      } finally { await enrol.dispose(); }

      const trusted = await playwright.request.newContext();
      try {
        await signIn(trusted, probe.email);
        const answer = await post(trusted, '/api/login/mfa', {
          method: 'totp', code: nextCode(secret), trust_device: true,
        });
        expect(answer.status()).toBe(200);

        // Sign out and back in from the SAME jar: no challenge this time.
        await post(trusted, '/api/logout');
        const again = await signIn(trusted, probe.email);
        expect((await again.json()).mfa_required).toBeUndefined();
        expect((await trusted.get(`${API_BASE}/api/user`)).status()).toBe(200);
      } finally { await trusted.dispose(); }

      // A different browser is still challenged — the trust is not account-wide.
      const other = await playwright.request.newContext();
      try {
        const res = await signIn(other, probe.email);
        expect((await res.json()).mfa_required).toBe(true);
      } finally { await other.dispose(); }
    });
  });

  test('is not granted unless it is asked for', async ({ playwright }) => {
    // Trusting a browser is a real weakening of the factor; it must never be the default.
    await withProbeUser(playwright, async (probe) => {
      let secret = '';
      const enrol = await playwright.request.newContext();
      try {
        await signIn(enrol, probe.email);
        ({ secret } = await enrolTotp(enrol));
      } finally { await enrol.dispose(); }

      const ctx = await playwright.request.newContext();
      try {
        await signIn(ctx, probe.email);
        await post(ctx, '/api/login/mfa', { method: 'totp', code: nextCode(secret) });
        await post(ctx, '/api/logout');

        const again = await signIn(ctx, probe.email);
        expect((await again.json()).mfa_required, 'no trust was asked for, so the challenge must return').toBe(true);
      } finally { await ctx.dispose(); }
    });
  });
});

// ============================================================ management + authorization
test.describe('managing and administering', () => {
  test('removing a factor requires the account password', async ({ playwright }) => {
    await withProbeUser(playwright, async (probe) => {
      const ctx = await playwright.request.newContext();
      try {
        await signIn(ctx, probe.email);
        await enrolTotp(ctx);

        expect((await post(ctx, '/api/mfa/remove', { type: 'totp', password: 'WrongPassw0rd!' })).status()).toBe(422);
        expect((await (await ctx.get(`${API_BASE}/api/mfa`)).json()).enabled).toBe(true);

        expect((await post(ctx, '/api/mfa/remove', { type: 'totp', password: PASSWORD })).status()).toBe(200);
        expect((await (await ctx.get(`${API_BASE}/api/mfa`)).json()).enabled).toBe(false);
      } finally { await ctx.dispose(); }
    });
  });

  test('an administrator can clear a locked-out account', async ({ playwright }) => {
    await withProbeUser(playwright, async (probe, admin) => {
      const ctx = await playwright.request.newContext();
      try {
        await signIn(ctx, probe.email);
        await enrolTotp(ctx);
      } finally { await ctx.dispose(); }

      expect((await post(admin, `/api/mfa/admin/reset/${probe.id}`)).status()).toBe(200);

      // The account signs in on the password alone again.
      const after = await playwright.request.newContext();
      try {
        const res = await signIn(after, probe.email);
        expect((await res.json()).mfa_required).toBeUndefined();
        expect((await after.get(`${API_BASE}/api/user`)).status()).toBe(200);
      } finally { await after.dispose(); }
    });
  });

  test('an ordinary agent CANNOT reset somebody else\'s two-factor', async ({ playwright }) => {
    /*
     * The authorization test this file exists for. `ScreenGuard` is not registered globally in this
     * application, so a controller that carries `@Screen(...)` without listing the guard enforces
     * nothing — which is exactly the state the first version of `MfaAdminController` was in. If this
     * test goes green with the guard removed, the decorator is decoration.
     */
    await withProbeUser(playwright, async (probe) => {
      const agent = await playwright.request.newContext();
      try {
        await signIn(agent, ACCOUNTS.agent.email);
        const res = await post(agent, `/api/mfa/admin/reset/${probe.id}`);
        expect([401, 403]).toContain(res.status());
      } finally { await agent.dispose(); }
    });
  });

  test('an ordinary agent cannot rewrite the brokerage policy', async ({ playwright }) => {
    const agent = await playwright.request.newContext();
    try {
      await signIn(agent, ACCOUNTS.agent.email);
      expect([401, 403]).toContain((await agent.get(`${API_BASE}/api/mfa/admin/policies`)).status());
      expect([401, 403]).toContain(
        (await post(agent, '/api/mfa/admin/policies', { role: 'agent', required: true, grace_days: 7 })).status(),
      );
    } finally { await agent.dispose(); }
  });

  test('two-factor settings are not reachable without signing in', async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      expect((await ctx.get(`${API_BASE}/api/mfa`)).status()).toBe(401);
      expect((await post(ctx, '/api/mfa/totp/begin')).status()).toBe(401);
    } finally { await ctx.dispose(); }
  });
});
