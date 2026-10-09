import { test, expect, type Page } from '@playwright/test';
import { ACCOUNTS, apiSend, signIn } from './helpers';

/**
 * FINANCIAL INFORMATION, AS THE DOCUMENTATION ROLE SEES IT.
 *
 * That role is read-only on this section, so the screen used to be covered in affordances it could
 * not use: a padlock-and-pencil beside every locked field inviting a request for Super Admin
 * approval, a lock toggle beside each commission-term heading, and a banner whose instruction was
 * "click the 🔒✏ beside a field" — all of them inert, because the whole body sits inside
 * `<fieldset disabled>`. They now see the word "View" and the figures.
 *
 * WHY THE ROLE IS MOCKED. The seeded `documentation` account exists, but what is under test is a
 * rendering decision the SPA makes from the user payload, and the shortest honest way to put the
 * page in that state is to hand it that payload. `is_admin: false` matters as much as the role
 * itself — `can()` in AuthContext short-circuits to true for an admin, which would render the
 * controls whatever the role says.
 *
 * WHY THE DEAL IS BUILT HERE RATHER THAN TAKEN FROM THE SEED. An earlier version of this file
 * opened whichever transaction the API listed first, and that deal has no team and no
 * preconstruction terms — so it renders none of the lock controls for ANYBODY, and every
 * "`toHaveCount(0)`" below passed against a screen that never had them. The assertions proved
 * nothing. This deal is given a two-agent team split on purpose, so the controls genuinely exist,
 * and the Super Admin test asserts they are visible before the Documentation test claims they are
 * gone.
 */

const PROPERTY = 'ZZ-TEST Financial Documentation View Road';

/** A deal with a two-agent split, so the Agent Comm % lock controls actually render. */
async function dealWithTeam(page: Page): Promise<number> {
  const created = await apiSend(page, 'POST', '/api/transactions', {
    type: 'Residential Buying',
    property: PROPERTY,
    status: 'Secured Firm',
    price: 750000,
    comm_type: '%',
    comm_value: 2.5,
    offer_date: '2026-08-13',
    closing_date: '2026-09-30',
    primary_agent: ACCOUNTS.agent.name,
  });
  expect(created.status).toBe(201);
  const id = (created.body as { data: { id: number } }).data.id;

  const teamed = await apiSend(page, 'PUT', `/api/transactions/${id}`, {
    team: [
      { name: ACCOUNTS.agent.name, split: 60, agent_pct: 80, brok_pct: 20, is_primary: true },
      { name: ACCOUNTS.agent2.name, split: 40, agent_pct: 70, brok_pct: 30 },
    ],
  });
  expect(teamed.status, 'the team split must save, or the controls never render').toBe(200);
  return id;
}

const removeDeal = (page: Page, id: number) =>
  apiSend(page, 'DELETE', `/api/transactions/${id}`).catch(() => undefined);

async function openFinancial(page: Page, id: number): Promise<void> {
  await page.goto(`/desk/transactions/${id}?mode=view`);
  await page.getByRole('button', { name: /Financial/i }).first().click();
  await expect(page.getByText('Financial Information')).toBeVisible({ timeout: 15_000 });
}

/** Every lock, unlock and request-edit control the modal can render, by the title it carries. */
const LOCK_CONTROLS = /(Lock|Unlock to edit) (Agent Comm|Commission) %|request Super Admin approval to edit|Edit approval pending/;

test('EVERY OTHER ROLE KEEPS THE DISPLAY IT HAD — and the controls exist to be hidden', async ({ page }) => {
  /*
   * Deliberately first. This is the control group: a Super Admin opening the same deal in view
   * mode is read-only for the same reason and meets the same banner, so anything that leaked out
   * of the `isDocumentation` guard fails here. No mock — this is the real session.
   */
  await signIn(page, 'superAdmin');
  const id = await dealWithTeam(page);
  try {
    await openFinancial(page, id);
    const modal = page.locator('.modal.xl');

    // THE GUARD FOR THE TEST BELOW. Its absence assertions are only meaningful if this deal
    // renders these controls for somebody. If this line fails, the fixture stopped producing a
    // team split and BOTH tests are vacuous — fix the fixture, do not relax this.
    await expect(modal.getByTitle(LOCK_CONTROLS).first()).toBeVisible();
    expect(await modal.getByTitle(LOCK_CONTROLS).count()).toBeGreaterThan(1);

    const banner = modal.getByTestId('fin-readonly-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('View-only');
    await expect(banner).toContainText('on the transaction to make changes');
    await expect(banner).not.toHaveText('View');   // not the terse Documentation wording

    // The other half of the guard: the padlock the Documentation test counts to zero is here.
    const brok = modal.locator('label', { hasText: 'Brok Comm (%)' });
    expect(await brok.count()).toBeGreaterThan(0);
    expect(await brok.locator('svg').count()).toBeGreaterThan(0);
  } finally {
    await removeDeal(page, id);
  }
});

test('A DOCUMENTATION USER SEES "View" AND NONE OF THE LOCK FURNITURE', async ({ page }) => {
  await signIn(page, 'superAdmin');
  const id = await dealWithTeam(page);
  try {
    await page.route('**/api/user', async (route) => {
      const real = await route.fetch();
      const u = await real.json() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...u,
          role: 'documentation',
          is_admin: false,
          is_super_admin: false,
          is_admin_or_above: false,
          permissions: { ...(u.permissions as Record<string, string>), transactions: 'edit' },
        }),
      });
    });

    await openFinancial(page, id);
    const modal = page.locator('.modal.xl');

    // The banner is the word and nothing else.
    await expect(modal.getByTestId('fin-readonly-banner')).toHaveText('View');

    // None of the wording that used to tell them to ask for edit rights.
    await expect(modal.getByText(/View-only — click/)).toHaveCount(0);
    await expect(modal.getByText(/fields are locked/)).toHaveCount(0);
    await expect(modal.getByText(/request Super Admin approval/)).toHaveCount(0);
    await expect(modal.getByText(/edit the fields and Save/)).toHaveCount(0);

    // And none of the controls, which the test above proved this deal does render for others.
    // Matched on the button titles, so swapping an icon cannot quietly satisfy this.
    await expect(modal.getByTitle(LOCK_CONTROLS)).toHaveCount(0);

    /*
     * The padlock beside "Brok Comm (%)" is a decorative `<svg>`, not a button with a title, so
     * the control sweep above cannot see it. Counted directly on the labels instead — and the
     * labels themselves must still be there, because this change hides furniture, not data.
     */
    const brok = modal.locator('label', { hasText: 'Brok Comm (%)' });
    expect(await brok.count(), 'the fixture must render Brok Comm labels').toBeGreaterThan(0);
    expect(await brok.locator('svg').count()).toBe(0);
  } finally {
    await page.unroute('**/api/user');
    await removeDeal(page, id);
  }
});
