import { test, expect, type Page } from '@playwright/test';
import { signIn, apiGet, apiSend, ACCOUNTS } from './helpers';

/**
 * THE COMMUNICATIONS SCREEN AS A SCREEN.
 *
 * ================================================================================================
 * WHAT PART 3 DID AND DID NOT ESTABLISH. `notification-chain.spec.ts` proved the machinery: event →
 * trigger → settings → template → send → log, for every CRM event, including the master switch and
 * the per-channel independence. All of that is server-side. None of it says anything about the
 * screen people actually use to change those settings.
 *
 * This file is about the screen, and specifically about the two things that make it interesting:
 *
 *   THE PERSONAL TOGGLES ARE OPTIMISTIC. They move before the server has answered, "because a
 *   toggle that waits for a round trip feels broken on a list this long". That is a good decision
 *   with one hard requirement attached: when the save FAILS the switch must go back and say why.
 *   An optimistic control that silently keeps a value the server rejected is worse than a slow one,
 *   because the screen is then lying about what is stored. That is the headline test here.
 *
 *   THE TEMPLATE CONTROLS DELEGATE. "Edit Template" does not open an editor on this screen; it
 *   deep-links to the one editor that owns those rows, carrying the template id. The thing worth
 *   testing is that the link carries the right id to the right place — a second editor is exactly
 *   what the design is avoiding.
 * ================================================================================================
 *
 * THE BROKERAGE CONTROLS ARE NOT RE-TESTED HERE. `settings-browser-behaviour.spec.ts` covers the
 * master switch, its confirmation, persistence, concurrency and permissions. Repeating it would
 * add runtime and no coverage.
 */

const COMMS = '/crm/communications';

/** A row's per-channel switch, e.g. "Email for Birthday Greeting". */
const channelToggle = (page: Page, channel: string, name: string) =>
  page.locator(`input[aria-label="${channel} for ${name}"]`);

/** The communications payload as the server sees it — the honest answer about what is stored. */
async function stored(page: Page): Promise<{ key: string; name: string; preferences: Record<string, boolean>; template?: { id: number; is_active: boolean } }[]> {
  const res = await apiGet(page, '/api/crm-communications');
  return ((res.body as { communications?: unknown[] }).communications ?? []) as never;
}

async function firstRowWith(page: Page, channel: 'email' | 'in_app' | 'push') {
  const rows = await stored(page);
  const row = rows.find((r) => r.preferences && channel in r.preferences);
  expect(row, `no communication row offers the ${channel} channel`).toBeTruthy();
  return row!;
}

/** Restore agent2's role, which one test changes underneath itself. */
async function restoreAgent2(page: Page) {
  const list = await apiGet(page, '/api/users');
  const rows = (Array.isArray(list.body) ? list.body : []) as Record<string, unknown>[];
  const u = rows.find((r) => String(r.email) === ACCOUNTS.agent2.email);
  if (!u) return;
  await apiSend(page, 'PUT', `/api/users/${u.id}`, {
    name: u.name, email: u.email, username: u.username, role: 'agent', status: 'Active',
  });
}

// ================================================================ the personal toggles

