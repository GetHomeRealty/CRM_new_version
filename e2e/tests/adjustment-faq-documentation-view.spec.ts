import { test, expect, type Page } from '@playwright/test';
import { ACCOUNTS, apiSend, signIn } from './helpers';

/**
 * ADJUSTMENT AND AGENT PAYMENT READINESS, AS THE DOCUMENTATION ROLE SEES THEM.
 *
 * Both sections are view-only for that role — the transaction page passes
 * `adjReadOnly = sectionView || …` and `readOnly={sectionView || isAgent}`, with
 * `sectionView = view || isDocumentation` — so their banners' instructions ("Click Edit if the
 * transaction is still open", "click Edit on the transaction to make changes") pointed at an Edit
 * they are never given. They now read "View". Every other role keeps its wording and padlock.
 *
 * WHY THE ROLE IS MOCKED. What is under test is a rendering decision the SPA makes from the user
 * payload, so the payload is what the test hands it. `is_admin: false` matters as much as the role
 * — `can()` in AuthContext short-circuits to true for an admin — and `transactions: 'edit'` is
 * required because both quick-action buttons are only rendered to somebody holding it.
 *
 * EACH SECTION IS CHECKED TWICE: once as Documentation, once as a Super Admin in view mode, who is
 * read-only for a different reason and meets the same banner. The second is the control group —
 * "hidden for Documentation" is only correct if it is still shown to everybody else.
 *
 * The property name deliberately avoids the words in either modal heading; a fixture called after
 * its own screen made `getByText` ambiguous with the heading in an earlier version of this suite.
 */

const PROPERTY = 'ZZ-TEST Docs Banner Sections Road';

async function deal(page: Page): Promise<number> {
  const created = await apiSend(page, 'POST', '/api/transactions', {
    type: 'Residential Buying',
    property: PROPERTY,
    status: 'Secured Firm',
    price: 580000,
    comm_type: '%',
    comm_value: 2.5,
    offer_date: '2026-08-13',
    closing_date: '2026-09-30',
    primary_agent: ACCOUNTS.agent.name,
  });
  expect(created.status).toBe(201);
  return (created.body as { data: { id: number } }).data.id;
}

const removeDeal = (page: Page, id: number) =>
  apiSend(page, 'DELETE', `/api/transactions/${id}`).catch(() => undefined);

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

/** The two sections, each with the quick action that opens it and what its banner should say. */
const SECTIONS = [
  {
    name: 'Adjustment',
    button: /^Adjustment$/,
    heading: 'Adjustment & Advance Payment',
    banner: 'adjustment-readonly-banner',
    keeps: /Locked — adjustments, advance payments and referrals/,
  },
  {
    name: 'Agent Payment Readiness',
    button: /^Agent Payment Readiness$/,
    heading: 'Agent Payment Readiness',
    banner: 'faq-readonly-banner',
    keeps: /View-only — click/,
  },
] as const;

async function openSection(page: Page, id: number, s: typeof SECTIONS[number]): Promise<void> {
  await page.goto(`/desk/transactions/${id}?mode=view`);
  await page.getByRole('button', { name: s.button }).first().click();
  await expect(page.locator('.modal-h', { hasText: s.heading }).first()).toBeVisible({ timeout: 15_000 });
}

for (const s of SECTIONS) {
  test(`${s.name}: EVERY OTHER ROLE KEEPS ITS WORDING AND ICON`, async ({ page }) => {
    // The control group, run first: a Super Admin in view mode meets the same banner.
    await signIn(page, 'superAdmin');
    const id = await deal(page);
    try {
      await openSection(page, id, s);
      const banner = page.getByTestId(s.banner);

      await expect(banner).toBeVisible();
      await expect(banner).toHaveText(s.keeps);
      await expect(banner).not.toHaveText('View');
      // The padlock is a literal 🔒 in both of these banners, not an <Icon> component.
      await expect(banner).toContainText('🔒');
    } finally {
      await removeDeal(page, id);
    }
  });

  test(`${s.name}: A DOCUMENTATION USER SEES "View", WITH NO ICON OR EDIT INSTRUCTION`, async ({ page }) => {
    await signIn(page, 'superAdmin');
    const id = await deal(page);
    try {
      await asDocumentation(page);
      await openSection(page, id, s);
      const modal = page.locator('.modal').filter({ hasText: s.heading }).first();
      const banner = page.getByTestId(s.banner);

      await expect(banner).toHaveText('View');
      await expect(banner).not.toContainText('🔒');
      expect(await banner.locator('svg').count()).toBe(0);

      // Nothing anywhere in the modal still suggests they can edit or ask to.
      await expect(modal.getByText(/click .*Edit.* (on the transaction|if the transaction)/)).toHaveCount(0);
      await expect(modal.getByText(/request Super Admin approval/)).toHaveCount(0);

      /*
       * AND IT IS STILL READ-ONLY. Counted with `:disabled` rather than the IDL property, which
       * reads false for a control inheriting its disabled state from an ancestor fieldset — the
       * trap that made an earlier version of a sibling test report a locked form as editable.
       */
      const editable = await modal.evaluate((el) => {
        const fields = [...el.querySelectorAll('input, select, textarea')] as HTMLInputElement[];
        return fields.filter((f) => !f.matches(':disabled') && !f.readOnly).length;
      });
      expect(editable).toBe(0);

      // No Save button either, so there is no way to attempt a write from here.
      await expect(modal.getByRole('button', { name: /^save$/i })).toHaveCount(0);
    } finally {
      await page.unroute('**/api/user');
      await removeDeal(page, id);
    }
  });
}
