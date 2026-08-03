import { expect, type Page } from '@playwright/test';

/** Every seeded account shares this. See server/scripts/seed-test-env.cjs. */
export const PASSWORD = 'TestPass123!';

export const ACCOUNTS = {
  superAdmin: { email: 'superadmin@test.local', name: 'Sam Whitfield',   role: 'admin' },
  admin:      { email: 'admin@test.local',      name: 'Priya Raman',     role: 'manager' },
  agent:      { email: 'agent@test.local',      name: 'Dana Okafor',     role: 'agent' },
  agent2:     { email: 'agent2@test.local',     name: 'Luis Moreau',     role: 'agent' },
  accounting: { email: 'accounting@test.local', name: 'Grace Lindqvist', role: 'accounting' },
  docs:       { email: 'docs@test.local',       name: 'Tomas Iversen',   role: 'documentation' },
  crm:        { email: 'crm@test.local',        name: 'Ada Nkemelu',     role: 'crm' },
} as const;

export type AccountKey = keyof typeof ACCOUNTS;

/**
 * Sign in through the real form rather than by planting a cookie.
 *
 * Going through the form is the point: it exercises the CSRF cookie exchange, the session cookie's
 * attributes and the redirect afterwards. A test that injects a session proves the pages render
 * but says nothing about whether anyone can actually get in — which is the failure that would
 * matter most on the morning of a release.
 */
export async function signIn(page: Page, who: AccountKey): Promise<void> {
  const account = ACCOUNTS[who];
  await page.goto('/login');
  await page.fill('input[name="username"]', account.email);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');

  // Landing anywhere other than /login means the session was accepted.
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
}

export async function signOut(page: Page): Promise<void> {
  await page.context().clearCookies();
}

/**
 * Where the test API is. Must match playwright.config.ts.
 *
 * Not read from `import.meta.env` — that is Vite's, and this file is parsed by Node, where the
 * mere mention of it is a syntax error.
 */
export const API_BASE = process.env.E2E_API_BASE ?? 'http://localhost:8100';

/**
 * Calls the API from inside the page, so it carries the browser's own session cookie.
 *
 * Used to check what is on screen against what the server actually returned — the difference
 * between "the list looks plausible" and "the list is what the API said".
 */
export async function apiGet(page: Page, path: string): Promise<{ status: number; body: unknown }> {
  return page.evaluate(async ({ base, p }) => {
    const r = await fetch(`${base}${p}`, { credentials: 'include', headers: { Accept: 'application/json' } });
    let body: unknown = null;
    try { body = await r.json(); } catch { body = null; }
    return { status: r.status, body };
  }, { base: API_BASE, p: path });
}

/**
 * A state-changing call, made the way the SPA makes it.
 *
 * The XSRF-TOKEN cookie has to be echoed back in the X-XSRF-TOKEN header — axios does that
 * automatically in the app via `withXSRFToken`, and anything hand-rolled has to do it too or
 * every write comes back 419. Sending it by hand is also what lets a test deliberately omit it
 * and prove the CSRF check is real.
 */
export async function apiSend(
  page: Page,
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  opts: { omitCsrf?: boolean } = {},
): Promise<{ status: number; body: unknown }> {
  return page.evaluate(async ({ base, p, m, b, omit }) => {
    const token = document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN='))?.split('=')[1];
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    };
    if (token && !omit) headers['X-XSRF-TOKEN'] = decodeURIComponent(token);
    const r = await fetch(`${base}${p}`, {
      method: m, credentials: 'include', headers,
      body: b === undefined ? undefined : JSON.stringify(b),
    });
    let out: unknown = null;
    try { out = await r.json(); } catch { out = null; }
    return { status: r.status, body: out };
  }, { base: API_BASE, p: path, m: method, b: body, omit: !!opts.omitCsrf });
}
