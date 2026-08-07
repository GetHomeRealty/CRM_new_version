import { expect, test, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { ACCOUNTS, API_BASE, PASSWORD, signIn } from './helpers';

/**
 * PHASE 2 — session and cookie security, at the layer where those concerns actually live.
 *
 * Sessions, cookies, CSRF and fixation are HTTP properties. A service-level test can prove that
 * `login()` returns the right user; only a real request can prove what cookie came back, whether the
 * session identifier changed, and whether the old one still works afterwards.
 *
 * These use Playwright's `request` context rather than a page, because a cookie jar with no
 * JavaScript in it is exactly the client an attacker has.
 *
 * The session cookie is `laravel_session` (SESSION_COOKIE_NAME), inherited from the Laravel contract
 * this API replaced.
 */

const SESSION_COOKIE = 'laravel_session';

/** The value of a named cookie in a request context's jar, or undefined. */
async function cookieValue(ctx: APIRequestContext, name: string): Promise<string | undefined> {
  const state = await ctx.storageState();
  return state.cookies.find((c) => c.name === name)?.value;
}

async function cookieRecord(ctx: APIRequestContext, name: string) {
  const state = await ctx.storageState();
  return state.cookies.find((c) => c.name === name);
}

/** Fetch a CSRF token into the jar and return it, the way the SPA does before any write. */
async function primeCsrf(ctx: APIRequestContext): Promise<string> {
  await ctx.get(`${API_BASE}/sanctum/csrf-cookie`);
  const raw = await cookieValue(ctx, 'XSRF-TOKEN');
  return decodeURIComponent(raw ?? '');
}

async function login(ctx: APIRequestContext, who: keyof typeof ACCOUNTS = 'agent', password = PASSWORD) {
  const token = await primeCsrf(ctx);
  return ctx.post(`${API_BASE}/api/login`, {
    headers: { 'X-XSRF-TOKEN': token, 'X-Requested-With': 'XMLHttpRequest' },
    data: { username: ACCOUNTS[who].email, password },
  });
}

// ============================================================ SESSION FIXATION
test.describe('session fixation', () => {
  test('the session identifier CHANGES when a user signs in', async ({ playwright }) => {
    /*
     * THE ONE THAT MATTERS MOST IN THIS FILE.
     *
     * `GET /api/sanctum/csrf-cookie` writes `req.session.csrfToken`, which creates a session and
     * issues a `laravel_session` cookie to an anonymous visitor. `POST /api/login` then sets
     * `req.session.userId` on that SAME session.
     *
     * If the identifier survives that transition, an attacker who can plant a session cookie in a
     * victim's browser — a subdomain, an XSS anywhere on the origin, a shared machine — holds a
     * cookie that becomes authenticated the moment the victim signs in. They do not need the
     * password; they need the victim to use one.
     *
     * The fix is `req.session.regenerate()` on successful authentication: a new identifier, and the
     * planted one authenticates nobody.
     */
    const ctx = await playwright.request.newContext();
    try {
      await primeCsrf(ctx);
      const before = await cookieValue(ctx, SESSION_COOKIE);
      expect(before, 'a session cookie should exist before login — csrf-cookie writes to the session').toBeTruthy();

      const res = await login(ctx);
      expect(res.status()).toBe(200);

      const after = await cookieValue(ctx, SESSION_COOKIE);
      expect(after).toBeTruthy();
      expect(after, 'the pre-login session identifier must not survive authentication').not.toBe(before);
    } finally { await ctx.dispose(); }
  });

  test('a session identifier captured BEFORE login cannot be used afterwards', async ({ playwright }) => {
    // The consequence stated directly: replaying the planted identifier must not reach the account.
    const victim = await playwright.request.newContext();
    try {
      await primeCsrf(victim);
      const planted = await cookieValue(victim, SESSION_COOKIE);
      await login(victim);

      const attacker = await playwright.request.newContext({
        extraHTTPHeaders: { Cookie: `${SESSION_COOKIE}=${planted}` },
      });
      try {
        const res = await attacker.get(`${API_BASE}/api/user`);
        expect(res.status(), 'the pre-login identifier must not be authenticated').toBe(401);
      } finally { await attacker.dispose(); }
    } finally { await victim.dispose(); }
  });
});

// ============================================================ SESSION LIFECYCLE
test.describe('session lifecycle', () => {
  test('an authenticated session reaches a protected endpoint', async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      await login(ctx);
      const me = await ctx.get(`${API_BASE}/api/user`);
      expect(me.status()).toBe(200);
      expect((await me.json()).email).toBe(ACCOUNTS.agent.email);
    } finally { await ctx.dispose(); }
  });

  test('logout destroys the session, and the cookie stops working', async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      await login(ctx);
      const before = await cookieValue(ctx, SESSION_COOKIE);

      const token = await primeCsrf(ctx);
      const out = await ctx.post(`${API_BASE}/api/logout`, { headers: { 'X-XSRF-TOKEN': token } });
      expect(out.status()).toBe(200);

      // Replaying the exact cookie the session had must not work — destroy has to remove the
      // server-side record, not merely clear the browser's copy.
      const replay = await playwright.request.newContext({
        extraHTTPHeaders: { Cookie: `${SESSION_COOKIE}=${before}` },
      });
      try {
        expect((await replay.get(`${API_BASE}/api/user`)).status()).toBe(401);
      } finally { await replay.dispose(); }
    } finally { await ctx.dispose(); }
  });

  test('logging out twice is not an error the second time', async ({ playwright }) => {
    // Two tabs, both pressing Log out. The second must not produce a 500.
    const ctx = await playwright.request.newContext();
    try {
      await login(ctx);
      let token = await primeCsrf(ctx);
      expect((await ctx.post(`${API_BASE}/api/logout`, { headers: { 'X-XSRF-TOKEN': token } })).status()).toBe(200);
      token = await primeCsrf(ctx);
      const second = await ctx.post(`${API_BASE}/api/logout`, { headers: { 'X-XSRF-TOKEN': token } });
      expect(second.status(), 'a second logout should be refused cleanly, not crash').toBeLessThan(500);
    } finally { await ctx.dispose(); }
  });

  test('an invalid session identifier is refused', async ({ playwright }) => {
    const ctx = await playwright.request.newContext({
      extraHTTPHeaders: { Cookie: `${SESSION_COOKIE}=s%3Anot-a-real-session.forged` },
    });
    try {
      expect((await ctx.get(`${API_BASE}/api/user`)).status()).toBe(401);
    } finally { await ctx.dispose(); }
  });

  test('no session cookie at all is refused', async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      expect((await ctx.get(`${API_BASE}/api/user`)).status()).toBe(401);
    } finally { await ctx.dispose(); }
  });

  test('two concurrent sessions for one user both work independently', async ({ playwright }) => {
    // Two devices. Signing in on the second must not evict the first.
    const a = await playwright.request.newContext();
    const b = await playwright.request.newContext();
    try {
      await login(a);
      await login(b);
      expect((await a.get(`${API_BASE}/api/user`)).status()).toBe(200);
      expect((await b.get(`${API_BASE}/api/user`)).status()).toBe(200);
      expect(await cookieValue(a, SESSION_COOKIE)).not.toBe(await cookieValue(b, SESSION_COOKIE));

      // …and logging out of one must not end the other.
      const token = await primeCsrf(a);
      await a.post(`${API_BASE}/api/logout`, { headers: { 'X-XSRF-TOKEN': token } });
      expect((await b.get(`${API_BASE}/api/user`)).status()).toBe(200);
    } finally { await a.dispose(); await b.dispose(); }
  });
});

