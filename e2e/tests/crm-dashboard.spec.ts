import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/**
 * The CRM Dashboard renders.
 *
 * WHY THIS EXISTS. The dashboard had no browser coverage at all, and it went blank in development:
 * `LeadTasksPanel` did `const { open, overdue, total } = feed.summary`, the feed arrived without a
 * `summary`, and the error boundary replaced the whole screen with "This page could not be
 * displayed". Every panel below it was lost too — one missing aggregate took out the page.
 *
 * The trigger was an API server left running across the change that gave these feeds their
 * `{ data, meta, summary }` shape; it was still serving the older bare array from memory. That is a
 * development accident, but the fragility was real: a panel could take the page down over a field
 * it does not own.
 *
 * So this asserts the thing that actually broke — the page renders, with its panels, and the error
 * boundary is nowhere on screen. Every role that can see leads, because the panels are behind a
 * capability check and "renders for an agent" would not have caught a Super Admin-only path.
 */

const BOUNDARY = /This page could not be displayed/i;

for (const who of ['agent', 'admin', 'superAdmin'] as const) {
  test(`the CRM dashboard renders for ${who}`, async ({ page }) => {
    const crashes: string[] = [];
    page.on('pageerror', (e) => crashes.push(e.message));

    await signIn(page, who);
    await page.goto('/crm');

    // The panels that read a paginated feed are the ones that broke.
    await expect(page.getByText('Lead Tasks', { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(BOUNDARY)).toHaveCount(0);

    /*
     * EVERY pageerror, not a filtered subset.
     *
     * This read `crashes.filter((m) => /destructure|undefined/i.test(m))`, matching the wording of
     * the one crash that prompted the test. It would not have caught the failure that actually
     * reached production: a backend deployed ahead of its frontend served the paginated
     * `{ data, meta, summary }` object to a bundle still expecting a bare array, and the panel
     * called `.filter()` on it — `tasks.filter is not a function`, which contains neither word. The
     * test passed while the page was blank.
     *
     * Filtering by message is guessing at the next bug's wording. Measured: this page raises no
     * pageerror at all for any of the three roles, so zero is the honest assertion and it is not a
     * flaky one.
     */
    expect(crashes).toEqual([]);
  });
}

test('the task panel heading survives a feed that carries no summary', async ({ page }) => {
  await signIn(page, 'agent');

  /*
   * Serve the OLDER shape — a bare array, exactly what a stale API process returns — and require
   * the page to render anyway. This is the regression: the client now settles the shape in
   * `toFeedPage` instead of trusting the server to have been restarted.
   */
  await page.route('**/api/leads/tasks*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 1, lead_id: 1, lead_name: 'Stale Shape', title: 'Call back',
          due_date: '2020-01-01', description: '', status: 'pending', priority: 'high',
          assigned_to: null, assigned_to_name: null, created_by: null, created_at: null,
        },
      ]),
    });
  });

  await page.goto('/crm');

  await expect(page.getByText(BOUNDARY)).toHaveCount(0);
  // Derived from the rows: one task, open, and overdue against a 2020 due date.
  await expect(page.getByText(/Lead Tasks \(1 open of 1\)/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('1 overdue')).toBeVisible();
});
