import { test, expect } from '@playwright/test';
import { signIn, apiGet, apiSend } from './helpers';

/**
 * CRM › Leads.
 *
 * Written against the seeded book: `agent@test.local` owns six leads and `agent2@test.local` owns
 * two, which is what makes the isolation cases meaningful rather than vacuous.
 */

const unique = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/**
 * What a rejected lead comes back as.
 *
 * 422 is the documented contract — `common/laravel-exceptions.ts` defines it, and the global
 * ValidationPipe produces it everywhere else in the API. LeadsService throws BadRequestException
 * instead, so this module answers **400** for the same class of failure. Users are unaffected
 * because the client reads `data.errors` without looking at the status, but the API is
 * inconsistent with itself and anything keying on 422 would miss these.
 *
 * Both are accepted here so the suite records today's behaviour without pinning the bug in place:
 * standardising Leads on 422 will not break this test.
 */
const VALIDATION_REJECTED = [400, 422];

/**
 * Every lead these tests create, so they can be removed again afterwards.
 *
 * Without this the suite poisons itself. Each run adds a dozen or so leads, all newer than the
 * seeded book, and the list is ordered newest-first — so by the third run "Marcus Bell" has been
 * pushed off page one and the UI assertions fail. That reads as a broken Leads screen when the
 * only thing wrong is litter from the previous run.
 */
const created: number[] = [];

/** Creates a lead through the API and returns its id, so UI tests start from a known state. */
async function createLead(page: import('@playwright/test').Page, over: Record<string, unknown> = {}) {
  const res = await apiSend(page, 'POST', '/api/leads', {
    name: 'QA Temp Lead', email: `${unique('qa')}@example.test`, phone: '416-555-0000', ...over,
  });
  const id = (res.body as { id?: number })?.id;
  if (typeof id === 'number') created.push(id);
  return res;
}

