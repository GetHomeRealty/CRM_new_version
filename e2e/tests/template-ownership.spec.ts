import { test, expect } from '@playwright/test';
import { signIn, apiGet, apiSend } from './helpers';

/**
 * An agent's custom campaign templates are owner-private — including from a Super Admin.
 *
 * The brokerage's rule: a Super Admin administers everything else, but a template an agent has
 * written and not sent is their working notes, not an administrative object. Before this, both the
 * visibility filter and the edit guard began `if (!isAgent(user)) return`, so every non-agent role
 * saw and could edit every agent's drafts — measured, a Super Admin renamed one and got 200.
 *
 * Each test signs in on its OWN page fixture. Sharing a BrowserContext replaces the session cookie
 * for every page in it, which silently turned an earlier isolation probe into a cross-user read.
 */

const TAG = 'ZZTPL';

/**
 * The shipped templates, identified by NAME.
 *
 * The API's `present()` does not expose `user_id`, so a check like `r.user_id === null` never
 * matches — an earlier version of these tests reported that an agent could see zero built-ins, which
 * was a broken detector rather than a regression. These six names come from the seed migration.
 */
const BUILT_IN = /^(Welcome|Follow-up|Showing|Property Update|Thank You|Monthly Market Update)/;
const findBuiltIn = (rows: Record<string, unknown>[]) => rows.find((r) => BUILT_IN.test(String(r.name ?? '')));


/** Create a template as the agent and return its id. */
async function agentTemplate(page: import('@playwright/test').Page): Promise<number> {
  await signIn(page, 'agent');
  const made = await apiSend(page, 'POST', '/api/campaigns/templates', {
    name: `${TAG} private ${Date.now()}`, subject: 'Mine', content: 'Body', category: 'custom',
  });
  expect(made.status, 'the agent must be able to create their own template').toBeLessThan(300);
  return (made.body as Record<string, unknown>).id as number;
}

test.describe('an agent’s template is private to them', () => {
  for (const who of ['superAdmin', 'admin', 'crm', 'agent2'] as const) {
    test(`${who} cannot list, read, edit or delete it`, async ({ page, browser }) => {
      const id = await agentTemplate(page);

      const ctx = await browser.newContext();
      try {
        const other = await ctx.newPage();
        await signIn(other, who);

        // 1. Template list visibility
        const list = await apiGet(other, '/api/campaigns/templates');
        const rows = (((list.body as { data?: Record<string, unknown>[] })?.data
          ?? (list.body as Record<string, unknown>[])) ?? []) as Record<string, unknown>[];
        expect(rows.some((r) => r.id === id), `${who} saw the agent's template in the list`).toBe(false);

        // 2. Direct read — and 3. guessing the id, which is the same request
        expect((await apiGet(other, `/api/campaigns/templates/${id}`)).status).toBe(404);

        // 4. Edit  5. Delete — direct API access, no UI involved
        expect((await apiSend(other, 'PUT', `/api/campaigns/templates/${id}`, { name: 'hijacked' })).status).toBe(404);
        expect((await apiSend(other, 'DELETE', `/api/campaigns/templates/${id}`)).status).toBe(404);
      } finally {
        await ctx.close();
      }

      // 6. Untouched, and still the agent's.
      const mine = await apiGet(page, `/api/campaigns/templates/${id}`);
      expect(mine.status).toBe(200);
      expect(String((mine.body as Record<string, unknown>).name)).toContain(TAG);
      await apiSend(page, 'DELETE', `/api/campaigns/templates/${id}`);
    });
  }
});

test.describe('what administrators keep', () => {
  test('a Super Admin may still edit a built-in template', async ({ page }) => {
    // The counterpart: the rule must not have locked administrators out of the shared set.
    await signIn(page, 'superAdmin');
    const list = await apiGet(page, '/api/campaigns/templates');
    const rows = (((list.body as { data?: Record<string, unknown>[] })?.data
      ?? (list.body as Record<string, unknown>[])) ?? []) as Record<string, unknown>[];
    const builtIn = findBuiltIn(rows);
    test.skip(!builtIn, 'no built-in template visible to assert against');

    const original = String(builtIn!.name);
    const res = await apiSend(page, 'PUT', `/api/campaigns/templates/${builtIn!.id}`, { name: original });
    expect(res.status).toBe(200);
  });

  test('an agent may not edit a built-in template', async ({ page }) => {
    await signIn(page, 'agent');
    const list = await apiGet(page, '/api/campaigns/templates');
    const rows = (((list.body as { data?: Record<string, unknown>[] })?.data
      ?? (list.body as Record<string, unknown>[])) ?? []) as Record<string, unknown>[];
    const builtIn = findBuiltIn(rows);
    test.skip(!builtIn, 'no built-in template visible to assert against');

    const res = await apiSend(page, 'PUT', `/api/campaigns/templates/${builtIn!.id}`, { name: 'agent edit' });
    expect(res.status).toBe(403);
  });

  test('an agent still sees the built-ins', async ({ page }) => {
    // Privacy must not have hidden the shared starting set from the people who need it.
    await signIn(page, 'agent');
    const list = await apiGet(page, '/api/campaigns/templates');
    const rows = (((list.body as { data?: Record<string, unknown>[] })?.data
      ?? (list.body as Record<string, unknown>[])) ?? []) as Record<string, unknown>[];
    expect(rows.filter((r) => BUILT_IN.test(String(r.name ?? ''))).length).toBeGreaterThan(0);
  });
});
