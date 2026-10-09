import { test, expect, type Page } from '@playwright/test';
import { apiGet, signIn } from './helpers';

/**
 * FINANCIAL INFORMATION, AS THE DOCUMENTATION ROLE SEES IT.
 *
 * That role is read-only on this section, so the screen used to be covered in affordances it could
 * not use: a padlock-and-pencil beside every locked field inviting a request for Super Admin
 * approval, lock toggles beside each commission-term heading, and a banner whose instruction was
 * "click the 🔒✏ beside a field" — all of them inert, because the whole body sits inside
 * `<fieldset disabled>`. They now see the word "View" and the figures.
 *
 * WHY THE ROLE IS MOCKED. The seeded `documentation` account exists, but what is under test is a
 * rendering decision the SPA makes from the user payload, and the shortest honest way to put the
 * page in that state is to hand it that payload. `is_admin: false` matters as much as the role
 * itself — `can()` in AuthContext short-circuits to true for an admin, which would render the
 * controls whatever the role says.
 *
 * THE SECOND TEST IS THE IMPORTANT HALF. "Hidden for Documentation" is only correct if it is still
 * shown to everybody else, so the same modal is opened by a Super Admin in view mode — also
 * read-only, also showing this banner — and must still carry the original sentence.
 */

/** Open the Financial modal on whichever transaction the API lists first. */
async function openFinancial(page: Page): Promise<void> {
  const list = await apiGet(page, '/api/transactions?per_page=1');
  const id = ((list.body as { data: { id: number }[] }).data ?? [])[0]?.id;
  expect(id, 'the seed must contain at least one transaction').toBeTruthy();

  await page.goto(`/desk/transactions/${id}`);
  await page.getByRole('button', { name: /Financial/i }).first().click();
  await expect(page.getByText('Financial Information')).toBeVisible({ timeout: 15_000 });
}

test('a Documentation user sees "View" and none of the lock furniture', async ({ page }) => {
  await signIn(page, 'superAdmin');

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

  await openFinancial(page);
  const modal = page.locator('.modal.xl');

  // THE BANNER IS THE WORD AND NOTHING ELSE.
  await expect(modal.getByTestId('fin-readonly-banner')).toHaveText('View');

  // None of the three things that used to tell them to ask for edit rights.
  await expect(modal.getByText(/View-only — click/)).toHaveCount(0);
  await expect(modal.getByText(/fields are locked/)).toHaveCount(0);
  await expect(modal.getByText(/request Super Admin approval/)).toHaveCount(0);
  await expect(modal.getByText(/edit the fields and Save/)).toHaveCount(0);

  // No lock, unlock or request-edit control anywhere in the modal. Asserted by the titles the
  // buttons carry, so a change of icon cannot quietly satisfy this.
  await expect(modal.getByTitle(/Unlock to edit/)).toHaveCount(0);
  await expect(modal.getByTitle(/Lock Commission %/)).toHaveCount(0);
  await expect(modal.getByTitle(/Lock Agent Comm %/)).toHaveCount(0);
  await expect(modal.getByTitle(/request Super Admin approval to edit/)).toHaveCount(0);
  await expect(modal.getByTitle(/Edit approval pending/)).toHaveCount(0);
});

test('every other role keeps the display it had', async ({ page }) => {
  /*
   * A Super Admin opening the deal in view mode: read-only for the same reason, and the banner this
   * test is about is the same one. No mock — this is the real session, so a change that leaked out
   * of the `isDocumentation` guard would show up here.
   */
  await signIn(page, 'superAdmin');
  await openFinancial(page);
  const modal = page.locator('.modal.xl');

  const banner = modal.getByTestId('fin-readonly-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('View-only');
  await expect(banner).toContainText('on the transaction to make changes');
  // Specifically NOT the terse Documentation wording.
  await expect(banner).not.toHaveText('View');
});
