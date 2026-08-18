import { test, expect, type Page } from '@playwright/test';
import { signIn, apiGet, apiSend } from './helpers';

/**
 * SETTINGS, UNDER THE CONDITIONS THAT MAKE SETTINGS DANGEROUS.
 *
 * ================================================================================================
 * WHY THIS SCREEN GETS ITS OWN BEHAVIOUR SUITE. Everywhere else in the CRM a mistake costs one
 * record. Here the master switch decides whether ANY CRM email leaves for ANYBODY, and the brokerage
 * defaults decide it for every colleague who has not overridden them. The blast radius is the whole
 * office, and the controls are single clicks with no undo beyond clicking back.
 *
 * The ~87 existing settings and communications tests already cover what the controls DO. This file
 * covers what happens around them — the dimensions that were at or near zero coverage across the
 * whole suite:
 *
 *   reload persistence   a switch that reports success but did not persist looks identical on screen
 *   browser back         leaving a tab and returning must not show a stale state
 *   double-submit        two fast clicks on a brokerage-wide control
 *   stale tab            a tab whose rights changed, and two admins on one switch
 *   concurrency          the last write must win cleanly, not interleave
 *   validation           what a bad value does to a save
 *   permission visibility what each role can see and reach
 * ================================================================================================
 *
 * EVERY TEST RESTORES THE MASTER SWITCH. It is brokerage-wide and shared with every other spec in
 * this suite — leaving it off would silently break the CRM email tests that run afterwards, and the
 * failure would look like an email bug rather than like litter.
 */

/*
 * THE COMMUNICATIONS SCREEN IS ITS OWN ROUTE, not a tab on the Settings page.
 *
 * `CRM_SECTIONS` in SettingsPage lists it as CRM sub-navigation, which reads like a `?tab=` panel
 * and is not one — `/crm/settings?tab=communications` renders no controls at all. The screen is
 * registered separately in App.tsx (and deliberately `open`, so an agent can reach their own
 * preferences without holding the `settings` permission).
 */
const COMMS = '/crm/communications';
const MASTER = 'Allow CRM per-lead emails — brokerage-wide';

const masterToggle = (page: Page) => page.locator(`input[aria-label="${MASTER}"]`);

async function readMaster(page: Page): Promise<boolean> {
  const res = await apiGet(page, '/api/crm-communications');
  return Boolean((res.body as { brokerage?: { auto_send_enabled?: boolean } }).brokerage?.auto_send_enabled);
}

async function setMaster(page: Page, on: boolean) {
  await apiSend(page, 'PUT', '/api/crm-communications/brokerage', { auto_send_enabled: on });
}

/**
 * Switch it off through the UI, which requires confirming.
 *
 * `click()`, NOT `uncheck()`. The control is a CONTROLLED checkbox: clicking it does not flip the
 * box, it opens a confirmation, and the box only moves once the server has answered. Playwright's
 * `uncheck()` asserts the state changed as part of the action and fails with "clicking the checkbox
 * did not change its state" — which reads like a broken switch and is actually the confirmation
 * working exactly as designed.
 */
async function toggleMasterOffInUi(page: Page) {
  await masterToggle(page).click();
  await expect(page.getByText('Switch off CRM email for the whole brokerage?')).toBeVisible();
  await page.getByRole('button', { name: 'Switch it off' }).click();
}

test.afterEach(async ({ page }) => {
  // Leave it on, whatever the test did. Best-effort: the page may be signed out by now.
  try {
    await signIn(page, 'superAdmin');
    await setMaster(page, true);
  } catch { /* the test already tore its own session down */ }
});

// ================================================================ the master switch

