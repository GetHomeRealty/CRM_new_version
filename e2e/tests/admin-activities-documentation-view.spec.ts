import { test, expect, type Page } from '@playwright/test';
import { ACCOUNTS, apiSend, signIn } from './helpers';

/**
 * ADMIN ACTIVITIES, AS THE DOCUMENTATION ROLE SEES IT.
 *
 * That role is view-only here — the page passes `readOnly={sectionView}` and
 * `sectionView = view || isDocumentation` — so the banner's old instruction, "click Edit on the
 * transaction to make changes", pointed at an Edit they are never given. They now get the word
 * "View" and nothing else. Every other role keeps the sentence, because for them it is true.
 *
 * WHY THE ROLE IS MOCKED. What is under test is a rendering decision the SPA makes from the user
 * payload, so the payload is what the test hands it. `is_admin: false` matters as much as the role
 * — `can()` in AuthContext short-circuits to true for an admin — and `transactions: 'edit'` is
 * needed because the Admin button is only rendered to somebody holding it.
 *
 * THE SECOND TEST IS THE CONTROL GROUP. "Changed for Documentation" is only correct if it is
 * unchanged for everybody else, so the same modal is opened by a Super Admin in view mode, which
 * is read-only for a different reason and must still carry the original sentence.
 */

// NOT containing the words 'Admin Activities': the property name is rendered on the page, and a
// fixture called that made `getByText('Admin Activities')` ambiguous with the modal's own heading.
const PROPERTY = 'ZZ-TEST Docs Banner Road';

async function deal(page: Page): Promise<number> {
  const created = await apiSend(page, 'POST', '/api/transactions', {
    type: 'Residential Buying',
    property: PROPERTY,
    status: 'Secured Firm',
    price: 640000,
    comm_type: '%',
    comm_value: 2.5,
    offer_date: '2026-08-13',
    closing_date: '2026-09-30',
    primary_agent: ACCOUNTS.agent.name,
  });
  expect(created.status).toBe(201);
  return (created.body as { data: { id: number } }).data.id;
}

async function openAdminActivities(page: Page, id: number): Promise<void> {
  await page.goto(`/desk/transactions/${id}?mode=view`);
  // " (View Only)" is appended for this role since 2026-10-13; the optional group keeps the
  // anchoring that stops this matching the "Admin Activities" heading.
  await page.getByRole('button', { name: /^Admin( \(View Only\))?$/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Admin Activities' }).or(page.locator('.modal-h', { hasText: 'Admin Activities' })).first()).toBeVisible({ timeout: 15_000 });
}

const asDocumentation = (page: Page) => page.route('**/api/user', async (route) => {
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

test('EVERY OTHER ROLE KEEPS THE SENTENCE IT HAD', async ({ page }) => {
  // The control group, run first: a Super Admin in view mode meets the same banner.
  await signIn(page, 'superAdmin');
  const id = await deal(page);
  try {
    await openAdminActivities(page, id);
    const banner = page.locator('.modal').getByTestId('admin-readonly-banner');

    await expect(banner).toBeVisible();
    await expect(banner).toContainText('View-only');
    await expect(banner).toContainText('on the transaction to make changes');
    await expect(banner).not.toHaveText('View');
    // The lock icon is a decorative <svg>, so it is counted rather than read.
    expect(await banner.locator('svg').count()).toBeGreaterThan(0);
  } finally {
    await apiSend(page, 'DELETE', `/api/transactions/${id}`).catch(() => undefined);
  }
});

test('A DOCUMENTATION USER SEES NO READ-ONLY BANNER AT ALL', async ({ page }) => {
  await signIn(page, 'superAdmin');
  const id = await deal(page);
  try {
    await asDocumentation(page);
    await openAdminActivities(page, id);
    /*
     * THE BANNER IS GONE FOR THIS ROLE, and this assertion is the reverse of what it was.
     *
     * It used to read `toHaveText('View')`. That wording was asked for when this panel still
     * rendered as a disabled FORM to this role, and a bar was the only thing explaining why the
     * controls would not respond. The brokerage asked on 2026-10-13 for the Quick Actions to be
     * strictly view-only, with the controls shown as plain text — at which point the bar explains
     * nothing and is furniture, so it was removed FOR THIS ROLE ONLY.
     *
     * Other roles still see it and still assert on it: `team-split-view-only.spec.ts` for an agent
     * in View Only, `accounting-transaction-view.spec.ts` for Accounting. Those were run and pass
     * unchanged, which is what makes this a scoped change rather than a deletion.
     *
     * WHAT IS STILL ASSERTED BELOW is the part that always mattered: nothing in the panel accepts
     * input, and nothing suggests this role may edit.
     */
    await expect(page.locator('.modal').getByTestId('admin-readonly-banner')).toHaveCount(0);
    // No instruction suggesting they can edit.
    await expect(page.locator('.modal').getByText(/click .*Edit.* on the transaction/)).toHaveCount(0);

    // Still read-only: the fieldset is disabled, so nothing inside accepts input. Asserted with
    // `:disabled` rather than the IDL property, which reads false for a control that inherits its
    // disabled state from an ancestor fieldset.
    const editable = await page.locator('.modal').evaluate((el) => {
      const fields = [...el.querySelectorAll('input, select, textarea')] as HTMLInputElement[];
      return fields.filter((f) => !f.matches(':disabled') && !f.readOnly).length;
    });
    expect(editable).toBe(0);
  } finally {
    await page.unroute('**/api/user');
    await apiSend(page, 'DELETE', `/api/transactions/${id}`).catch(() => undefined);
  }
});