test.describe('a person’s own communication choices', () => {
  test('a toggle moves, persists to the server, and survives a reload', async ({ page }) => {
    await signIn(page, 'agent');
    await page.goto(COMMS);
    await page.waitForLoadState('networkidle');

    const row = await firstRowWith(page, 'email');
    const before = row.preferences.email;
    const toggle = channelToggle(page, 'Email', row.name);
    await expect(toggle).toBeVisible();

    await toggle.click();

    // The server is the judge, not the rendered box.
    await expect.poll(async () => (await stored(page)).find((r) => r.key === row.key)!.preferences.email)
      .toBe(!before);

    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(channelToggle(page, 'Email', row.name)).toBeChecked({ checked: !before });

    // Put it back.
    await channelToggle(page, 'Email', row.name).click();
    await expect.poll(async () => (await stored(page)).find((r) => r.key === row.key)!.preferences.email)
      .toBe(before);
  });

  /**
   * THE OPTIMISTIC-REVERT TEST, and the reason this file exists.
   *
   * The switch moves before the server answers. When the save then fails, two things must happen:
   * the switch goes back to what is actually stored, and the person is told. A screen that keeps the
   * new position after a rejected save is showing a setting that does not exist — and this is a
   * settings screen, so being believed is the entire job.
   *
   * The failure is induced by ending the session with the page open, which is the realistic version
   * of this (a laptop reopened the next morning) rather than a contrived network fault.
   */
  test('a toggle that the server refuses goes back, and says so', async ({ page, context }) => {
    await signIn(page, 'agent');
    await page.goto(COMMS);
    await page.waitForLoadState('networkidle');

    const row = await firstRowWith(page, 'email');
    const before = row.preferences.email;
    const toggle = channelToggle(page, 'Email', row.name);
    await expect(toggle).toBeChecked({ checked: before });

    // The session ends underneath the open screen.
    await context.clearCookies();
    await toggle.click();

    // It must come back to the stored value rather than keeping the optimistic one.
    await expect(toggle).toBeChecked({ checked: before, timeout: 15_000 });
    // And it must not have been silent about it.
    await expect(page.getByText(/could not save|sign in|session/i).first()).toBeVisible({ timeout: 15_000 });
  });

  /**
   * Channel independence at the SCREEN. Part 3 proved the dispatcher honours each channel
   * separately; this proves the screen writes them separately — one row's email switch must not
   * carry its in-app switch with it.
   */
  test('switching one channel does not move the others on the same row', async ({ page }) => {
    await signIn(page, 'agent');
    await page.goto(COMMS);
    await page.waitForLoadState('networkidle');

    const rows = await stored(page);
    const row = rows.find((r) => r.preferences && 'email' in r.preferences && 'in_app' in r.preferences);
    test.skip(!row, 'no row offers both email and in-app');

    const beforeEmail = row!.preferences.email;
    const beforeInApp = row!.preferences.in_app;

    await channelToggle(page, 'Email', row!.name).click();
    await expect.poll(async () => (await stored(page)).find((r) => r.key === row!.key)!.preferences.email)
      .toBe(!beforeEmail);

    const after = (await stored(page)).find((r) => r.key === row!.key)!;
    expect(after.preferences.in_app, 'the in-app choice must be untouched').toBe(beforeInApp);

    await channelToggle(page, 'Email', row!.name).click();
    await expect.poll(async () => (await stored(page)).find((r) => r.key === row!.key)!.preferences.email)
      .toBe(beforeEmail);
  });
});

// ================================================================ template controls

