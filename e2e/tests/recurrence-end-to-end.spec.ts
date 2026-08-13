import { expect, test, type Page } from '@playwright/test';
import { apiGet, apiSend, signIn } from './helpers';

/**
 * PRIORITY 6 — recurrence through the whole round trip: API → database → occurrence generation →
 * what the calendar actually shows.
 *
 * THE MATHS IS NOT RE-TESTED HERE. `server/src/calendar/recurrence.spec.ts` already covers 19 cases
 * including month ends, the 31st clamping into February, the 29th in a leap February and crossing a
 * year boundary — and it covers them far better than a browser test could. What none of that touches
 * is whether the rule a person types produces the appointments a person sees: the expansion could be
 * perfect and the write, the month query, the grid or the series scope could still lose them.
 *
 * So every assertion below is about the ROUND TRIP. The dates are chosen to be arithmetically dull
 * on purpose; if one of these fails it is the plumbing, not the calendar arithmetic.
 */

const MONTH = '2027-03';
const START = '2027-03-02';        // a Tuesday
const PREFIX = 'ZZRECUR';

/*
 * ONE WIDE RANGE, NOT A LOOP OF MONTHS ENDING ON THE 28TH.
 *
 * The first version walked `${month}-01` to `${month}-28`, which silently left anything on the 29th
 * to the 31st behind — a fortnightly rule from 2 March lands on 30 March, and that one survivor
 * failed the NEXT test with an off-by-one that looked like a recurrence bug. The cleanup was wrong,
 * not the expansion.
 */
async function clearProbes(page: Page): Promise<void> {
  const res = await apiGet(page, '/api/calendar/events?area=crm&from=2027-01-01&to=2027-12-31');
  const events = Array.isArray(res.body) ? res.body as { id: number; title: string }[] : [];
  for (const e of events) {
    if (String(e.title).startsWith(PREFIX)) {
      await apiSend(page, 'DELETE', `/api/calendar/events/${e.id}?area=crm&scope=this`).catch(() => undefined);
    }
  }
}

/** Everything on the probe's dates, straight from the API the grid uses. */
async function occurrences(page: Page, from = '2027-02-01', to = '2027-05-31'): Promise<{ id: number; title: string; date: string; recurrence_id: number | null }[]> {
  const res = await apiGet(page, `/api/calendar/events?area=crm&from=${from}&to=${to}`);
  const all = Array.isArray(res.body) ? res.body as { id: number; title: string; date: string; recurrence_id: number | null }[] : [];
  return all.filter((e) => String(e.title).startsWith(PREFIX)).sort((a, b) => a.date.localeCompare(b.date));
}

async function createSeries(page: Page, body: Record<string, unknown>) {
  const r = await apiSend(page, 'POST', '/api/calendar/events?area=crm', {
    title: `${PREFIX} weekly`, date: START, time: '11:00', type: 'meeting', allow_overlap: true, ...body,
  });
  expect(r.status, `create failed: ${JSON.stringify(r.body)}`).toBeLessThan(300);
  return r.body as Record<string, unknown>;
}