// ============================================================ COOKIE SECURITY
test.describe('cookie attributes', () => {
  test('the session cookie is HttpOnly', async ({ playwright }) => {
    /*
     * The single most important attribute on this cookie: it is what stops any script on the origin
     * from reading the session identifier. The XSRF cookie is deliberately NOT HttpOnly, because the
     * SPA has to read it — and it carries no authority on its own.
     */
    const ctx = await playwright.request.newContext();
    try {
      await login(ctx);
      const session = await cookieRecord(ctx, SESSION_COOKIE);
      expect(session?.httpOnly, 'the session cookie must not be readable by scripts').toBe(true);
    } finally { await ctx.dispose(); }
  });

  test('the XSRF cookie is readable by design, and is not the session', async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      await login(ctx);
      const xsrf = await cookieRecord(ctx, 'XSRF-TOKEN');
      expect(xsrf?.httpOnly).toBe(false);
      // It must not be the thing that authenticates — holding it alone reaches nothing.
      const alone = await playwright.request.newContext({
        extraHTTPHeaders: { Cookie: `XSRF-TOKEN=${xsrf?.value}` },
      });
      try {
        expect((await alone.get(`${API_BASE}/api/user`)).status()).toBe(401);
      } finally { await alone.dispose(); }
    } finally { await ctx.dispose(); }
  });

  test('the session cookie is scoped to / and carries SameSite', async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      await login(ctx);
      const c = await cookieRecord(ctx, SESSION_COOKIE);
      expect(c?.path).toBe('/');
      expect(['Lax', 'Strict', 'None'], 'SameSite must be set explicitly').toContain(c?.sameSite);
    } finally { await ctx.dispose(); }
  });

  test('the session cookie carries no readable user information', async ({ playwright }) => {
    /*
     * express-session stores an opaque signed identifier and keeps the payload server-side in
     * `user_sessions`. This asserts the shape rather than trusting it: an identifier that embedded
     * the user id or email would leak it to anyone who saw the cookie.
     */
    const ctx = await playwright.request.newContext();
    try {
      await login(ctx, 'agent');
      const raw = decodeURIComponent((await cookieValue(ctx, SESSION_COOKIE)) ?? '');
      expect(raw).not.toContain(ACCOUNTS.agent.email);
      expect(raw).not.toContain(ACCOUNTS.agent.name);
      expect(raw.toLowerCase()).not.toContain('admin');
    } finally { await ctx.dispose(); }
  });
});