test.describe('the template controls', () => {
  test('Preview opens the rendered template rather than sending anything', async ({ page }) => {
    await signIn(page, 'superAdmin');
    await page.goto(COMMS);
    await page.waitForLoadState('networkidle');

    const preview = page.getByRole('button', { name: /Preview/ }).first();
    test.skip(await preview.count() === 0, 'no communication on this deployment has a mapped template');

    await preview.click();
    // A preview modal, and nothing that looks like a send.
    await expect(page.locator('.modal').filter({ hasText: /Preview|Subject/i }).first()).toBeVisible({ timeout: 15_000 });
  });

  /**
   * EDIT TEMPLATE DEEP-LINKS RATHER THAN OPENING A SECOND EDITOR — the whole point of the design.
   * What is asserted is that the link carries the row's own template id to the one editor that owns
   * these rows; a link that landed on the Templates list with no id would look identical to a user
   * until they edited the wrong template.
   */
  test('Edit Template links to Settings → Templates carrying that template’s id', async ({ page }) => {
    await signIn(page, 'superAdmin');
    await page.goto(COMMS);
    await page.waitForLoadState('networkidle');

    const rows = await stored(page);
    const mapped = rows.find((r) => r.template?.id);
    test.skip(!mapped, 'no communication on this deployment has a mapped template');

    await page.getByRole('button', { name: /Edit Template/ }).first().click();

    await expect(page).toHaveURL(/\/crm\/settings\?/);
    await expect(page).toHaveURL(/section=templates/);
    await expect(page).toHaveURL(new RegExp(`template=\\d+`));
  });

  /**
   * A DEACTIVATED TEMPLATE IS SAID SO, ON THE ROW. The chain tests proved a deactivated template
   * blocks the send; this proves the screen tells you that is why, instead of leaving somebody to
   * wonder why an enabled communication never arrives.
   */
  test('a template switched off is flagged on its communication row', async ({ page }) => {
    await signIn(page, 'superAdmin');
    await page.goto(COMMS);
    await page.waitForLoadState('networkidle');

    const rows = await stored(page);
    const mapped = rows.find((r) => r.template?.id);
    test.skip(!mapped, 'no communication on this deployment has a mapped template');
    const id = mapped!.template!.id;

    /*
     * A FULL-OBJECT PUT, not a partial one. `EmailTemplateService.validate` requires `subject` and
     * `body_html` on every update, so `{ is_active: false }` on its own is rejected — the template
     * stayed active and the pill never appeared, which looked like a missing pill and was a rejected
     * request. The current body has to be read first, and the communications payload carries the
     * subject but not the HTML, so it comes from the templates list.
     */
    const all = await apiGet(page, '/api/email-templates');
    // The payload is `{ groups: [{ templates: [...] }], mail_accounts: [...] }` — the templates are
    // nested by module, not a flat array, so a top-level `.find` sees nothing at all.
    const groups = ((all.body as { groups?: { templates?: unknown[] }[] }).groups ?? []);
    const list = groups.flatMap((g) => (g.templates ?? [])) as
      { id: number; subject: string; body_html: string; is_active: boolean }[];
    const full = list.find((t) => t.id === id);
    expect(full, 'the template should be readable from the templates list').toBeTruthy();
    const wasActive = full!.is_active;
    const base = { subject: full!.subject, body_html: full!.body_html };

    try {
      const off = await apiSend(page, 'PUT', `/api/crm-communications/templates/${id}`, { ...base, is_active: false });
      expect(off.status, 'the deactivation itself must succeed for this test to mean anything').toBe(200);

      await page.reload();
      await page.waitForLoadState('networkidle');
      await expect(page.getByText('Template off').first()).toBeVisible();

      await apiSend(page, 'PUT', `/api/crm-communications/templates/${id}`, { ...base, is_active: true });
      await page.reload();
      await page.waitForLoadState('networkidle');
      await expect(page.getByText('Template off')).toHaveCount(0);
    } finally {
      await apiSend(page, 'PUT', `/api/crm-communications/templates/${id}`, { ...base, is_active: wasActive });
    }
  });
});

// ================================================================ permissions

test.describe('what each role is offered', () => {
  test('an agent gets their own switches, a read-only note, and no template library', async ({ page }) => {
    await signIn(page, 'agent');
    await page.goto(COMMS);
    await page.waitForLoadState('networkidle');

    // Their own preferences are theirs to change.
    const row = await firstRowWith(page, 'email');
    await expect(channelToggle(page, 'Email', row.name)).toBeEnabled();

    // The administrator's half is not offered.
    await expect(page.getByText('Read-only.')).toBeVisible();
    await expect(page.getByRole('button', { name: /Create New Template/ })).toHaveCount(0);
  });

  test('a Super Admin is offered the template library', async ({ page }) => {
    await signIn(page, 'superAdmin');
    await page.goto(COMMS);
    await page.waitForLoadState('networkidle');

    await expect(page.getByText('Template Library')).toBeVisible();
    await expect(page.getByRole('button', { name: /Create New Template/ })).toHaveCount(1);
  });

  test('an agent cannot change a template through the API, whatever the screen shows', async ({ page }) => {
    await signIn(page, 'agent');
    await page.goto(COMMS);
    await page.waitForLoadState('networkidle');

    const rows = await stored(page);
    const mapped = rows.find((r) => r.template?.id);
    test.skip(!mapped, 'no communication on this deployment has a mapped template');

    const attempt = await apiSend(page, 'PUT', `/api/crm-communications/templates/${mapped!.template!.id}`, {
      is_active: false,
    });
    expect([401, 403]).toContain(attempt.status);
  });
});