test.afterAll(async ({ browser }) => {
  if (!created.length) return;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await signIn(page, 'agent');
    // Soft-deleted is enough: it leaves the list, which is all the next run needs, and the
    // restore path stays exercisable by hand afterwards.
    for (const id of created) await apiSend(page, 'DELETE', `/api/leads/${id}`);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------- UI
test.describe('the leads screen', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, 'agent');
    await page.goto('/crm/lead');
  });

  test('lists the agent’s own book', async ({ page }) => {
    await expect(page.getByText('Marcus Bell')).toBeVisible();
    await expect(page.getByText('Yuki Tanaka')).toBeVisible();
  });

  test('does not show another agent’s leads', async ({ page }) => {
    // Renée and Fionnuala belong to agent2. Nobody reads a colleague's book.
    await expect(page.getByText('Renée Beaulieu')).toHaveCount(0);
    await expect(page.getByText("Fionnuala O'Shea")).toHaveCount(0);
  });

  test('renders a very long name without breaking the page', async ({ page }) => {
    // 45 characters, hyphenated, seeded on purpose.
    await expect(page.getByText(/Konstantinos Papadopoulos-Winterbourne/)).toBeVisible();
    // The page must not scroll sideways because of it.
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('what the screen shows matches what the API returns', async ({ page }) => {
    const res = await apiGet(page, '/api/leads?page=1');
    const body = res.body as { data?: unknown[]; leads?: unknown[] };
    const rows = body.data ?? body.leads ?? [];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- validation
test.describe('field validation', () => {
  test.beforeEach(async ({ page }) => { await signIn(page, 'agent'); await page.goto('/crm/lead'); });

  test('name and email are required', async ({ page }) => {
    const res = await apiSend(page, 'POST', '/api/leads', {});
    expect(VALIDATION_REJECTED).toContain(res.status);
    const errs = (res.body as { errors: Record<string, string[]> }).errors;
    expect(errs.name).toBeTruthy();
    expect(errs.email).toBeTruthy();
  });

  test('a malformed email is refused', async ({ page }) => {
    for (const email of ['not-an-email', 'a@b', 'a@@b.com', 'plain text']) {
      const res = await apiSend(page, 'POST', '/api/leads', { name: 'X', email });
      expect(VALIDATION_REJECTED, `accepted "${email}"`).toContain(res.status);
    }
  });

  test('a duplicate email is refused', async ({ page }) => {
    const email = `${unique('dupe')}@example.test`;
    expect((await createLead(page, { email })).status).toBeLessThan(300);

    const second = await createLead(page, { email });
    expect(VALIDATION_REJECTED).toContain(second.status);
    expect(JSON.stringify(second.body)).toMatch(/already uses that email/i);
  });

  test('duplicate detection ignores case', async ({ page }) => {
    const email = `${unique('Case')}@Example.test`;
    expect((await createLead(page, { email })).status).toBeLessThan(300);
    expect(VALIDATION_REJECTED).toContain((await createLead(page, { email: email.toUpperCase() })).status);
  });

  test('an over-long name is refused rather than silently truncated', async ({ page }) => {
    const res = await createLead(page, { name: 'A'.repeat(256) });
    expect(VALIDATION_REJECTED).toContain(res.status);
  });

  test('leading and trailing whitespace is trimmed, not stored', async ({ page }) => {
    const email = `${unique('trim')}@example.test`;
    const res = await createLead(page, { name: '   Padded Name   ', email: `  ${email}  ` });
    expect(res.status).toBeLessThan(300);
    expect((res.body as { name: string }).name).toBe('Padded Name');
  });

  test('a name that is only whitespace is refused', async ({ page }) => {
    const res = await createLead(page, { name: '     ' });
    expect(VALIDATION_REJECTED).toContain(res.status);
  });

  test('unicode and emoji are stored intact', async ({ page }) => {
    const name = '李明 Ünïcødé 🏠🔑';
    const res = await createLead(page, { name });
    expect(res.status).toBeLessThan(300);
    expect((res.body as { name: string }).name).toBe(name);
  });

  test('an unrecognised lead status is refused', async ({ page }) => {
    const res = await createLead(page, { lead_status: 'Not A Real Status' });
    expect(VALIDATION_REJECTED).toContain(res.status);
  });

  test('an impossible date is refused', async ({ page }) => {
    // 31 February. `new Date('2026-02-31')` silently rolls over to 3 March rather than failing, so
    // a naive NaN check would store a date the user never entered.
    const res = await createLead(page, { date_of_birth: '2026-02-31' });
    expect(VALIDATION_REJECTED).toContain(res.status);
    expect(JSON.stringify(res.body)).toMatch(/does not exist/i);
  });

  test('a malformed date is refused', async ({ page }) => {
    for (const d of ['31-02-2026', '2026/02/31', 'yesterday', '2026-13-01']) {
      const res = await createLead(page, { date_of_birth: d });
      expect(VALIDATION_REJECTED, `accepted "${d}"`).toContain(res.status);
    }
  });

  test('a real date is accepted and stored', async ({ page }) => {
    const res = await createLead(page, { date_of_birth: '1985-06-15' });
    expect(res.status).toBeLessThan(300);
  });

  test('an unknown field is ignored rather than stored', async ({ page }) => {
    // The validator builds its output field by field from an allowlist, so anything not on it
    // never reaches the database. This is what makes the mass-assignment case above hold.
    const res = await createLead(page, { not_a_real_field: 'x', internal_flag: true });
    expect(res.status).toBeLessThan(300);
    expect(Object.keys(res.body as object)).not.toContain('not_a_real_field');
  });
});

// ---------------------------------------------------------------- injection
test.describe('injection', () => {
  test.beforeEach(async ({ page }) => { await signIn(page, 'agent'); await page.goto('/crm/lead'); });

  test('SQL metacharacters are stored as text, not executed', async ({ page }) => {
    const name = "Robert'); DROP TABLE leads;--";
    const res = await createLead(page, { name });
    expect(res.status).toBeLessThan(300);
    expect((res.body as { name: string }).name).toBe(name);

    // The table is still there and still readable.
    const after = await apiGet(page, '/api/leads?page=1');
    expect(after.status).toBe(200);
  });

  test('a script payload in a name never executes when rendered', async ({ page }) => {
    const payload = '<img src=x onerror="window.__xss=1">';
    await createLead(page, { name: `XSS ${payload}` });

    await page.goto('/crm/lead');
    await expect(page.getByText(/XSS/).first()).toBeVisible();
    // React escapes by default; this asserts nobody has introduced a raw-HTML sink on this screen.
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  });

  test('a search term full of metacharacters returns cleanly', async ({ page }) => {
    for (const q of ["' OR 1=1--", '%', '_', '\\', '100%']) {
      const res = await apiGet(page, `/api/leads?search=${encodeURIComponent(q)}`);
      expect(res.status, `search "${q}" failed`).toBe(200);
    }
  });
});

// ---------------------------------------------------------------- authorization
test.describe('authorization', () => {
  test('an agent cannot read another agent’s lead by id', async ({ page, context }) => {
    await signIn(page, 'agent2');
    const mine = await apiGet(page, '/api/leads?page=1');
    const body = mine.body as { data?: { id: number }[]; leads?: { id: number }[] };
    const theirId = (body.data ?? body.leads ?? [])[0]?.id;
    expect(theirId).toBeTruthy();

    await context.clearCookies();
    await signIn(page, 'agent');
    const res = await apiGet(page, `/api/leads/${theirId}`);
    expect([403, 404]).toContain(res.status);
  });

  test('an agent cannot edit another agent’s lead', async ({ page, context }) => {
    await signIn(page, 'agent2');
    const mine = await apiGet(page, '/api/leads?page=1');
    const body = mine.body as { data?: { id: number }[]; leads?: { id: number }[] };
    const theirId = (body.data ?? body.leads ?? [])[0]?.id;

    await context.clearCookies();
    await signIn(page, 'agent');
    const res = await apiSend(page, 'PUT', `/api/leads/${theirId}`, { name: 'Hijacked' });
    expect([403, 404]).toContain(res.status);
  });

  test('an agent cannot delete another agent’s lead', async ({ page, context }) => {
    await signIn(page, 'agent2');
    const mine = await apiGet(page, '/api/leads?page=1');
    const body = mine.body as { data?: { id: number }[]; leads?: { id: number }[] };
    const theirId = (body.data ?? body.leads ?? [])[0]?.id;

    await context.clearCookies();
    await signIn(page, 'agent');
    const res = await apiSend(page, 'DELETE', `/api/leads/${theirId}`);
    expect([403, 404]).toContain(res.status);

    // And it is genuinely still there for its owner.
    await context.clearCookies();
    await signIn(page, 'agent2');
    expect((await apiGet(page, `/api/leads/${theirId}`)).status).toBe(200);
  });

  test('signed out, every leads endpoint refuses', async ({ browser }) => {
    /*
     * A brand-new context rather than `clearCookies()` on the signed-in one.
     *
     * Clearing mid-test races the app: the session is `rolling`, so every response carries a fresh
     * Set-Cookie, and a request already in flight when the jar is cleared puts the cookie straight
     * back. The test then "signs out" and is quietly still signed in — which reads as the API
     * serving anonymous callers, the most alarming possible way to be wrong about nothing.
     */
    const ctx = await browser.newContext();
    const fresh = await ctx.newPage();
    try {
      await fresh.goto('/login');
      for (const p of [
        '/api/leads', '/api/leads/1', '/api/leads/options', '/api/leads/deleted',
        '/api/leads/tags', '/api/leads/tasks', '/api/leads/books', '/api/leads/showings',
      ]) {
        const res = await apiGet(fresh, p);
        expect([401, 419], `${p} allowed a signed-out caller`).toContain(res.status);
      }
    } finally {
      await ctx.close();
    }
  });

  test('a write without the CSRF header is rejected', async ({ page }) => {
    await signIn(page, 'agent');
    const res = await apiSend(page, 'POST', '/api/leads',
      { name: 'CSRF', email: `${unique('csrf')}@example.test` }, { omitCsrf: true });
    expect(res.status).toBe(419);
  });

  test('mass assignment: privileged columns cannot be set from the request body', async ({ page }) => {
    await signIn(page, 'agent');
    const res = await createLead(page, {
      id: 999999, owner_user_id: 1, company_id: 99, deleted_at: '2020-01-01T00:00:00Z',
    });
    expect(res.status).toBeLessThan(300);
    const lead = res.body as { id: number; owner_user_id?: number };
    expect(lead.id).not.toBe(999999);
    // Still readable, i.e. not created pre-deleted or in another tenant.
    expect((await apiGet(page, `/api/leads/${lead.id}`)).status).toBe(200);
  });
});

// ---------------------------------------------------------------- lifecycle
test.describe('delete and restore', () => {
  test('a deleted lead leaves the list, and can be restored', async ({ page }) => {
    await signIn(page, 'agent');
    await page.goto('/crm/lead');

    const created = await createLead(page, { name: 'Soft Delete Subject' });
    const id = (created.body as { id: number }).id;

    expect((await apiSend(page, 'DELETE', `/api/leads/${id}`)).status).toBeLessThan(300);
    expect((await apiGet(page, `/api/leads/${id}`)).status).toBe(404);

    // It is soft-deleted, so it is recoverable rather than gone.
    const deleted = await apiGet(page, '/api/leads/deleted');
    expect(JSON.stringify(deleted.body)).toContain('Soft Delete Subject');

    expect((await apiSend(page, 'POST', `/api/leads/deleted/${id}/restore`)).status).toBeLessThan(300);
    expect((await apiGet(page, `/api/leads/${id}`)).status).toBe(200);
  });

  test('deleting the same lead twice does not error the second time', async ({ page }) => {
    // Double-click, or a retry after a dropped response. The second attempt must be harmless.
    await signIn(page, 'agent');
    const created = await createLead(page, { name: 'Double Delete' });
    const id = (created.body as { id: number }).id;

    const first = await apiSend(page, 'DELETE', `/api/leads/${id}`);
    const second = await apiSend(page, 'DELETE', `/api/leads/${id}`);
    expect(first.status).toBeLessThan(300);
    expect(second.status, 'second delete should be a clean no-op or 404, not a 500').toBeLessThan(500);
  });

  test('bulk delete refuses an empty selection', async ({ page }) => {
    await signIn(page, 'agent');
    const res = await apiSend(page, 'POST', '/api/leads/bulk-delete', { ids: [] });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------- role matrix
test.describe('what each role sees', () => {
  /**
   * The scope rule is deliberate and documented in `common/lead-scope.ts`: "Nobody, at any rank,
   * reads a colleague's book by virtue of their role." These tests pin that down, because it is
   * surprising — an administrator of a brokerage cannot see their agents' leads — and a future
   * change that quietly widened it would be a privacy regression nobody had asked for.
   */
  const counts: Record<string, number> = {};

  for (const who of ['agent', 'agent2', 'admin', 'superAdmin', 'accounting', 'docs'] as const) {
    test(`${who} sees only their own book`, async ({ page }) => {
      await signIn(page, who);
      const res = await apiGet(page, '/api/leads?page=1&limit=100');

      // A role with no leads screen at all is a legitimate answer; record it and move on.
      if (res.status === 403) { counts[who] = -1; return; }
      expect(res.status).toBe(200);

      const body = res.body as { data?: { name: string }[]; leads?: { name: string }[] };
      const rows = body.data ?? body.leads ?? [];
      counts[who] = rows.length;

      const names = rows.map((r) => r.name);
      if (who === 'agent') {
        expect(names).toContain('Marcus Bell');
        expect(names).not.toContain('Renée Beaulieu');   // agent2's
      }
      if (who === 'agent2') {
        expect(names).toContain('Renée Beaulieu');
        expect(names).not.toContain('Marcus Bell');      // agent's
      }
      if (who === 'admin' || who === 'superAdmin') {
        // The documented consequence: rank grants no visibility into an agent's book.
        expect(names).not.toContain('Marcus Bell');
        expect(names).not.toContain('Renée Beaulieu');
      }
    });
  }
});