// ============================================================ REMEMBER ME
test.describe('remember me', () => {
  /*
   * WHY THIS IS TESTED AT ALL. Regenerating the session on sign-in moved this: a new session starts
   * from the configured default lifetime, so setting `cookie.maxAge` BEFORE `regenerate()` would be
   * silently discarded and "keep me signed in" would quietly stop working. Nothing else in the suite
   * would have noticed — every other test signs in for a few seconds.
   */
  const DAY = 24 * 60 * 60;

  async function loginRemembering(ctx: APIRequestContext, remember: boolean) {
    const token = await primeCsrf(ctx);
    const res = await ctx.post(`${API_BASE}/api/login`, {
      headers: { 'X-XSRF-TOKEN': token, 'X-Requested-With': 'XMLHttpRequest' },
      data: { username: ACCOUNTS.agent.email, password: PASSWORD, remember },
    });
    expect(res.status()).toBe(200);
    return (await cookieRecord(ctx, SESSION_COOKIE))?.expires ?? 0;
  }

  test('extends the session cookie well beyond the default', async ({ playwright }) => {
    const plain = await playwright.request.newContext();
    const remembered = await playwright.request.newContext();
    try {
      const shortLived = await loginRemembering(plain, false);
      const longLived = await loginRemembering(remembered, true);
      const now = Date.now() / 1000;

      expect(longLived, 'remember me must outlast the default session').toBeGreaterThan(shortLived);
      expect(longLived - now, 'remember me is meant to last 60 days').toBeGreaterThan(30 * DAY);
    } finally {
      await plain.dispose();
      await remembered.dispose();
    }
  });

  test('without it, the session expires on the ordinary schedule', async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      const expires = await loginRemembering(ctx, false);
      const now = Date.now() / 1000;
      expect(expires, 'an ordinary sign-in must not last for weeks').toBeLessThan(now + 7 * DAY);
      expect(expires, 'and must not already be expired').toBeGreaterThan(now);
    } finally { await ctx.dispose(); }
  });

  test('a remembered session still regenerates its identifier', async ({ playwright }) => {
    // The fixation fix must not have an opt-out.
    const ctx = await playwright.request.newContext();
    try {
      await primeCsrf(ctx);
      const before = await cookieValue(ctx, SESSION_COOKIE);
      await loginRemembering(ctx, true);
      expect(await cookieValue(ctx, SESSION_COOKIE)).not.toBe(before);
    } finally { await ctx.dispose(); }
  });
});

