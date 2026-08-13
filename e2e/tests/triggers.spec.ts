import { test, expect } from '@playwright/test';
import { signIn, apiGet, apiSend, API_BASE } from './helpers';

/**
 * CRM › Triggers — the client-side findings of the 2026-08-04 audit.
 *
 * The server-side ones are pinned in `crm-triggers-findings.spec.ts`; these three can only be seen
 * in a browser: a screen that never re-reads, a kill switch that asked nothing, and a session
 * expiry reported in the framework's own word for it.
 */

test.describe('T-M3 — the screen re-reads when you come back to it', () => {
  test('picks up a brokerage change made elsewhere, without a manual reload', async ({ page, context }) => {
    await signIn(page, 'superAdmin');
    await page.goto('/crm/triggers');
    await expect(page.getByRole('heading', { name: 'CRM Triggers' })).toBeVisible({ timeout: 15_000 });

    const before = await apiGet(page, '/api/crm-settings/email-settings');
    const original = (before.body as Record<string, unknown>).autoSendEnabled;

    /*
     * Another administrator turns CRM email off for the brokerage. Measured during the audit: the
     * open screen went on showing the old state indefinitely, because nothing ever re-read it.
     */
    const other = await context.newPage();
    await signIn(other, 'superAdmin');
    await apiSend(other, 'PUT', '/api/crm-settings/email-settings', { autoSendEnabled: false });

    try {
      /*
       * The `focus` event is what the browser raises when a tab is returned to, and dispatching it
       * is what a headless run can actually do — `bringToFront()` does not raise it in headless
       * Chromium, which is why this reads as an event rather than as a gesture.
       */
      await page.evaluate(() => { window.dispatchEvent(new Event('focus')); });
      await expect(page.getByText(/switched off for the whole brokerage/i)).toBeVisible({ timeout: 10_000 });
    } finally {
      await apiSend(other, 'PUT', '/api/crm-settings/email-settings', { autoSendEnabled: original });
      await other.close();
    }
  });

  test('does NOT re-read over unsaved edits', async ({ page }) => {
    // Refreshing while somebody has half-flipped switches would throw their work away to fix a
    // display problem — a worse bug than the one being fixed.
    await signIn(page, 'superAdmin');
    await page.goto('/crm/triggers');
    await expect(page.getByRole('heading', { name: 'CRM Triggers' })).toBeVisible({ timeout: 15_000 });

    const box = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'CRM Triggers' }) }).locator('.crm-toggle input[type=checkbox]').first();
    const was = await box.isChecked();
    await box.setChecked(!was);
    await expect(page.getByRole('button', { name: /^Save \d+ change/ })).toBeVisible();

    await page.evaluate(() => { window.dispatchEvent(new Event('focus')); });
    await page.waitForTimeout(1200);

    // The edit survived the focus event.
    expect(await box.isChecked()).toBe(!was);
    await expect(page.getByRole('button', { name: /^Save \d+ change/ })).toBeVisible();
  });
});

/**
 * The switch has moved SCREENS, and the behaviour asserted below is unchanged by the move.
 *
 * "Email Campaigns" was removed from CRM Settings as a duplicate of the Campaigns screen, and this
 * control — the only writable path to `crm_email_settings.auto_send_enabled` — went with it by
 * accident. It now sits in a "Brokerage" card at the top of THIS screen, which was already the one
 * reporting it: the notice below used to tell an administrator to go to CRM Settings to act on a
 * warning they were reading here.
 *
 * It is still gated on `settings`, not on `triggers`. Everything else on this screen is one row per
 * person, which is why `triggers` was safe to widen to every agent; this switch is one row for the
 * whole brokerage, so an agent sees the notice and no control. `write-authorization.spec.ts` is
 * where that boundary is proved against the API — the card being absent is a courtesy, not the gate.
 *
 * Selectors here are scoped to their card. Both cards render `.crm-toggle`, so an unscoped `.first()`
 * silently means the brokerage switch, and a test meaning to flip a personal trigger would instead
 * be changing what every colleague can send.
 */