test.describe('a repeat rule produces the appointments it promises', () => {
  test.beforeEach(async ({ page }) => { await signIn(page, 'agent'); await clearProbes(page); });
  test.afterEach(async ({ page }) => { await clearProbes(page); });

  test('weekly × 4 lands on four consecutive Tuesdays', async ({ page }) => {
    await createSeries(page, { recur_freq: 'weekly', recur_interval: 1, recur_count: 4 });
    const got = await occurrences(page);

    expect(got.map((e) => e.date.slice(0, 10)))
      .toEqual(['2027-03-02', '2027-03-09', '2027-03-16', '2027-03-23']);
    // Every occurrence is a real row with its own id — not one row the grid repeats, which would
    // make "edit just this one" impossible.
    expect(new Set(got.map((e) => e.id)).size).toBe(4);
    // And they are tied together, or "the whole series" has nothing to act on.
    const series = new Set(got.map((e) => e.recurrence_id));
    expect(series.size).toBe(1);
    expect([...series][0]).toBeTruthy();
  });

  test('the occurrences are visible in the month grid, not merely in the API', async ({ page }) => {
    /*
     * The step a service test cannot take. The month query is scoped to the grid's own span, so an
     * off-by-one there — or a client that only renders the first of a series — shows a person one
     * appointment where the database holds four.
     */
    await createSeries(page, { recur_freq: 'weekly', recur_interval: 1, recur_count: 4 });
    await page.goto(`/crm/calendar?month=${MONTH}`);
    /*
     * SCOPED TO THE GRID. A bare `getByText` counted 8 for four appointments: the screen also lists
     * them in the "Upcoming Events" panel beside the grid, so every one was matched twice. The
     * duplicate was in the test's reading of the page, not in the page.
     */
    const grid = page.locator('.cal-grid');
    await expect(grid.getByText(`${PREFIX} weekly`).first()).toBeVisible({ timeout: 15_000 });
    await expect(grid.getByText(`${PREFIX} weekly`)).toHaveCount(4);
  });

  test('every-other-week skips the weeks in between', async ({ page }) => {
    await createSeries(page, { recur_freq: 'weekly', recur_interval: 2, recur_count: 3 });
    expect((await occurrences(page)).map((e) => e.date.slice(0, 10)))
      .toEqual(['2027-03-02', '2027-03-16', '2027-03-30']);
  });

  test('an end date is honoured and is inclusive of itself', async ({ page }) => {
    // Inclusivity is the classic off-by-one, and the one people notice: the last appointment they
    // asked for is simply missing.
    await createSeries(page, { recur_freq: 'weekly', recur_interval: 1, recur_until: '2027-03-16' });
    expect((await occurrences(page)).map((e) => e.date.slice(0, 10)))
      .toEqual(['2027-03-02', '2027-03-09', '2027-03-16']);
  });

  test('a monthly rule crosses the month boundary intact', async ({ page }) => {
    await createSeries(page, { recur_freq: 'monthly', recur_interval: 1, recur_count: 3 });
    expect((await occurrences(page)).map((e) => e.date.slice(0, 10)))
      .toEqual(['2027-03-02', '2027-04-02', '2027-05-02']);
  });

  test('a rule that produces nothing is refused rather than silently making one event', async ({ page }) => {
    const r = await apiSend(page, 'POST', '/api/calendar/events?area=crm', {
      title: `${PREFIX} impossible`, date: START, time: '11:00', type: 'meeting', allow_overlap: true,
      recur_freq: 'weekly', recur_interval: 1, recur_until: '2027-02-01',   // before it starts
    });
    expect(r.status).toBe(400);
    expect(await occurrences(page)).toHaveLength(0);
  });
});