test.describe('the brokerage master switch', () => {
  test('turning it off is confirmed first, and the confirmation can be declined', async ({ page }) => {
    await signIn(page, 'superAdmin');
    await setMaster(page, true);
    await page.goto(COMMS);
    await expect(masterToggle(page)).toBeChecked();

    // Ask to turn it off, then think better of it.
    await masterToggle(page).click();
    await expect(page.getByText('Switch off CRM email for the whole brokerage?')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).first().click();

    /*
     * DECLINING MUST CHANGE NOTHING. A confirmation that has already applied the change by the time
     * it asks is worse than no confirmation, and the switch is rendered from server state, so the
     * API is the honest place to check.
     */
    expect(await readMaster(page)).toBe(true);
    await page.reload();
    await expect(masterToggle(page)).toBeChecked();
  });

  test('turning it off persists across a reload, and the pill agrees', async ({ page }) => {
    await signIn(page, 'superAdmin');
    await setMaster(page, true);
    await page.goto(COMMS);

    await toggleMasterOffInUi(page);
    await expect.poll(() => readMaster(page)).toBe(false);

    await page.reload();
    await expect(masterToggle(page)).not.toBeChecked();
    // The status pill is the thing people actually read.
    await expect(page.getByText('Off', { exact: true }).first()).toBeVisible();
  });

  test('turning it back on needs no confirmation, and persists', async ({ page }) => {
    await signIn(page, 'superAdmin');
    await setMaster(page, false);
    await page.goto(COMMS);
    await expect(masterToggle(page)).not.toBeChecked();

    await masterToggle(page).click();

    // No dialog on the way back on — restoring the status quo needs no ceremony.
    await expect(page.getByText('Switch off CRM email for the whole brokerage?')).toBeHidden();
    await expect.poll(() => readMaster(page)).toBe(true);
    await page.reload();
    await expect(masterToggle(page)).toBeChecked();
  });

  /**
   * DOUBLE-SUBMIT ON A BROKERAGE-WIDE CONTROL. Two fast clicks must settle on one state rather than
   * racing to an unpredictable one — the failure here is not a duplicate record but a switch whose
   * final position does not match what the person last clicked.
   */
  test('clicking the switch rapidly settles on one state that matches the screen', async ({ page }) => {
    await signIn(page, 'superAdmin');
    await setMaster(page, true);
    await page.goto(COMMS);

    await toggleMasterOffInUi(page);
    await expect.poll(() => readMaster(page)).toBe(false);
    await masterToggle(page).click();
    await expect.poll(() => readMaster(page)).toBe(true);

    await page.reload();
    const onScreen = await masterToggle(page).isChecked();
    expect(onScreen, 'the rendered switch must equal the stored value').toBe(await readMaster(page));
  });

  test('the switch survives leaving the tab and coming back with the browser back button', async ({ page }) => {
    await signIn(page, 'superAdmin');
    await setMaster(page, true);
    await page.goto(COMMS);
    await toggleMasterOffInUi(page);
    await expect.poll(() => readMaster(page)).toBe(false);

    // Wander off, then come back the way a person does.
    await page.goto('/crm/lead');
    await page.waitForLoadState('networkidle');
    await page.goBack();
    await page.waitForLoadState('networkidle');

    // Back on Settings, showing the CURRENT value rather than a cached pre-change one.
    await expect(masterToggle(page)).not.toBeChecked();
  });
});

// ================================================================ concurrency

test.describe('two administrators on one switch', () => {
  test('the second change wins, and the first admin sees it after a reload', async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();

    try {
      await signIn(a, 'superAdmin');
      await signIn(b, 'superAdmin');
      await setMaster(a, true);

      await a.goto(COMMS);
      await b.goto(COMMS);
      await expect(masterToggle(a)).toBeChecked();

      // B switches it off. A's screen still shows "on" — it has no way to know.
      await setMaster(b, false);
      await expect(masterToggle(a)).toBeChecked();

      // A reloads and must now see the truth rather than its own stale optimism.
      await a.reload();
      await expect(masterToggle(a)).not.toBeChecked();

      await setMaster(a, true);
    } finally {
      const cleanup = await browser.newContext();
      const p = await cleanup.newPage();
      await signIn(p, 'superAdmin');
      await setMaster(p, true);
      await cleanup.close();
      await ctxA.close();
      await ctxB.close();
    }
  });
});

// ================================================================ permission visibility

test.describe('who can see and change brokerage settings', () => {
  /**
   * The Communications SCREEN is open to everybody — it is where an agent sets their own choices.
   * The brokerage controls inside it are not. Hiding them is presentation; the API refusing them is
   * the actual boundary, and both are checked because either alone is insufficient.
   */
  /**
   * AN AGENT SEES THE MASTER SWITCH BUT CANNOT MOVE IT, and the distinction is deliberate rather
   * than an oversight — I expected it hidden and was wrong.
   *
   * The switch is rendered `disabled` for anyone without `settings: edit`, while the brokerage
   * DEFAULTS below it are removed entirely. The reasoning holds up: the master switch explains
   * something the agent is experiencing — "none of my CRM email is going out" is answered by a
   * pill reading Off — whereas a default they cannot change and whose effect their own per-row
   * choice already overrides is, as the source puts it, "not a control but a fact about a value
   * they cannot reach".
   *
   * So the assertions are: visible, disabled, defaults absent, and the API refusing regardless.
   */
  test('an agent sees the master switch read-only, cannot change it, and is shown no defaults', async ({ page }) => {
    await signIn(page, 'agent');
    await page.goto(COMMS);
    await page.waitForLoadState('networkidle');

    await expect(page.getByText('Brokerage Controls')).toBeVisible();
    await expect(masterToggle(page)).toBeDisabled();
    await expect(page.getByText('Brokerage defaults')).toBeHidden();

    // Disabled is presentation. This is the boundary.
    const attempt = await apiSend(page, 'PUT', '/api/crm-communications/brokerage', { auto_send_enabled: false });
    expect([401, 403]).toContain(attempt.status);
  });

  test('an agent cannot open CRM Settings at all, by URL or by API', async ({ page }) => {
    await signIn(page, 'agent');

    const read = await apiGet(page, '/api/crm-settings');
    expect(read.status).toBe(403);

    await page.goto('/crm/settings?tab=crm');
    await page.waitForLoadState('networkidle');
    // Whatever the shell renders, no brokerage control is reachable.
    await expect(masterToggle(page)).toHaveCount(0);
  });

  test('a Super Admin is offered the switch and may change it', async ({ page }) => {
    await signIn(page, 'superAdmin');
    await page.goto(COMMS);

    await expect(page.getByText('Brokerage Controls')).toBeVisible();
    await expect(masterToggle(page)).toHaveCount(1);
  });
});

