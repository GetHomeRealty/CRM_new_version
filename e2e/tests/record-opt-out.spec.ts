import { test, expect, type Page } from '@playwright/test';
import { signIn, apiSend, apiGet } from './helpers';

/**
 * CRM-031: a brokerage told "stop emailing me" has to be able to act on it.
 *
 * THE GAP THIS CLOSES. The only route onto the suppression list was the client clicking the
 * unsubscribe link in an email. Told by telephone, in person, or in a reply, staff had nothing: the
 * lead's Unsubscribed badge is display-only, the editor has no field for it, and the API offered
 * read and delete and no create. The only way to stop mailing somebody was to keep mailing them
 * until they clicked.
 *
 * THE ASYMMETRY IS THE DESIGN, and it is what these tests pin. Recording an opt-out is available to
 * an ordinary AGENT — the person who took the call — while reversing one needs the marketing
 * capability (CRM-027). Honouring a request to stop must never be the harder of the two directions.
 *
 * REAL ADDRESSES ARE NEVER USED: every case works on an unroutable `.invalid` address it creates
 * and removes itself.
 */

const unique = () => `zz-optout-${Date.now()}-${Math.floor(Math.random() * 1e6)}@probe.invalid`;

/** Take the address back off the list as an administrator, whatever the test did. */
async function cleanUp(page: Page, addr: string) {
  await signIn(page, 'superAdmin');
  await apiSend(page, 'DELETE', `/api/campaigns/suppressions/${encodeURIComponent(addr)}`).catch(() => undefined);
}

test.describe('staff can record an opt-out', () => {
  test('an ordinary agent may record one', async ({ page }) => {
    const addr = unique();
    await signIn(page, 'agent');

    // THE DEFECT: there was no create verb at all — this was a 404.
    const res = await apiSend(page, 'POST', '/api/campaigns/suppressions', {
      email: addr, reason: 'asked by telephone',
    });
    expect([200, 201]).toContain(res.status);

    /*
     * READ BACK AS AN ADMINISTRATOR, and the reason is worth recording. An agent's view of this list
     * is scoped to the addresses of their OWN leads, so a probe address belonging to no lead is
     * correctly invisible to them even though they just recorded it. That scoping is deliberate and
     * predates this work; what matters here is that the opt-out was stored and will be enforced.
     */
    await signIn(page, 'superAdmin');
    const list = await apiGet(page, `/api/campaigns/suppressions?search=${encodeURIComponent(addr)}`);
    const body = JSON.stringify(list.body);
    expect(body).toContain(addr);
    // The reason is kept, and marked as staff-recorded so the list says how it got there.
    expect(body).toMatch(/staff: asked by telephone/i);

    await cleanUp(page, addr);
  });

  test('the same agent may NOT reverse one', async ({ page }) => {
    /*
     * The pair that makes the asymmetry real rather than stated. If recording and reversing needed
     * the same right, restricting the reversal would have made honouring a request harder too.
     */
    const addr = unique();
    await signIn(page, 'agent');
    await apiSend(page, 'POST', '/api/campaigns/suppressions', { email: addr, reason: 'phoned' });

    const refused = await apiSend(page, 'DELETE', `/api/campaigns/suppressions/${encodeURIComponent(addr)}`);
    expect(refused.status).toBe(403);

    await cleanUp(page, addr);
  });

  test('a malformed address is refused rather than stored', async ({ page }) => {
    await signIn(page, 'agent');
    for (const bad of ['', 'not-an-email', 'stop emailing me']) {
      const res = await apiSend(page, 'POST', '/api/campaigns/suppressions', { email: bad });
      // 400/422 specifically, not merely "an error": `>= 400` would also be satisfied by the 404
      // of a route that does not exist, so it would pass against the very defect being fixed.
      expect([400, 422], `accepted "${bad}" with ${res.status}`).toContain(res.status);
    }
  });

  test('recording it twice does not duplicate or overwrite', async ({ page }) => {
    // The FIRST record is the one that matters — overwriting its reason would lose why they asked.
    const addr = unique();
    await signIn(page, 'agent');
    await apiSend(page, 'POST', '/api/campaigns/suppressions', { email: addr, reason: 'first reason' });
    const second = await apiSend(page, 'POST', '/api/campaigns/suppressions', { email: addr, reason: 'second reason' });
    expect([200, 201]).toContain(second.status);
    expect((second.body as { already?: boolean }).already).toBe(true);

    await signIn(page, 'superAdmin');   // see the note above on the agent's scoped view
    const list = await apiGet(page, `/api/campaigns/suppressions?search=${encodeURIComponent(addr)}`);
    const rows = (list.body as { data: { email: string; reason: string }[] }).data;
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toMatch(/first reason/);

    await cleanUp(page, addr);
  });

  test('the confirmation survives, and explains a row the agent cannot see', async ({ page }) => {
    /*
     * THE CASE THE TOAST ALONE HANDLED BADLY. An agent's view is scoped to their own leads'
     * addresses, so recording an opt-out for anybody else produces no visible row — correctly. A
     * toast saying it worked disappears in seconds and the empty list stays on screen, which reads
     * as a failure. The acknowledgement therefore persists and says why the row is absent.
     */
    const addr = unique();
    await signIn(page, 'agent');
    await page.goto('/crm/campaigns');
    await page.getByRole('button', { name: /Suppression/i }).first().click();

    await page.getByLabel('Email address that asked to stop').fill(addr);
    await page.getByRole('button', { name: /Record opt-out/i }).click();

    /*
     * THE PANEL, not the toast. Both say the same sentence - deliberately, since it is the same
     * fact - so the locator has to name which one it means. The panel is the one under test: the
     * toast was always there and was never the problem.
     */
    const confirmation = page.locator('.reminder-ok').filter({ hasText: `Opt-out recorded for ${addr}.` });
    await expect(confirmation).toBeVisible({ timeout: 10_000 });
    // The address is on no lead, so this agent cannot see it in the list — and is told as much.
    await expect(page.getByText(/shows opt-outs for your own leads/i)).toBeVisible();

    // It stays put rather than fading, and goes only when dismissed.
    await page.waitForTimeout(6_000);
    await expect(confirmation).toBeVisible();
    await page.getByRole('button', { name: /^Dismiss$/ }).click();
    await expect(confirmation).toHaveCount(0);

    await cleanUp(page, addr);
  });

  test('the screen offers the control, and it works end to end', async ({ page }) => {
    const addr = unique();
    await signIn(page, 'agent');
    await page.goto('/crm/campaigns');
    await page.getByRole('button', { name: /Suppression/i }).first().click();

    await page.getByLabel('Email address that asked to stop').fill(addr);
    await page.getByLabel('How the request was received').fill('said so at the open house');
    await page.getByRole('button', { name: /Record opt-out/i }).click();

    await expect(page.locator('.reminder-ok').filter({ hasText: `Opt-out recorded for ${addr}.` }))
      .toBeVisible({ timeout: 10_000 });

    await signIn(page, 'superAdmin');   // see the note above on the agent's scoped view
    const list = await apiGet(page, `/api/campaigns/suppressions?search=${encodeURIComponent(addr)}`);
    expect(JSON.stringify(list.body)).toContain(addr);

    await cleanUp(page, addr);
  });
});
