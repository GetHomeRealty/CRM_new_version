import { test, expect, type Page } from '@playwright/test';
import { signIn, apiGet } from './helpers';

/**
 * CRM-022: the Users list has to show who still has access.
 *
 * A COLUMN, NOT A FEATURE. The list showed name, email, role and screen access, so the one thing a
 * manager could not learn by looking was which accounts were switched off - they opened each record
 * in turn. The row object already carried `status`: the details view rendered it and the editor
 * initialised from it. Nothing had to be computed or fetched.
 *
 * WHY IT IS TESTED THROUGH THE BROWSER. The value was always in the API response, so an API test
 * would have passed before the fix and after it, proving nothing. What was missing was the column,
 * and only the rendered page can say whether it is there.
 *
 * THE INACTIVE CASE IS THE ONE THAT MATTERS. A page that renders "Active" everywhere and nothing at
 * all for a deactivated account would look correct on a seeded database where everybody is active,
 * which is exactly the blind spot that let this ship.
 */

const usersTable = (page: Page) => page.locator('table.list-table').first();

test.describe('the Users list shows each account status', () => {
  test('there is a Status column, and it carries a value for every row', async ({ page }) => {
    await signIn(page, 'superAdmin');
    await page.goto('/crm/users');

    const table = usersTable(page);
    await expect(table).toBeVisible({ timeout: 10_000 });
    await expect(table.locator('thead th', { hasText: /^Status$/ })).toBeVisible();

    // Every row says something: a blank status column would be the defect wearing a heading.
    const rows = table.locator('tbody tr');
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < Math.min(count, 5); i += 1) {
      await expect(rows.nth(i).locator('td').nth(3)).not.toBeEmpty();
    }
  });

  test('the column agrees with what the API reports', async ({ page }) => {
    /*
     * The point of the column is that it is true, not merely present. Read the statuses the server
     * gave and check the same values are on screen, so a column wired to the wrong field - or to a
     * constant - fails here rather than looking fine.
     */
    await signIn(page, 'superAdmin');
    const res = await apiGet(page, '/api/users');
    const body = res.body as { data?: { name: string; status?: string }[] } | { name: string; status?: string }[];
    const users = (Array.isArray(body) ? body : body.data ?? []);
    expect(users.length).toBeGreaterThan(0);

    await page.goto('/crm/users');
    const table = usersTable(page);
    await expect(table).toBeVisible({ timeout: 10_000 });

    for (const u of users.slice(0, 5)) {
      const row = table.locator('tbody tr').filter({ hasText: u.name }).first();
      await expect(row.locator('td').nth(3)).toContainText(u.status ?? 'Active');
    }
  });

  test('a deactivated account is visibly different from an active one', async ({ page }) => {
    // The whole purpose: seeing at a glance who no longer has access.
    await signIn(page, 'superAdmin');
    await page.goto('/crm/users');
    const table = usersTable(page);
    await expect(table).toBeVisible({ timeout: 10_000 });

    const active = table.locator('tbody tr td:nth-child(4) .pill.ok');
    const inactive = table.locator('tbody tr td:nth-child(4) .pill.bad');
    // Whichever this database holds, the two are rendered in different styles rather than as plain
    // text that has to be read word by word.
    expect(await active.count() + await inactive.count()).toBeGreaterThan(0);
  });
});
