import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { signIn, apiGet } from './helpers';

/**
 * New-mail notifications in the Notification Centre, in a real browser.
 *
 * TWO THINGS ARE UNDER TEST, and neither can be proven by the server tests alone.
 *
 * WHICH LINES APPEAR. Only the primary mailbox's. `server/src/notifications/notification-center.spec.ts`
 * proves the filter against real rows, but a screen that rendered from a stale copy, or a badge
 * counted by a second query that missed the filter, would satisfy every one of those assertions and
 * still show somebody four mailboxes' worth of notifications.
 *
 * WHAT THE BUTTON SAYS. "Open mail", not "Open deal". That label is client-side only — there is no
 * server assertion that could ever reach it, and the client has no unit-test runner — so this file
 * is the only place it is checked at all.
 *
 * `notification-center.spec.ts` next door runs entirely through the API against a database with no
 * notifications in it, which is exactly why the fixture here exists.
 */

const SERVER = join(__dirname, '..', '..', 'server');
const fixture = (mode: '--setup' | '--swap' | '--teardown') =>
  execFileSync('node', ['scripts/e2e-mail-notification-fixture.cjs', mode], {
    cwd: SERVER,
    env: { ...process.env, TEST_DATABASE_URL: process.env.TEST_DATABASE_URL },
    encoding: 'utf8',
  });

const CENTRE = '/crm/notification-center';
const PRIMARY_TITLE = 'E2E new mail from the primary box';
const OTHER_TITLE = 'E2E new mail from the other box';

// Serial: every test reads one shared fixture, and one of them deliberately changes it.
test.describe.configure({ mode: 'serial' });

test.beforeAll(() => { fixture('--setup'); });
test.afterAll(() => { fixture('--teardown'); });

/** The titles of the fixture's own new-mail lines, as the feed returns them. */
async function mailTitles(page: import('@playwright/test').Page): Promise<string[]> {
  const res = await apiGet(page, '/api/notifications?filter=all&limit=100');
  const items = (res.body as { items: { title: string }[] }).items ?? [];
  return items.map((i) => i.title).filter((t) => t.startsWith('E2E new mail')).sort();
}

test.describe('only the primary mailbox is heard from', () => {
  test('the screen shows the primary mailbox and not the other one', async ({ page }) => {
    await signIn(page, 'agent');
    await page.goto(CENTRE);

    await expect(page.getByText(PRIMARY_TITLE)).toBeVisible();
    await expect(page.getByText(OTHER_TITLE)).toHaveCount(0);
  });

  test('the feed behind it agrees, so nothing is being hidden by CSS', async ({ page }) => {
    await signIn(page, 'agent');
    expect(await mailTitles(page)).toEqual([PRIMARY_TITLE]);
  });

  test('the unread badge counts what the list shows', async ({ page }) => {
    /*
     * A filtered-out line that still counted would light the badge with nothing behind it, and
     * "Mark all as read" would never clear it. The count endpoint and the feed must agree.
     */
    await signIn(page, 'agent');
    const feed = await apiGet(page, '/api/notifications?filter=unread&limit=100');
    const count = await apiGet(page, '/api/notifications/count');

    const items = (feed.body as { items: unknown[] }).items ?? [];
    expect((count.body as { unread: number }).unread).toBe(items.length);
  });

  test('changing the primary mailbox swaps which line is shown', async ({ page }) => {
    /*
     * THE CASE THIS FILE EXISTS FOR. Both rows are still in the table — the fixture creates and
     * deletes nothing here, it only moves the primary flag — so this proves the decision is made
     * on read. Swapped back afterwards so the tests above hold whatever order they run in.
     */
    await signIn(page, 'agent');
    expect(await mailTitles(page)).toEqual([PRIMARY_TITLE]);

    fixture('--swap');
    await page.goto(CENTRE);
    await expect(page.getByText(OTHER_TITLE)).toBeVisible();
    await expect(page.getByText(PRIMARY_TITLE)).toHaveCount(0);
    expect(await mailTitles(page)).toEqual([OTHER_TITLE]);

    fixture('--swap');
    expect(await mailTitles(page)).toEqual([PRIMARY_TITLE]);
  });
});

test.describe('the button says where it goes', () => {
  test('a new-mail line offers Open mail, not Open deal', async ({ page }) => {
    await signIn(page, 'agent');
    await page.goto(CENTRE);

    const row = page.locator('li').filter({ hasText: PRIMARY_TITLE });
    await expect(row.getByRole('button', { name: 'Open mail' })).toBeVisible();
    // The regression: it read "Open deal" and then opened the Inbox.
    await expect(row.getByRole('button', { name: 'Open deal' })).toHaveCount(0);
  });

  test('and pressing it opens the Inbox', async ({ page }) => {
    await signIn(page, 'agent');
    await page.goto(CENTRE);

    await page.locator('li').filter({ hasText: PRIMARY_TITLE })
      .getByRole('button', { name: 'Open mail' }).click();

    await expect(page).toHaveURL(/\/inbox\b/);
  });
});
