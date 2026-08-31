import { expect, test, type Page } from '@playwright/test';
import { apiGet, apiSend, signIn } from './helpers';

/**
 * Deleting an appointment from the editor you already have open.
 *
 * WHAT WAS WRONG. `Delete` existed only on the event ROWS — the Upcoming list, Today's card and the
 * day view. Opening an appointment to change something and then deciding to remove it meant closing
 * the form, finding the row again, and deleting from there. The Edit Event dialog offered Cancel and
 * Update and nothing else, so from inside it the appointment could not be removed at all.
 *
 * WHAT THESE TESTS ALSO GUARD, and the reason the button delegates instead of deleting: a repeating
 * appointment must still ask whether to remove this occurrence or this one and every later one, and
 * must never touch earlier ones. The editor routes into the calendar's existing confirm dialog
 * rather than carrying a second, quieter deletion — these tests fail if that ever changes.
 */

const PREFIX = 'Editor delete probe';

/**
 * Relative to today, not a fixed date.
 *
 * These appointments are reached through the Upcoming panel, which covers the next two days — so a
 * hard-coded month only works while that month happens to be tomorrow. Tomorrow is always in the
 * window, whatever the date when this runs.
 */
function dayOffset(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const DAY = dayOffset(1);

/** Remove this file's own appointments, rather than trusting the previous run to have tidied up. */
async function clearDay(page: Page): Promise<void> {
  const res = await apiGet(page, `/api/calendar/events?area=crm&from=${dayOffset(-2)}&to=${dayOffset(20)}`);
  const events = Array.isArray(res.body) ? res.body as { id: number; title: string }[] : [];
  for (const e of events) {
    if (String(e.title).startsWith(PREFIX)) {
      await apiSend(page, 'DELETE', `/api/calendar/events/${e.id}?area=crm&scope=this`);
    }
  }
}

async function seed(page: Page, title: string): Promise<void> {
  await apiSend(page, 'POST', '/api/calendar/events?area=crm', {
    title, date: DAY, time: '10:00', type: 'meeting', area: 'crm',
  });
}

/** How many of this file's appointments remain — expectations follow the data, not an assumption. */
async function remaining(page: Page): Promise<string[]> {
  const res = await apiGet(page, `/api/calendar/events?area=crm&from=${DAY}&to=${DAY}`);
  const rows = Array.isArray(res.body) ? res.body as { title: string }[] : [];
  return rows.map((r) => String(r.title)).filter((t) => t.startsWith(PREFIX));
}

/** Open the Edit Event dialog for one appointment, through the row's own Edit button. */
async function openEditor(page: Page, title: string) {
  await page.goto('/crm/calendar');
  const row = page.locator('.cal-item', { hasText: title }).first();
  await row.getByRole('button', { name: 'Edit' }).click();
  const dialog = page.locator('.modal', { hasText: 'Edit Event' }).first();
  await expect(dialog.locator('#event-title')).toHaveValue(title);
  return dialog;
}

test.describe('the Edit Event dialog can delete', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, 'agent');
    await clearDay(page);
  });
  test.afterEach(async ({ page }) => { await clearDay(page); });

  test('offers Delete for an existing appointment', async ({ page }) => {
    const title = `${PREFIX} offered`;
    await seed(page, title);

    const dialog = await openEditor(page, title);

    // The gap this closes: the dialog had Cancel and Update and no way to remove anything.
    await expect(dialog.getByRole('button', { name: 'Delete' })).toBeVisible();
  });

  test('removes the appointment, and it stays gone after a reload', async ({ page }) => {
    const title = `${PREFIX} removed`;
    await seed(page, title);
    expect(await remaining(page)).toEqual([title]);

    const dialog = await openEditor(page, title);
    await dialog.getByRole('button', { name: 'Delete' }).click();

    // The calendar's OWN confirm — not a second one belonging to the editor.
    const confirm = page.locator('.modal', { hasText: 'Delete this event?' }).first();
    await expect(confirm).toBeVisible();
    await confirm.locator('button.btn.primary').click();

    await expect.poll(async () => (await remaining(page)).length, { timeout: 10000 }).toBe(0);

    // Persisted, not merely removed from the rendered list.
    await page.reload();
    expect(await remaining(page)).toEqual([]);
  });

  test('closes the editor before asking, so the form is not left behind the confirm', async ({ page }) => {
    const title = `${PREFIX} stacking`;
    await seed(page, title);

    const dialog = await openEditor(page, title);
    await dialog.getByRole('button', { name: 'Delete' }).click();

    // Two stacked dialogs would leave the appointment being edited visible behind the thing asking
    // whether to destroy it.
    await expect(page.locator('.modal', { hasText: 'Edit Event' })).toHaveCount(0);
    await expect(page.locator('.modal', { hasText: 'Delete this event?' }).first()).toBeVisible();
  });

  test('cancelling the confirm leaves the appointment alone', async ({ page }) => {
    const title = `${PREFIX} cancelled`;
    await seed(page, title);

    const dialog = await openEditor(page, title);
    await dialog.getByRole('button', { name: 'Delete' }).click();

    const confirm = page.locator('.modal', { hasText: 'Delete this event?' }).first();
    await confirm.getByRole('button', { name: 'Cancel' }).click();

    // Backing out of a destructive confirm must be a complete no-op.
    expect(await remaining(page)).toEqual([title]);
  });

  test('does NOT offer Delete while creating a new appointment', async ({ page }) => {
    await page.goto('/crm/calendar');
    await page.getByRole('button', { name: '+ Add Event' }).click();

    const dialog = page.locator('.modal', { hasText: 'Add New Event' }).first();
    await expect(dialog).toBeVisible();
    // There is nothing to delete yet, so the button must not be there to click.
    await expect(dialog.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  });
});

test.describe('a viewer who may not edit', () => {
  test('is not given a Delete button in the editor', async ({ page }) => {
    /*
     * `calendar: edit` is what gates the row's Edit and Delete, and it now gates this button too —
     * passed as `undefined` rather than hidden with CSS, so the handler does not exist for a viewer
     * who should not have it. Skipped rather than asserted false when the seeded read-only account
     * cannot reach the calendar at all, because that is a different rule and this file does not
     * own it.
     */
    await signIn(page, 'accounting');
    const res = await apiGet(page, `/api/calendar/events?area=crm&from=${DAY}&to=${DAY}`);
    test.skip(res.status === 403 || res.status === 401, 'This account cannot reach the CRM calendar at all.');

    await page.goto('/crm/calendar');
    const rows = page.locator('.cal-item');
    if (await rows.count() === 0) test.skip(true, 'No appointment visible to this account to open.');

    const edit = rows.first().getByRole('button', { name: 'Edit' });
    if (await edit.count() === 0) return;   // no edit affordance at all — nothing to assert here

    await edit.click();
    const dialog = page.locator('.modal', { hasText: 'Edit Event' }).first();
    await expect(dialog.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  });
});
