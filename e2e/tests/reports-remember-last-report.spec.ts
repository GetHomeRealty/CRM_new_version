import { test, expect } from '@playwright/test';
import { signIn } from './helpers';

/**
 * REPORTS, 2026-10-19 (brokerage request):
 *  - "Deal Documentation Status Report" is now "Pending Documents Report";
 *  - the six Documentation and Compliance cards share one row on a wide screen;
 *  - the report you had open, with its filters, reopens when you come back to Reports from another
 *    module — and going back to the list on purpose forgets it.
 */

// Short enough that the Documentation section is below the fold until the list scrolls to it.
test.use({ viewport: { width: 1920, height: 700 } });

const SEARCH = 'ZZ-no-such-property-remember';

test('the renamed card, one row of documentation reports, and the last report reopening', async ({ page }) => {
  await signIn(page, 'superAdmin');
  await page.goto('/desk/reports');

  // The rename.
  const card = page.locator('.report-card', { hasText: 'Pending Documents Report' });
  await expect(card).toBeVisible({ timeout: 15_000 });

  // The note under the title: small, plain and in brackets.
  const note = page.locator('.report-list-note');
  await expect(note).toHaveText(/^\(Generate detailed .*XLSX or PDF\.\)$/);
  expect(await note.evaluate((el) => getComputedStyle(el).fontSize)).toBe('11.5px');
  await expect(page.locator('.report-card', { hasText: 'Deal Documentation Status Report' })).toHaveCount(0);

  // One row: every Documentation and Compliance card starts at the same height.
  const tops = await page.locator('.report-grid.one-row').evaluateAll((grids) => grids.map((g) =>
    [...new Set([...g.querySelectorAll('.report-card')].map((c) => Math.round(c.getBoundingClientRect().top)))].length));
  expect(tops).toEqual([1, 1]); // Payment Reports, then Documentation and Compliance Reports

  // Open it and filter it.
  await card.getByRole('button', { name: /Open Report/ }).click();
  await expect(page).toHaveURL(/\/desk\/reports\/deal-documentation-status$/);
  await page.getByPlaceholder('Property, trade no., agent…').fill(SEARCH);
  await page.getByRole('button', { name: 'Apply Filters' }).click();
  await expect(page.locator('.report-chips')).toContainText(SEARCH);

  // Another module, then Reports again: the same report, with its filter.
  await page.goto('/desk/transactions');
  await page.goto('/desk/reports');
  await expect(page).toHaveURL(/\/desk\/reports\/deal-documentation-status$/, { timeout: 15_000 });
  await expect(page.getByPlaceholder('Property, trade no., agent…')).toHaveValue(SEARCH);
  await expect(page.locator('.report-chips')).toContainText(SEARCH);

  // ← Reports goes to the list and forgets it: the next visit starts at the list.
  await page.getByRole('button', { name: '← Reports' }).click();
  await expect(page).toHaveURL(/\/desk\/reports$/);
  await expect(card).toBeVisible();
  // ...at the Documentation and Compliance section, not the top of the list.
  const docSection = page.locator('[data-report-category="Documentation and Compliance Reports"]');
  await expect(docSection).toBeInViewport();
  await expect(page.locator('.report-list-note')).not.toBeInViewport();
  await page.goto('/desk/transactions');
  await page.goto('/desk/reports');
  await expect(page.locator('.report-card', { hasText: 'Pending Documents Report' })).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/\/desk\/reports$/);
});
