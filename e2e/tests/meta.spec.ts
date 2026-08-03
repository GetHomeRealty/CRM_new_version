import { expect, test } from '@playwright/test';
import { apiGet, apiSend, signIn } from './helpers';

/**
 * The Meta screen renders, for everybody who can reach it.
 *
 * WHY THIS EXISTS. The Meta module had no browser coverage at all — every finding in its audit came
 * from reading code or probing services directly. The CRM Dashboard had the same gap, and that is
 * exactly how a render crash reached a user: one panel destructured a field the server had stopped
 * sending, and the error boundary replaced the whole page.
 *
 * Nothing here needs a live Facebook connection, which is deliberate — the disconnected state is
 * the state every agent sees before they connect, and it is the one a first-run user meets. It is
 * also the state that renders the most conditional markup, since every "connected" branch is
 * absent.
 */

const BOUNDARY = /This page could not be displayed/i;

for (const who of ['agent', 'admin', 'superAdmin'] as const) {
  test(`the Meta screen renders for ${who}`, async ({ page }) => {
    const crashes: string[] = [];
    page.on('pageerror', (e) => crashes.push(e.message));

    await signIn(page, who);
    await page.goto('/crm/meta');

    await expect(page.getByRole('heading', { name: 'Meta', exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(BOUNDARY)).toHaveCount(0);
    // A crash still renders something, so assert on the error itself rather than the symptom.
    expect(crashes).toEqual([]);
  });
}

test('an unconnected account is told so, rather than shown an empty screen', async ({ page }) => {
  await signIn(page, 'agent');
  await page.goto('/crm/meta');

  await expect(page.getByText('Not connected.')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(BOUNDARY)).toHaveCount(0);
});

/**
 * Webhook health is the module's only read that was ever unscoped: it returned every agent's
 * `leadgen_id`, `form_id`, `page_id` and resulting `lead_id` to anybody with `meta:view` (M-M1).
 * The fix is server-side, so this asserts through the browser's own session that one agent's view
 * cannot carry another's identifiers.
 */
test('webhook health shows an agent nothing belonging to a colleague', async ({ page }) => {
  await signIn(page, 'agent');

  const res = await apiGet(page, '/api/meta/webhook-health');
  expect(res.status).toBe(200);

  const body = res.body as { total: number; events: unknown[]; connected_forms: number };
  expect(Array.isArray(body.events)).toBe(true);
  // This agent has no connected forms in the seed, so there is nothing that could be theirs.
  expect(body.connected_forms).toBe(0);
  expect(body.events).toHaveLength(0);
  expect(body.total).toBe(0);
});

/**
 * Manual sync fans out to Graph, whose limits are per APP — so one person pressing Sync spends a
 * budget every other agent draws from (M-M8). Six a minute is the ceiling.
 */
test('manual sync is rate limited, so one person cannot spend the whole app budget', async ({ page }) => {
  await signIn(page, 'agent');

  const codes: number[] = [];
  for (let i = 0; i < 9; i += 1) {
    const res = await apiSend(page, 'POST', '/api/meta/sync');
    codes.push(res.status);
  }

  // The endpoint refuses for its own reasons when Meta is not connected; what matters is that the
  // throttler starts turning requests away well before nine.
  expect(codes).toContain(429);
  expect(codes.indexOf(429)).toBeLessThanOrEqual(6);
});
