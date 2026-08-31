import { expect, test, type Page } from '@playwright/test';
import { apiGet, apiSend, signIn } from './helpers';

/**
 * "Upcoming Events" covers the next TWO DAYS.
 *
 * WHAT IT DID BEFORE. It listed the next EIGHT appointments whenever they happened to fall. On a
 * quiet calendar that reached weeks ahead; on a busy one it stopped part-way through tomorrow. A
 * fixed count answers a different question depending on how full the diary is, which is not what
 * somebody glancing at the panel beside Today's list is asking.
 *
 * THE BOUNDARY IS THE WHOLE POINT, so these tests seed appointments on both sides of it — day +2 is
 * in, day +3 is out — rather than asserting a length and hoping. They also check that the panel no
 * longer truncates: within the window every appointment must appear, because there is no "+N more"
 * here to reach the hidden ones.
 *
 * DATES ARE COMPUTED FROM TODAY, not hard-coded. A fixed date would pass until it drifted out of
 * the window and then fail for a reason that has nothing to do with the code.
 */

const PREFIX = 'Upcoming window probe';

/** yyyy-mm-dd for today + n, using local calendar days exactly as the page does. */
function dayOffset(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Remove this file's own appointments, rather than trusting the previous run to have tidied up. */
async function clear(page: Page): Promise<void> {
  const res = await apiGet(page, `/api/calendar/events?area=crm&from=${dayOffset(-2)}&to=${dayOffset(20)}`);
  const events = Array.isArray(res.body) ? res.body as { id: number; title: string }[] : [];
  for (const e of events) {
    if (String(e.title).startsWith(PREFIX)) {
      await apiSend(page, 'DELETE', `/api/calendar/events/${e.id}?area=crm&scope=this`);
    }
  }
}

async function seed(page: Page, title: string, offset: number, time = '10:00'): Promise<void> {
  await apiSend(page, 'POST', '/api/calendar/events?area=crm', {
    title, date: dayOffset(offset), time, type: 'meeting', area: 'crm',
  });
}

/** The Upcoming panel's rendered titles, in order. */
async function upcomingTitles(page: Page): Promise<string[]> {
  const panel = page.locator('.card', { hasText: 'Upcoming Events' }).first();
  await expect(panel).toBeVisible();
  const text = await panel.innerText();
  return text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith(PREFIX));
}

test.describe('Upcoming Events shows the next two days', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, 'agent');
    await clear(page);
  });
  test.afterEach(async ({ page }) => { await clear(page); });

  test('includes tomorrow and the day after, and excludes day three', async ({ page }) => {
    await seed(page, `${PREFIX} tomorrow`, 1);
    await seed(page, `${PREFIX} day-after`, 2);
    await seed(page, `${PREFIX} too-far`, 3);

    await page.goto('/crm/calendar');

    const titles = await upcomingTitles(page);
    expect(titles).toContain(`${PREFIX} tomorrow`);
    expect(titles).toContain(`${PREFIX} day-after`);
    // The boundary. Day +3 is the first one outside the window.
    expect(titles).not.toContain(`${PREFIX} too-far`);
  });

  test('excludes today — Today has its own list beside this one', async ({ page }) => {
    await seed(page, `${PREFIX} today`, 0);
    await seed(page, `${PREFIX} tomorrow`, 1);

    await page.goto('/crm/calendar');

    const titles = await upcomingTitles(page);
    expect(titles).not.toContain(`${PREFIX} today`);
    expect(titles).toContain(`${PREFIX} tomorrow`);
  });

  test('excludes what has already happened', async ({ page }) => {
    await seed(page, `${PREFIX} yesterday`, -1);
    await seed(page, `${PREFIX} tomorrow`, 1);

    await page.goto('/crm/calendar');

    const titles = await upcomingTitles(page);
    expect(titles).not.toContain(`${PREFIX} yesterday`);
    expect(titles).toContain(`${PREFIX} tomorrow`);
  });

  test('shows every appointment in the window — more than the old cap of eight', async ({ page }) => {
    // Ten inside two days. The previous behaviour stopped at eight and said nothing about the rest;
    // this panel has no "+N more", so a cap here hides appointments with nothing to click.
    for (let i = 0; i < 5; i += 1) await seed(page, `${PREFIX} t${i}`, 1, `${String(9 + i).padStart(2, '0')}:00`);
    for (let i = 0; i < 5; i += 1) await seed(page, `${PREFIX} d${i}`, 2, `${String(9 + i).padStart(2, '0')}:00`);

    await page.goto('/crm/calendar');

    const titles = await upcomingTitles(page);
    expect(titles).toHaveLength(10);
  });

  test('lists them in date then time order', async ({ page }) => {
    // Seeded out of order on purpose — the panel sorts, it does not rely on the API's ordering.
    await seed(page, `${PREFIX} c`, 2, '09:00');
    await seed(page, `${PREFIX} a`, 1, '08:00');
    await seed(page, `${PREFIX} b`, 1, '15:00');

    await page.goto('/crm/calendar');

    expect(await upcomingTitles(page)).toEqual([`${PREFIX} a`, `${PREFIX} b`, `${PREFIX} c`]);
  });

  test('says what the window is, rather than leaving an absence unexplained', async ({ page }) => {
    await seed(page, `${PREFIX} too-far`, 5);

    await page.goto('/crm/calendar');

    const panel = page.locator('.card', { hasText: 'Upcoming Events' }).first();
    // A known appointment five days out is absent by design; the panel has to say so, or it reads
    // as a bug.
    await expect(panel).toContainText(/Next 2 days/i);
    await expect(panel).toContainText(/Nothing in the next 2 days/i);
  });
});