test.describe('T-M5 — the brokerage kill switch asks first', () => {
  test('switching CRM email off for everyone is confirmed', async ({ page }) => {
    await signIn(page, 'superAdmin');

    /*
     * ON BEFORE THE PAGE LOADS, not after — the subject is the TRANSITION to off, so the screen has
     * to have been opened on a brokerage that allows CRM email. Ticking the box in the browser
     * cannot establish that: it changes the pending value, while the confirmation compares against
     * what the screen loaded with. This test used to do exactly that and passed only as long as the
     * flag happened to already be on, which the `settings-*` files do not guarantee.
     */
    const original = ((await apiGet(page, '/api/crm-settings/email-settings')).body as { autoSendEnabled?: boolean }).autoSendEnabled ?? true;
    await apiSend(page, 'PUT', '/api/crm-settings/email-settings', { autoSendEnabled: true });

    await page.goto('/crm/triggers');
    await page.waitForLoadState('networkidle');

    const master = page.locator('.crm-toggle', { hasText: "Allow the CRM's per-lead emails" }).locator('input[type=checkbox]');
    await expect(master).toBeVisible({ timeout: 15_000 });
    await expect(master).toBeChecked();

    try {
      await master.setChecked(false);
      await page.getByRole('button', { name: /Save CRM Email/i }).click();

      // The whole point: a dialog, not a silent save.
      await expect(page.getByText(/Switch off CRM email for the whole brokerage/i)).toBeVisible({ timeout: 10_000 });

      // Backing out leaves it alone. Scoped to the dialog: 'Cancel' also appears on other
      // cards of this screen, and clicking the wrong one proves nothing.
      await page.locator('.modal, [role=dialog]').getByRole('button', { name: 'Cancel' }).click();
      // Still on — cancelling a confirmation must not be a slower way of agreeing to it. Compared
      // against the value this test established above, not against whatever it inherited.
      const after = await apiGet(page, '/api/crm-settings/email-settings');
      expect((after.body as Record<string, unknown>).autoSendEnabled).toBe(true);
    } finally {
      await apiSend(page, 'PUT', '/api/crm-settings/email-settings', { autoSendEnabled: original });
    }
  });

  test('turning it back ON is not confirmed', async ({ page }) => {
    // A confirmation on every save is one people learn to click through. Only the off transition.
    await signIn(page, 'superAdmin');
    await apiSend(page, 'PUT', '/api/crm-settings/email-settings', { autoSendEnabled: false });
    await page.goto('/crm/triggers');
    await page.waitForLoadState('networkidle');

    const master = page.locator('.crm-toggle', { hasText: "Allow the CRM's per-lead emails" }).locator('input[type=checkbox]');
    await expect(master).toBeVisible({ timeout: 15_000 });
    await master.setChecked(true);
    await page.getByRole('button', { name: /Save CRM Email/i }).click();

    await expect(page.getByText(/Switch off CRM email for the whole brokerage/i)).toHaveCount(0);
    await expect(page.getByText(/Settings updated successfully/i)).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('T-M9 — an expired session says what happened', () => {
  test('a save after the cookies are gone does not report "Unauthenticated."', async ({ page }) => {
    await signIn(page, 'superAdmin');
    await page.goto('/crm/triggers');
    await expect(page.getByRole('heading', { name: 'CRM Triggers' })).toBeVisible({ timeout: 15_000 });

    const box = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'CRM Triggers' }) }).locator('.crm-toggle input[type=checkbox]').first();
    await box.setChecked(!(await box.isChecked()));

    // The session ends underneath them, which is what a timeout looks like from the page's side.
    await page.context().clearCookies();
    await page.getByRole('button', { name: /^Save \d+ change/ }).click();

    await expect(page.getByText(/Your session has ended/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/^Unauthenticated\.?$/)).toHaveCount(0);
  });

  test('the API really does answer 401 there, so the test above is not asserting on nothing', async ({ playwright }) => {
    /*
     * A BRAND-NEW request context, never signed in. An earlier version of this cleared the page's
     * cookies and reused `page.request`, which answered 200 — not because the endpoint is open, but
     * because that context carries its own session state. The assertion was testing Playwright
     * rather than the application; a fresh context tests the application.
     */
    const ctx = await playwright.request.newContext();
    try {
      const res = await ctx.get(`${API_BASE}/api/crm-settings/triggers`);
      expect(res.status()).toBe(401);
    } finally { await ctx.dispose(); }
  });
});
