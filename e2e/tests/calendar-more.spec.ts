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

/**
 * The four questions the block above does not answer.
 *
 * Its isolation test asserts `.cal-item` count equals `onDay(page)` — but both sides of that
 * comparison come from the SAME user's data, so it would pass unchanged if another agent's
 * appointments were leaking into the popover. There were never any to leak. These create some.
 *
 * Also here: that the popover shows the day that was clicked rather than any day, that it survives
 * being closed and reopened, and that it works at phone width — where the grid has least room and
 * "+N more" is most likely to be the only way to reach anything.
 */
const NEIGHBOUR = '2026-09-16';   // the day after DAY, seeded so the popover can pick the wrong one

/** Remove this block's probes for whichever user is signed in on `page`. */
async function clearProbes(page: Page): Promise<void> {
  const res = await apiGet(page, `/api/calendar/events?area=crm&from=${MONTH}-01&to=${MONTH}-30`);
  const events = Array.isArray(res.body) ? res.body as { id: number; title: string }[] : [];
  for (const e of events) {
    if (String(e.title).startsWith(PREFIX) || String(e.title).startsWith('Other agent')) {
      await apiSend(page, 'DELETE', `/api/calendar/events/${e.id}?area=crm&scope=this`);
    }
  }
}

async function seedOn(page: Page, day: string, howMany: number, prefix: string): Promise<void> {
  for (let i = 0; i < howMany; i += 1) {
    await apiSend(page, 'POST', '/api/calendar/events?area=crm', {
      title: `${prefix} ${i + 1}`, date: day,
      time: `${String(9 + i).padStart(2, '0')}:00`, type: 'meeting', allow_overlap: true,
    });
  }
}

test.describe('"+N more" — the day, the owner, and the small screen', () => {
  test('another agent’s appointments on the same day do not appear', async ({ browser }) => {
    /*
     * THE ONE THAT MATTERS. The owner's rule is absolute — "no one can view any other agent's
     * events, not even the admin or super admin" — and a change that surfaces MORE events is exactly
     * where that could quietly stop being true.
     *
     * Two contexts, because signing in on a second page of one context replaces the session cookie
     * for the whole context and would make this test compare a user with themselves.
     */
    const mineCtx = await browser.newContext();
    const theirsCtx = await browser.newContext();
    try {
      const mine = await mineCtx.newPage();
      const theirs = await theirsCtx.newPage();
      await signIn(mine, 'agent');
      await signIn(theirs, 'agent2');
      await clearProbes(mine);
      await clearProbes(theirs);

      await seedOn(mine, DAY, 5, PREFIX);
      await seedOn(theirs, DAY, 4, 'Other agent');

      await mine.goto(`/crm/calendar?month=${MONTH}`);
      const more = mine.locator('button.cal-more');
      await expect(more).toBeVisible({ timeout: 15_000 });
      await more.click();

      const dialog = mine.locator('.modal').last();
      await expect(dialog.locator('.cal-item')).toHaveCount(5);
      // Named explicitly rather than only counted: a count can coincide, a title cannot.
      await expect(dialog.getByText('Other agent', { exact: false })).toHaveCount(0);
      for (let i = 1; i <= 5; i += 1) await expect(dialog.getByText(`${PREFIX} ${i}`)).toBeVisible();

      await clearProbes(mine);
      await clearProbes(theirs);
    } finally {
      await mineCtx.close().catch(() => undefined);
      await theirsCtx.close().catch(() => undefined);
    }
  });

  test('it opens the day that was clicked, not the neighbouring one', async ({ page }) => {
    // Two busy days side by side. A popover keyed on the wrong cell — or on "the first day with
    // overflow" — looks completely normal until the days hold different appointments.
    await signIn(page, 'agent');
    await clearProbes(page);
    try {
      await seedOn(page, DAY, 5, PREFIX);
      await seedOn(page, NEIGHBOUR, 5, `${PREFIX} NEXTDAY`);
      await page.goto(`/crm/calendar?month=${MONTH}`);

      const buttons = page.locator('button.cal-more');
      await expect(buttons).toHaveCount(2, { timeout: 15_000 });

      // The second overflow button is the later day.
      await buttons.nth(1).click();
      const dialog = page.locator('.modal').last();
      await expect(dialog.getByText(`${PREFIX} NEXTDAY 1`)).toBeVisible();
      await expect(dialog.getByText(`${PREFIX} 1`, { exact: true })).toHaveCount(0);
      await expect(dialog.locator('.cal-item')).toHaveCount(5);
    } finally { await clearProbes(page); }
  });

  test('every appointment appears exactly once', async ({ page }) => {
    // Duplication is the other half of "nothing missing", and a count alone cannot tell them apart:
    // five items with one shown twice and one absent still counts five.
    await signIn(page, 'agent');
    await clearProbes(page);
    try {
      await seedOn(page, DAY, 6, PREFIX);
      await page.goto(`/crm/calendar?month=${MONTH}`);
      await page.locator('button.cal-more').first().click();

      const dialog = page.locator('.modal').last();
      await expect(dialog.locator('.cal-item')).toHaveCount(6);
      for (let i = 1; i <= 6; i += 1) {
        await expect(dialog.getByText(`${PREFIX} ${i}`, { exact: true })).toHaveCount(1);
      }
    } finally { await clearProbes(page); }
  });

  test('it can be closed and opened again', async ({ page }) => {
    /*
     * The block above closes it once. Reopening is where a popover that stores its day in state and
     * never clears it goes wrong — the second open shows the first day, or nothing at all.
     */
    await signIn(page, 'agent');
    await clearProbes(page);
    try {
      await seedOn(page, DAY, 5, PREFIX);
      await page.goto(`/crm/calendar?month=${MONTH}`);
      const more = page.locator('button.cal-more').first();
      await expect(more).toBeVisible({ timeout: 15_000 });

      for (let round = 1; round <= 2; round += 1) {
        await more.click();
        const dialog = page.locator('.modal').last();
        await expect(dialog.locator('.cal-item')).toHaveCount(5);
        await dialog.locator('.close').click();
        await expect(page.locator('.modal')).toHaveCount(0);
      }
      expect(await onDay(page)).toBe(5);
    } finally { await clearProbes(page); }
  });

  test('it works at phone width, where it matters most', async ({ browser }) => {
    // The narrower the cell, the fewer chips fit and the more of the day lives behind this button.
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const page = await ctx.newPage();
      await signIn(page, 'agent');
      await clearProbes(page);
      await seedOn(page, DAY, 5, PREFIX);

      await page.goto(`/crm/calendar?month=${MONTH}`);
      const more = page.locator('button.cal-more').first();
      await expect(more).toBeVisible({ timeout: 15_000 });
      await more.click();

      const dialog = page.locator('.modal').last();
      await expect(dialog.locator('.cal-item')).toHaveCount(5);
      // The dialog itself must not overflow the viewport, or the appointments it reveals are
      // unreachable in a different way from the one this feature fixed.
      const box = await dialog.boundingBox();
      expect(box).toBeTruthy();
      expect(Math.round(box!.width)).toBeLessThanOrEqual(390);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      await clearProbes(page);
    } finally { await ctx.close(); }
  });
});