// ============================================================ CSRF
test.describe('CSRF protection', () => {
  test('a write with no CSRF token is refused', async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      await login(ctx);
      const res = await ctx.post(`${API_BASE}/api/logout`, { headers: {} });
      expect(res.status()).toBe(419);
    } finally { await ctx.dispose(); }
  });

  test('a write with the WRONG CSRF token is refused', async ({ playwright }) => {
    // A token from nowhere must not pass — the cookie and the header have to agree with the session.
    const ctx = await playwright.request.newContext();
    try {
      await login(ctx);
      const res = await ctx.post(`${API_BASE}/api/logout`, {
        headers: { 'X-XSRF-TOKEN': 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
      });
      expect(res.status()).toBe(419);
    } finally { await ctx.dispose(); }
  });

  test('another session\'s CSRF token is refused', async ({ playwright }) => {
    /*
     * The interesting case: a real, currently-valid token, but belonging to a different session.
     * If the check compared the header against the COOKIE alone it would pass, because an attacker
     * can set both. It has to be compared against the session.
     */
    const mine = await playwright.request.newContext();
    const theirs = await playwright.request.newContext();
    try {
      await login(mine);
      const foreign = await primeCsrf(theirs);

      const res = await mine.post(`${API_BASE}/api/logout`, { headers: { 'X-XSRF-TOKEN': foreign } });
      expect(res.status()).toBe(419);
    } finally { await mine.dispose(); await theirs.dispose(); }
  });

  test('a GET is not blocked by CSRF', async ({ playwright }) => {
    // Reads must stay usable from an email link or a bookmark; CSRF applies to state changes.
    const ctx = await playwright.request.newContext();
    try {
      await login(ctx);
      expect((await ctx.get(`${API_BASE}/api/user`)).status()).toBe(200);
    } finally { await ctx.dispose(); }
  });

  test('the CSRF token is REPLACED at sign-in, and the new one works immediately', async ({ playwright }) => {
    /*
     * The other half of the fixation fix. Regeneration empties the session, and the CSRF guard reads
     * its counterpart from there — so sign-in has to hand back a fresh token in the same response.
     *
     * Two things must both hold, and testing only the first would be worse than testing neither:
     *   1. the token actually changes (a token minted for an anonymous session is not carried across
     *      a privilege change), and
     *   2. the SPA's very next write succeeds with it — no 419, no extra round trip to re-prime.
     *
     * If (2) broke, the interceptor in `client/src/lib/axios.ts` would silently paper over it by
     * refetching and retrying once, so nothing user-visible would fail and every other test here
     * would still pass. This asserts it directly instead.
     */
    const ctx = await playwright.request.newContext();
    try {
      const anonymous = await primeCsrf(ctx);
      expect(anonymous).toBeTruthy();

      const res = await ctx.post(`${API_BASE}/api/login`, {
        headers: { 'X-XSRF-TOKEN': anonymous, 'X-Requested-With': 'XMLHttpRequest' },
        data: { username: ACCOUNTS.agent.email, password: PASSWORD },
      });
      expect(res.status()).toBe(200);

      const issued = decodeURIComponent((await cookieValue(ctx, 'XSRF-TOKEN')) ?? '');
      expect(issued, 'sign-in must issue a fresh CSRF token').not.toBe(anonymous);
      expect(issued).toBeTruthy();

      // Used straight away, with no further priming — this is what the SPA does.
      const write = await ctx.post(`${API_BASE}/api/logout`, { headers: { 'X-XSRF-TOKEN': issued } });
      expect(write.status(), 'the token issued at sign-in must be accepted immediately').toBe(200);
    } finally { await ctx.dispose(); }
  });

  test('the pre-login CSRF token stops working after sign-in', async ({ playwright }) => {
    // The consequence of rotation, stated directly.
    const ctx = await playwright.request.newContext();
    try {
      const anonymous = await primeCsrf(ctx);
      await ctx.post(`${API_BASE}/api/login`, {
        headers: { 'X-XSRF-TOKEN': anonymous, 'X-Requested-With': 'XMLHttpRequest' },
        data: { username: ACCOUNTS.agent.email, password: PASSWORD },
      });
      const stale = await ctx.post(`${API_BASE}/api/logout`, { headers: { 'X-XSRF-TOKEN': anonymous } });
      expect(stale.status()).toBe(419);
    } finally { await ctx.dispose(); }
  });
});