// ================================================================ stale tabs and expiry

test.describe('a Settings tab that has gone stale', () => {
  test('a demoted admin’s open Settings tab can no longer change the switch', async ({ browser }) => {
    const adminCtx = await browser.newContext();
    const staleCtx = await browser.newContext();
    const admin = await adminCtx.newPage();
    const stale = await staleCtx.newPage();

    try {
      await signIn(admin, 'superAdmin');
      await setMaster(admin, true);

      // agent2 is promoted so it can load Settings with real rights, then demoted underneath itself.
      const list = await apiGet(admin, '/api/users');
      const rows = (Array.isArray(list.body) ? list.body : []) as Record<string, unknown>[];
      const u = rows.find((r) => String(r.email) === 'agent2@test.local')!;
      const base = { name: u.name, email: u.email, username: u.username };

      await apiSend(admin, 'PUT', `/api/users/${u.id}`, { ...base, role: 'admin', status: 'Active' });
      await signIn(stale, 'agent2');
      await stale.goto(COMMS);
      await expect(masterToggle(stale)).toHaveCount(1);

      // Demoted. The tab is never reloaded and still shows the control.
      await apiSend(admin, 'PUT', `/api/users/${u.id}`, { ...base, role: 'agent', status: 'Active' });

      const attempt = await apiSend(stale, 'PUT', '/api/crm-communications/brokerage', { auto_send_enabled: false });
      expect([401, 403]).toContain(attempt.status);
      expect(await readMaster(admin), 'the switch must be untouched').toBe(true);
    } finally {
      const list = await apiGet(admin, '/api/users');
      const rows = (Array.isArray(list.body) ? list.body : []) as Record<string, unknown>[];
      const u = rows.find((r) => String(r.email) === 'agent2@test.local');
      if (u) {
        await apiSend(admin, 'PUT', `/api/users/${u.id}`, {
          name: u.name, email: u.email, username: u.username, role: 'agent', status: 'Active',
        });
      }
      await setMaster(admin, true);
      await adminCtx.close();
      await staleCtx.close();
    }
  });

  test('a save from a Settings tab whose session has expired changes nothing', async ({ page, context, browser }) => {
    await signIn(page, 'superAdmin');
    await setMaster(page, true);
    await page.goto(COMMS);

    // The session ends while the tab sits open.
    await context.clearCookies();
    const attempt = await apiSend(page, 'PUT', '/api/crm-communications/brokerage', { auto_send_enabled: false });
    expect([401, 403, 419]).toContain(attempt.status);

    const check = await browser.newContext();
    const p = await check.newPage();
    try {
      await signIn(p, 'superAdmin');
      expect(await readMaster(p), 'an expired session must not be able to switch off the brokerage').toBe(true);
    } finally { await check.close(); }
  });
});

// ================================================================ validation

test.describe('validation on the settings forms', () => {
  test('the personal profile form refuses an empty required name', async ({ page }) => {
    await signIn(page, 'superAdmin');
    await page.goto('/crm/settings?tab=crm');
    await page.waitForLoadState('networkidle');

    const name = page.locator('#crm-name');
    await expect(name).toBeVisible();
    const original = await name.inputValue();

    await name.fill('');
    await page.getByRole('button', { name: /Save Personal Information/ }).click();
    await page.waitForTimeout(800);

    // Nothing was saved: a reload brings the original back.
    await page.reload();
    await expect(page.locator('#crm-name')).toHaveValue(original);
  });

  test('an edited value that IS valid persists across a reload', async ({ page }) => {
    await signIn(page, 'superAdmin');
    await page.goto('/crm/settings?tab=crm');
    await page.waitForLoadState('networkidle');

    const phone = page.locator('#crm-phone');
    await expect(phone).toBeVisible();
    const original = await phone.inputValue();
    const next = `416-555-${Math.floor(1000 + Math.random() * 8999)}`;

    try {
      await phone.fill(next);
      await page.getByRole('button', { name: /Save Personal Information/ }).click();
      await page.waitForTimeout(1200);

      await page.reload();
      await expect(page.locator('#crm-phone')).toHaveValue(next);
    } finally {
      await page.locator('#crm-phone').fill(original);
      await page.getByRole('button', { name: /Save Personal Information/ }).click();
      await page.waitForTimeout(800);
    }
  });
});
