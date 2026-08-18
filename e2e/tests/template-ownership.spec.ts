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

/**
 * The campaign template library holds templates somebody created for a campaign, and nothing else.
 *
 * WHAT THESE REPLACE. Three tests here asserted the opposite — that an agent still SEES the shipped
 * built-ins, that a Super Admin may edit one, that an agent may not. Those were correct about a
 * screen that offered two groups, the second of which was headed "CRM Templates" and did not contain
 * a single CRM template: the rows are `campaign_templates`, seeded marketing starters, while the
 * CRM's own Birthday, Anniversary, Seasonal, New Lead and Lead Assigned emails live in
 * `email_templates` and have never been reachable from Campaigns at all.
 *
 * The brokerage's decision is that this library lists only what somebody authored for a campaign. So
 * the built-ins are no longer served by the list, no longer offered by the builder's picker, and no
 * longer accepted by the send endpoint. The rows themselves are untouched, which is why the last
 * test below can still assert that a campaign already built on one is unaffected.
 */
test.describe('only templates authored for campaigns are offered', () => {
  for (const who of ['superAdmin', 'agent'] as const) {
    test(`${who} is not shown the shipped built-ins`, async ({ page }) => {
      await signIn(page, who);
      const list = await apiGet(page, '/api/campaigns/templates');
      const rows = (((list.body as { data?: Record<string, unknown>[] })?.data
        ?? (list.body as Record<string, unknown>[])) ?? []) as Record<string, unknown>[];
      expect(findBuiltIn(rows), `${who} was still shown a built-in in the library`).toBeUndefined();
    });

    test(`${who} is not offered a built-in by the campaign builder`, async ({ page }) => {
      // The picker and the library must agree. They did not: `options` listed every active row
      // regardless of owner, so a template the Templates screen refused to show was still selectable.
      await signIn(page, who);
      const opts = await apiGet(page, '/api/campaigns/options');
      const templates = ((opts.body as { templates?: Record<string, unknown>[] })?.templates ?? []);
      expect(findBuiltIn(templates), `${who} was offered a built-in in the builder`).toBeUndefined();
    });
  }

  test('every template the builder offers is one the library also lists', async ({ page }) => {
    /*
     * The general form of the two assertions above, and the one that keeps holding after the seed
     * names change. A picker offering anything the library does not list is the class of bug this
     * change closes, whatever the reason for the extra row.
     */
    await signIn(page, 'agent');
    const list = await apiGet(page, '/api/campaigns/templates');
    const rows = (((list.body as { data?: Record<string, unknown>[] })?.data
      ?? (list.body as Record<string, unknown>[])) ?? []) as Record<string, unknown>[];
    const listed = new Set(rows.map((r) => r.id));

    const opts = await apiGet(page, '/api/campaigns/options');
    const offered = ((opts.body as { templates?: Record<string, unknown>[] })?.templates ?? []);
    // `is_active: false` templates are listed but not offered, so this is one-directional.
    for (const t of offered) {
      expect(listed.has(t.id), `the builder offered template #${t.id}, which the library does not list`).toBe(true);
    }
  });

  test('a campaign cannot be built from a template that is not the caller’s', async ({ page, browser }) => {
    // The endpoint has to refuse what the picker no longer offers, or the choice was only hidden.
    const id = await agentTemplate(page);
    const ctx = await browser.newContext();
    try {
      const other = await ctx.newPage();
      await signIn(other, 'agent2');
      const res = await apiSend(other, 'POST', '/api/campaigns', {
        name: `${TAG} cross-owner ${Date.now()}`, template_id: id, leadStatus: '',
      });
      expect(res.status, 'another agent sent a campaign from a template they cannot see').toBe(404);
    } finally {
      await ctx.close();
      await apiSend(page, 'DELETE', `/api/campaigns/templates/${id}`);
    }
  });

  test('campaigns already built on a built-in still read back intact', async ({ page }) => {
    /*
     * The rows were filtered out of two lists, not deleted. A campaign snapshots its subject and
     * body at create time and resolves attachments by `template_id` alone, so its history and any
     * send still in flight are unaffected — which is the whole reason this was a filter.
     */
    await signIn(page, 'superAdmin');
    const res = await apiGet(page, '/api/campaigns');
    expect(res.status).toBe(200);
    const rows = (((res.body as { data?: Record<string, unknown>[] })?.data
      ?? (res.body as Record<string, unknown>[])) ?? []) as Record<string, unknown>[];
    /*
     * `template_name` rather than `subject`: the list summary carries the former and not the
     * latter. It is the snapshot that matters here anyway — it is written at create time from the
     * template and never re-read from it, so a campaign built on a template this change stopped
     * listing still names it.
     */
    for (const c of rows) {
      if (c.template_id == null) continue;   // a campaign whose template row was hard-deleted
      expect(String(c.template_name ?? ''), `campaign #${c.id} lost its stored template name`).not.toBe('');
    }
  });
});