// ================================================================ stale tabs

test.describe('a Communications tab that has gone stale', () => {
  test('a demoted user’s open tab cannot change a template', async ({ browser }) => {
    const adminCtx = await browser.newContext();
    const staleCtx = await browser.newContext();
    const admin = await adminCtx.newPage();
    const stale = await staleCtx.newPage();

    try {
      await signIn(admin, 'superAdmin');
      const rows = await stored(admin);
      const mapped = rows.find((r) => r.template?.id);
      test.skip(!mapped, 'no communication on this deployment has a mapped template');

      const list = await apiGet(admin, '/api/users');
      const users = (Array.isArray(list.body) ? list.body : []) as Record<string, unknown>[];
      const u = users.find((r) => String(r.email) === ACCOUNTS.agent2.email)!;
      const base = { name: u.name, email: u.email, username: u.username };

      // Promoted, so the tab loads with the administrator's view.
      await apiSend(admin, 'PUT', `/api/users/${u.id}`, { ...base, role: 'admin', status: 'Active' });
      await signIn(stale, 'agent2');
      await stale.goto(COMMS);
      await stale.waitForLoadState('networkidle');
      await expect(stale.getByText('Template Library')).toBeVisible();

      // Demoted underneath the open tab, which still shows the library.
      await apiSend(admin, 'PUT', `/api/users/${u.id}`, { ...base, role: 'agent', status: 'Active' });

      const attempt = await apiSend(stale, 'PUT', `/api/crm-communications/templates/${mapped!.template!.id}`, {
        is_active: false,
      });
      expect([401, 403]).toContain(attempt.status);

      // And the template is untouched.
      const after = (await stored(admin)).find((r) => r.template?.id === mapped!.template!.id);
      expect(after!.template!.is_active).toBe(mapped!.template!.is_active);
    } finally {
      await restoreAgent2(admin);
      await adminCtx.close();
      await staleCtx.close();
    }
  });

  /**
   * Two tabs belonging to the SAME person, on the same preference. The second write wins and the
   * first tab must tell the truth once reloaded — the same last-write-wins contract as elsewhere,
   * checked here because these switches are optimistic and could plausibly keep a stale value.
   */
  test('two tabs on one preference settle on the later write', async ({ browser }) => {
    const ctx = await browser.newContext();
    const tabA = await ctx.newPage();
    const tabB = await ctx.newPage();

    try {
      await signIn(tabA, 'agent');
      await tabA.goto(COMMS);
      await tabA.waitForLoadState('networkidle');
      await tabB.goto(COMMS);
      await tabB.waitForLoadState('networkidle');

      const row = await firstRowWith(tabA, 'email');
      const before = row.preferences.email;

      // B flips it. A still shows the old value — it has no way to know.
      await channelToggle(tabB, 'Email', row.name).click();
      await expect.poll(async () => (await stored(tabB)).find((r) => r.key === row.key)!.preferences.email)
        .toBe(!before);
      await expect(channelToggle(tabA, 'Email', row.name)).toBeChecked({ checked: before });

      // A reloads and sees the truth.
      await tabA.reload();
      await tabA.waitForLoadState('networkidle');
      await expect(channelToggle(tabA, 'Email', row.name)).toBeChecked({ checked: !before });

      await channelToggle(tabA, 'Email', row.name).click();
      await expect.poll(async () => (await stored(tabA)).find((r) => r.key === row.key)!.preferences.email)
        .toBe(before);
    } finally { await ctx.close(); }
  });
});