// ============================================================ ACCOUNT STATE
test.describe('what a session survives', () => {
  test('changing a password ends the OTHER sessions', async ({ browser, playwright }) => {
    /*
     * The security property of a password change: it is what somebody does after a suspected leak,
     * so any session an attacker already holds has to die with it. `endSessionsFor` deletes the
     * user's rows from `user_sessions`.
     *
     * Uses a throwaway account, and restores the password afterwards, so the shared fixture that
     * every other spec signs in with is left exactly as it was found.
     */
    const admin = await browser.newContext();
    try {
      const page = await admin.newPage();
      await signIn(page, 'superAdmin');

      const tag = `${Date.now()}`;
      const created = await page.evaluate(async ({ base, t }) => {
        const tok = document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN='))?.split('=')[1];
        const r = await fetch(`${base}/api/users`, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': decodeURIComponent(tok ?? ''), 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({
            name: `ZZ Session ${t}`, username: `zzsession${t}`, email: `zz-session-${t}@probe.test`,
            password: 'TempPass123!', password_confirmation: 'TempPass123!',
            role: 'agent', status: 'Active', profile: { mobile: '416-555-0100', gender: 'Other' },
          }),
        });
        return { status: r.status, body: await r.json().catch(() => null) };
      }, { base: API_BASE, t: tag });
      test.skip(created.status >= 300, `could not create a probe user (${created.status})`);
      const userId = (created.body as { id?: number })?.id;

      /*
       * TWO sessions for that account — a laptop and a phone, or the user and whoever else is
       * holding a stolen cookie. Changing the password from one has to end the other, and asserting
       * only that the change returned 200 would prove nothing about that at all.
       */
      const email = `zz-session-${tag}@probe.test`;
      const laptop = await playwright.request.newContext();
      const phone = await playwright.request.newContext();
      try {
        for (const ctx of [laptop, phone]) {
          const tok = await primeCsrf(ctx);
          const li = await ctx.post(`${API_BASE}/api/login`, {
            headers: { 'X-XSRF-TOKEN': tok, 'X-Requested-With': 'XMLHttpRequest' },
            data: { username: email, password: 'TempPass123!' },
          });
          expect(li.status()).toBe(200);
          expect((await ctx.get(`${API_BASE}/api/user`)).status()).toBe(200);
        }

        const changeTok = await primeCsrf(laptop);
        const changed = await laptop.post(`${API_BASE}/api/user/password`, {
          headers: { 'X-XSRF-TOKEN': changeTok, 'X-Requested-With': 'XMLHttpRequest' },
          data: { current_password: 'TempPass123!', password: 'Changed456!', password_confirmation: 'Changed456!' },
        });
        expect(changed.status()).toBe(200);

        // THE ASSERTION THE TEST IS NAMED AFTER. The other device's cookie must be worthless now.
        expect(
          (await phone.get(`${API_BASE}/api/user`)).status(),
          'the session that did NOT change the password must be ended by the change',
        ).toBe(401);

        /*
         * `endSessionsFor` deletes every row for the user, so the device that initiated the change
         * signs itself out too. Stated rather than glossed over: it is the safe direction, and if it
         * ever stops being true that is a decision somebody made, not a detail to discover in
         * production.
         */
        expect(
          (await laptop.get(`${API_BASE}/api/user`)).status(),
          'the initiating session is ended as well — every row for the user is deleted',
        ).toBe(401);

        // And the new password is the one that works.
        const after = await playwright.request.newContext();
        try {
          const t2 = await primeCsrf(after);
          const ok = await after.post(`${API_BASE}/api/login`, {
            headers: { 'X-XSRF-TOKEN': t2, 'X-Requested-With': 'XMLHttpRequest' },
            data: { username: email, password: 'Changed456!' },
          });
          expect(ok.status(), 'the new password must be usable after the change').toBe(200);
        } finally { await after.dispose(); }
      } finally {
        await laptop.dispose();
        await phone.dispose();
      }

      // Clean up the probe account.
      if (userId) {
        await page.evaluate(async ({ base, id }) => {
          const tok = document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN='))?.split('=')[1];
          await fetch(`${base}/api/users/${id}`, {
            method: 'DELETE', credentials: 'include',
            headers: { 'X-XSRF-TOKEN': decodeURIComponent(tok ?? ''), 'X-Requested-With': 'XMLHttpRequest' },
          });
        }, { base: API_BASE, id: userId });
      }
    } finally { await admin.close(); }
  });
});

// ============================================================ AUTHORIZATION
test.describe('authorization through a real session', () => {
  test('an unauthenticated caller is refused on a protected endpoint', async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      for (const path of ['/api/user', '/api/users', '/api/audit-logs', '/api/leads']) {
        expect((await ctx.get(`${API_BASE}${path}`)).status(), path).toBe(401);
      }
    } finally { await ctx.dispose(); }
  });

  test('an agent is refused the administrator-only screens', async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      await login(ctx, 'agent');
      for (const path of ['/api/users', '/api/audit-logs', '/api/crm-settings']) {
        const res = await ctx.get(`${API_BASE}${path}`);
        expect([401, 403], `${path} answered ${res.status()}`).toContain(res.status());
      }
    } finally { await ctx.dispose(); }
  });

  test('a Super Admin reaches them', async ({ playwright }) => {
    // The guard rail: the test above would also pass if those endpoints were simply broken.
    const ctx = await playwright.request.newContext();
    try {
      await login(ctx, 'superAdmin');
      for (const path of ['/api/users', '/api/audit-logs', '/api/crm-settings']) {
        expect((await ctx.get(`${API_BASE}${path}`)).status(), path).toBe(200);
      }
    } finally { await ctx.dispose(); }
  });
});