// ============================================================================ analytics placement
/**
 * Calendar analytics belongs to the Transaction Desk, not the CRM.
 *
 * Removed from the CRM calendar by request. It is a REMOVAL FROM ONE AREA, not a deletion: the
 * panel, its endpoint and the Desk's use of it are all untouched. Both halves are asserted here,
 * because a change that quietly took it off the Desk too would satisfy the first assertion alone.
 *
 * The two calendars are one component behind one route, told apart by `area` — which is exactly why
 * this is worth pinning. A future edit to the shared page has no obvious reminder that the panel is
 * meant to appear on only one side of it.
 */
test.describe('calendar analytics is Transaction Desk only', () => {
  const panel = (page: import('@playwright/test').Page) =>
    page.getByText('Calendar analytics', { exact: true });

  test('the CRM calendar does not offer it', async ({ page }) => {
    await signIn(page, 'agent');
    await page.goto(`/crm/calendar?month=${MONTH}`);

    // The page itself still works — this is a removal, not a broken screen.
    await expect(page.getByText("Today's Events")).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
  });

  test('the Transaction Desk calendar still offers it', async ({ page }) => {
    await signIn(page, 'agent');
    await page.goto(`/desk/calendar?month=${MONTH}`);

    await expect(panel(page)).toBeVisible();
  });

  test('the endpoint is untouched and still answers for both areas', async ({ page }) => {
    /*
     * The panel was taken off one screen; nothing was removed from the API. A CRM caller asking
     * directly still gets an answer — which is what makes this a presentation change rather than a
     * capability being withdrawn.
     */
    await signIn(page, 'agent');
    for (const area of ['crm', 'desk']) {
      const res = await apiGet(page, `/api/calendar/analytics?area=${area}&from=${MONTH}-01&to=${MONTH}-28`);
      expect(res.status).toBe(200);
    }
  });
});
