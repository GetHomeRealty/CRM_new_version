import { test, expect } from '@playwright/test';
import { signIn, apiGet, apiSend } from './helpers';

/**
 * The CRM Triggers module is gone; Transaction Desk Triggers is not.
 *
 * WHAT THIS FILE USED TO BE. Four describes exercising `/crm/triggers` — that the screen re-read
 * itself on focus (T-M3), that it did not re-read over unsaved edits, that the brokerage kill switch
 * asked before switching CRM email off for everybody (T-M5), and that an expired session said so
 * (T-M9). Every one of them was about a screen that no longer exists.
 *
 * WHAT REPLACES THEM. The controls moved rather than went, so the tests follow them: the personal
 * switches and the brokerage card are now on CRM → Communications and are covered in
 * `crm-communications.spec.ts`, including the confirmation before the master switch goes off. What
 * belongs HERE is the boundary this cleanup had to hold — the CRM half is unreachable and the
 * Transaction Desk half is untouched. Those are the two things a regression would break.
 */

test.describe('the CRM Triggers module is gone', () => {
  test('/crm/triggers no longer serves a CRM Triggers screen', async ({ page }) => {
    await signIn(page, 'superAdmin');
    await page.goto('/crm/triggers');

    /*
     * `triggers` is a real screen that now belongs to the Desk, so `AreaFallback` redirects rather
     * than showing a stub — an existing bookmark lands somewhere that works. Asserted on the URL
     * because that is the observable promise: you do not stay in the CRM.
     */
    await expect(page).toHaveURL(/\/desk\/triggers/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'CRM Triggers' })).toHaveCount(0);
  });

  test('the CRM sidebar offers no Triggers entry', async ({ page }) => {
    await signIn(page, 'superAdmin');
    await page.goto('/crm/dashboard');
    /*
     * Scoped to the navigation: "Triggers" appears in prose elsewhere, and matching that would make
     * this pass or fail on wording rather than on navigation.
     *
     * `button`, NOT `link` — the sidebar navigates with `onClick`, so there is not an anchor in it.
     * An earlier version asked for a link and asserted zero of them, which passed because there are
     * zero links whatever the menu contains: an assertion that could not fail. The `Leads` check
     * below is what keeps this one honest — same locator, same nav, one entry that must be there.
     */
    const nav = page.locator('nav, .sidebar, aside').first();
    await expect(nav.getByRole('button', { name: /^Leads?$/ })).toHaveCount(1);
    await expect(nav.getByRole('button', { name: /^Triggers$/ })).toHaveCount(0);
  });

  test('the CRM per-user trigger endpoints are gone', async ({ page }) => {
    await signIn(page, 'superAdmin');
    /*
     * 404, not 403. A 403 would mean the route still exists and refused this caller, which is a
     * different (and reversible) state — the point of the cleanup is that there is no route.
     */
    expect((await apiGet(page, '/api/crm-settings/triggers')).status).toBe(404);
    expect((await apiSend(page, 'PUT', '/api/crm-settings/triggers', { triggers: { custom: true } })).status).toBe(404);
  });

  test('Wedding Congratulations cannot be sent by any surviving route', async ({ page }) => {
    await signIn(page, 'superAdmin');

    // The action is unknown to the dispatcher rather than a no-op that reports success.
    const direct = await apiSend(page, 'POST', '/api/crm-settings/email-settings', {
      action: 'sendWeddingEmail', leadName: 'X', leadEmail: 'x@example.test', weddingDate: '2026-09-01',
    });
    expect(JSON.stringify(direct.body)).toMatch(/invalid action/i);

    // Nor through the bulk sender, which had its own `wedding` case.
    const bulk = await apiSend(page, 'POST', '/api/crm-settings/email-settings', {
      action: 'bulkSend', emailType: 'wedding', leads: [{ name: 'X', email: 'x@example.test' }], emailData: {},
    });
    expect(JSON.stringify(bulk.body)).not.toMatch(/"success":\s*true.*sent":\s*[1-9]/);

    // And it is not offered as a communication, so no switch can bring it back.
    const comms = await apiGet(page, '/api/crm-communications');
    const keys = (comms.body as { communications: { key: string }[] }).communications.map((c) => c.key);
    expect(keys).not.toContain('wedding');

    // The brokerage defaults will not accept it either.
    const put = await apiSend(page, 'PUT', '/api/crm-communications/brokerage', { defaults: { wedding: true } });
    expect(put.status).toBe(400);
  });
});

test.describe('Transaction Desk Triggers is untouched', () => {
  test('/desk/triggers still opens the Desk trigger screen', async ({ page }) => {
    await signIn(page, 'superAdmin');
    await page.goto('/desk/triggers');
    /*
     * The heading is built from `AREA_LABEL.desk`, which is "Transaction Management" — not
     * "Transaction Desk", the name used for the area everywhere else in conversation. Asserted with
     * the string the screen actually renders; an earlier version guessed and failed here before
     * reaching the line below, which is the one that proves the panel itself loaded.
     */
    await expect(page.getByText(/Transaction Management Triggers/i)).toBeVisible({ timeout: 15_000 });
    // The panel's own content, so this fails if the route survived but the panel did not.
    await expect(page.getByText(/Automations that run on transaction activity/i)).toBeVisible();
  });

  test('the Desk sidebar still offers Triggers', async ({ page }) => {
    await signIn(page, 'superAdmin');
    await page.goto('/desk/dashboard');
    // `button` for the same reason as the CRM test above — the sidebar has no anchors in it.
    const nav = page.locator('nav, .sidebar, aside').first();
    await expect(nav.getByRole('button', { name: /^Triggers$/ })).toHaveCount(1);
  });

  test('the Desk trigger endpoints still answer', async ({ page }) => {
    await signIn(page, 'superAdmin');
    // What DeskTriggersPanel loads. Neither is a CRM endpoint and neither should have moved.
    expect((await apiGet(page, '/api/company-settings')).status).toBe(200);
    expect((await apiGet(page, '/api/email-templates')).status).toBe(200);
  });

  test('the `triggers` permission still exists, because the Desk screen needs it', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const res = await apiGet(page, '/api/users/catalog');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toMatch(/"triggers"/);
  });
});