test.describe('editing and cancelling one occurrence versus the series', () => {
  test.beforeEach(async ({ page }) => { await signIn(page, 'agent'); await clearProbes(page); });
  test.afterEach(async ({ page }) => { await clearProbes(page); });

  test('editing ONE occurrence leaves the others alone', async ({ page }) => {
    await createSeries(page, { recur_freq: 'weekly', recur_interval: 1, recur_count: 4 });
    const before = await occurrences(page);
    const second = before[1];

    const r = await apiSend(page, 'PUT', `/api/calendar/events/${second.id}?area=crm&scope=this`, {
      title: `${PREFIX} moved one`, date: second.date.slice(0, 10), time: '15:00', allow_overlap: true,
    });
    expect(r.status).toBeLessThan(300);

    const after = await occurrences(page);
    expect(after).toHaveLength(4);
    expect(after.filter((e) => e.title === `${PREFIX} moved one`)).toHaveLength(1);
    expect(after.filter((e) => e.title === `${PREFIX} weekly`)).toHaveLength(3);
  });

  test('editing the SERIES changes this one and the later ones, never the earlier ones', async ({ page }) => {
    /*
     * The rule the module states in its own words: *"Rewriting a meeting that already happened is
     * not what anybody means by 'change the series', and it would quietly destroy the record of what
     * actually took place."* Asserted from the THIRD occurrence, so there are earlier ones to leave
     * alone and later ones to change.
     */
    await createSeries(page, { recur_freq: 'weekly', recur_interval: 1, recur_count: 4 });
    const before = await occurrences(page);
    const third = before[2];

    const r = await apiSend(page, 'PUT', `/api/calendar/events/${third.id}?area=crm&scope=series`, {
      title: `${PREFIX} renamed onwards`, date: third.date.slice(0, 10), time: '11:00', allow_overlap: true,
    });
    expect(r.status).toBeLessThan(300);

    const after = await occurrences(page);
    expect(after).toHaveLength(4);
    expect(after.slice(0, 2).map((e) => e.title)).toEqual([`${PREFIX} weekly`, `${PREFIX} weekly`]);
    expect(after.slice(2).map((e) => e.title)).toEqual([`${PREFIX} renamed onwards`, `${PREFIX} renamed onwards`]);
  });

  test('cancelling ONE occurrence removes exactly one', async ({ page }) => {
    await createSeries(page, { recur_freq: 'weekly', recur_interval: 1, recur_count: 4 });
    const before = await occurrences(page);

    const r = await apiSend(page, 'DELETE', `/api/calendar/events/${before[1].id}?area=crm&scope=this`);
    expect(r.status).toBeLessThan(300);

    const after = await occurrences(page);
    expect(after).toHaveLength(3);
    expect(after.map((e) => e.id)).not.toContain(before[1].id);
  });

  test('cancelling the SERIES drops this one and the ones still to come', async ({ page }) => {
    await createSeries(page, { recur_freq: 'weekly', recur_interval: 1, recur_count: 4 });
    const before = await occurrences(page);

    const r = await apiSend(page, 'DELETE', `/api/calendar/events/${before[2].id}?area=crm&scope=series`);
    expect(r.status).toBeLessThan(300);

    // The two that already happened stay, because they did.
    const after = await occurrences(page);
    expect(after.map((e) => e.id)).toEqual([before[0].id, before[1].id]);
  });

  test('the grid reflects a cancelled series without a reload trick', async ({ page }) => {
    await createSeries(page, { recur_freq: 'weekly', recur_interval: 1, recur_count: 4 });
    const before = await occurrences(page);
    await apiSend(page, 'DELETE', `/api/calendar/events/${before[2].id}?area=crm&scope=series`);

    await page.goto(`/crm/calendar?month=${MONTH}`);
    const grid = page.locator('.cal-grid');
    await expect(grid.getByText(`${PREFIX} weekly`).first()).toBeVisible({ timeout: 15_000 });
    await expect(grid.getByText(`${PREFIX} weekly`)).toHaveCount(2);
  });
});

test.describe('a series belongs to its owner', () => {
  test('another agent sees none of it, and cannot reach an occurrence by id', async ({ browser }) => {
    // Recurrence multiplies rows, so it multiplies the surface of any scoping mistake — four chances
    // instead of one for an occurrence to escape the owner's calendar.
    const mineCtx = await browser.newContext();
    const theirsCtx = await browser.newContext();
    try {
      const mine = await mineCtx.newPage();
      const theirs = await theirsCtx.newPage();
      await signIn(mine, 'agent');
      await signIn(theirs, 'agent2');
      await clearProbes(mine);

      await createSeries(mine, { recur_freq: 'weekly', recur_interval: 1, recur_count: 4 });
      const ours = await occurrences(mine);
      expect(ours).toHaveLength(4);

      expect(await occurrences(theirs)).toHaveLength(0);
      for (const ev of ours) {
        expect((await apiGet(theirs, `/api/calendar/events/${ev.id}?area=crm`)).status).toBe(404);
      }
      // And a series-scoped delete from an intruder must not take the whole run down.
      const del = await apiSend(theirs, 'DELETE', `/api/calendar/events/${ours[0].id}?area=crm&scope=series`);
      expect(del.status).not.toBe(200);
      expect(await occurrences(mine)).toHaveLength(4);

      await clearProbes(mine);
    } finally { await theirsCtx.close(); await mineCtx.close(); }
  });
});
