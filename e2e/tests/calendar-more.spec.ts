import { expect, test, type Page } from '@playwright/test';
import { apiGet, apiSend, signIn } from './helpers';

/**
 * The month grid's "+N more".
 *
 * WHAT WAS WRONG. A cell shows three appointments and counted the rest as "+2 more" — as a plain
 * `<span>` with no handler. The remaining appointments were not reachable from the grid at all: no
 * click, no hover, no expand. A day with six appointments hid three of them permanently.
 *
 * The fix opens a list of that day's appointments, built from the same `EventRow` the Today's card
 * uses and given the same `canEdit`, so nothing in it can do anything the rest of the screen
 * cannot. These tests cover the interaction and, just as importantly, that surfacing more events
 * did not give anybody a way to reach an event they could not reach before.
 */

const MONTH = '2026-09';
const DAY = '2026-09-15';
const PREFIX = 'Grid probe';

/**
 * Empty the probe day first, rather than trusting the previous run to have tidied up.
 *
 * A test that assumes a clean slate breaks as soon as one run dies before its cleanup — an
 * assertion timeout kills the test where it stands and the `finally` may not finish. That is
 * exactly how thirty-five stale appointments accumulated on this date while these tests were being
 * written, after which "+2 more" was really "+7 more" and every expectation was wrong for a reason
 * that had nothing to do with the code.
 */
async function clearDay(page: Page): Promise<void> {
  const res = await apiGet(page, `/api/calendar/events?area=crm&from=${MONTH}-01&to=${MONTH}-30`);
  const events = Array.isArray(res.body) ? res.body as { id: number; title: string }[] : [];
  for (const e of events) {
    if (String(e.title).startsWith(PREFIX)) {
      await apiSend(page, 'DELETE', `/api/calendar/events/${e.id}?area=crm&scope=this`);
    }
  }
}

async function seedDay(page: Page, howMany: number): Promise<void> {
  for (let i = 0; i < howMany; i += 1) {
    await apiSend(page, 'POST', '/api/calendar/events?area=crm', {
      title: `${PREFIX} ${i + 1}`,
      date: DAY,
      time: `${String(9 + i).padStart(2, '0')}:00`,
      type: 'meeting',
      area: 'crm',
    });
  }
}

/** What the day actually holds, so expectations follow the data rather than an assumption. */
async function onDay(page: Page): Promise<number> {
  const res = await apiGet(page, `/api/calendar/events?area=crm&from=${DAY}&to=${DAY}`);
  return Array.isArray(res.body) ? res.body.length : 0;
}

test.describe('the month grid can show a full day', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, 'agent');
    await clearDay(page);
  });
  test.afterEach(async ({ page }) => { await clearDay(page); });

  test('opens the hidden appointments instead of counting them and stopping', async ({ page }) => {
    await seedDay(page, 5);
    const total = await onDay(page);
    expect(total).toBe(5);

    await page.goto(`/crm/calendar?month=${MONTH}`);

    // Three chips are drawn; the other two were unreachable before this change.
    // `.cal-more` rather than a role+name lookup: the day cell is itself role="button", so its
    // accessible name concatenates every chip plus this label and matches the same query.
    const more = page.locator('button.cal-more');
    await expect(more).toHaveText(`+${total - 3} more`);
    await expect(more).toBeVisible({ timeout: 15_000 });
    await more.click();

    // Every appointment on the day — the three the grid had room for and the two it did not.
    const dialog = page.locator('.modal').last();
    for (let i = 1; i <= 5; i += 1) {
      await expect(dialog.getByText(`${PREFIX} ${i}`)).toBeVisible();
    }
    await expect(dialog.locator('.cal-item')).toHaveCount(5);
  });

  test('does not appear when every appointment already fits', async ({ page }) => {
    await seedDay(page, 2);
    await page.goto(`/crm/calendar?month=${MONTH}`);

    await expect(page.getByText(`${PREFIX} 1`).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('button.cal-more')).toHaveCount(0);
  });

  test('closes again and leaves the grid as it was', async ({ page }) => {
    await seedDay(page, 5);
    await page.goto(`/crm/calendar?month=${MONTH}`);

    const more = page.locator('button.cal-more');
    await expect(more).toBeVisible({ timeout: 15_000 });
    await more.click();

    const dialog = page.locator('.modal').last();
    await expect(dialog.getByText(`${PREFIX} 5`)).toBeVisible();
    await dialog.locator('.close').click();

    await expect(page.locator('.modal')).toHaveCount(0);
    await expect(more).toBeVisible();
    // Nothing was edited by opening and closing it.
    expect(await onDay(page)).toBe(5);
  });

  /**
   * The permission question, which is the one that matters for a change that surfaces more events.
   * A calendar is private to its owner for every role (B-A3), and the list is built from the same
   * fetch as the grid — so it can only ever contain what the API already sent this user.
   */
  test('shows only the signed-in person\'s own appointments', async ({ page }) => {
    await seedDay(page, 5);
    await page.goto(`/crm/calendar?month=${MONTH}`);
    await page.locator('button.cal-more').click();

    const dialog = page.locator('.modal').last();
    // Exactly what the API returned for this user on this day, and nothing else.
    await expect(dialog.locator('.cal-item')).toHaveCount(await onDay(page));
  });
});
