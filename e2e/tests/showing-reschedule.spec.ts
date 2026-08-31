import { test, expect, type Page } from '@playwright/test';
import { signIn, apiGet, apiSend } from './helpers';

/**
 * CRM-042: the Reschedule button asks where the showing is going.
 *
 * WHAT IT DID. Pressing Reschedule on a completed showing asked for nothing - no date field, no
 * time field, no dialog - and flipped the showing back to Scheduled at the slot it already had.
 * That is un-completing, not rescheduling. And because it was the only control on a showing that
 * mentioned moving one, an agent needing to shift a viewing to another day had nowhere obvious to
 * go: the date and time boxes above the list belong to the ADD form, so using those makes a SECOND
 * showing. The workaround people are left with is delete and recreate, which discards the original
 * record - in a module where a deletion leaves no audit trail either.
 *
 * NOT FIXED BY RENAMING IT "REOPEN", which the report offered as the cheap option. The code comment
 * on the old button records that Reopen was removed on request, so putting the word back would undo
 * somebody's deliberate decision; and a rename leaves the actual gap exactly where it was.
 *
 * THE OLD BEHAVIOUR IS STILL REACHABLE IN ONE KEYPRESS, which is the part worth protecting. The
 * dialog opens pre-filled with the current slot, so confirming it unchanged does what the button
 * always did. Undoing a mis-clicked Complete did not get harder.
 */

const unique = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const created: { page: Page; id: number }[] = [];

const SLOT = { date: '2026-09-10', time: '12:00' };

test.afterEach(async () => {
  while (created.length) {
    const c = created.pop()!;
    await apiSend(c.page, 'DELETE', `/api/leads/${c.id}`).catch(() => undefined);
  }
});

type Showing = { id: number; showing_date: string; time: string; status: string };

/** A lead with one COMPLETED showing - the state in which Reschedule appears. */
async function makeLeadWithCompletedShowing(page: Page): Promise<{ leadId: number; showingId: number; name: string }> {
  const name = unique('ZZ-SHOWING');
  const lead = await apiSend(page, 'POST', '/api/leads', {
    name, email: `${unique('zz-showing')}@example.test`,
  });
  expect([200, 201]).toContain(lead.status);
  const leadId = (lead.body as { id?: number; data?: { id?: number } }).id
    ?? (lead.body as { data?: { id?: number } }).data?.id as number;
  created.push({ page, id: leadId });

  const showing = await apiSend(page, 'POST', `/api/leads/${leadId}/showings`, {
    showing_date: SLOT.date, time: SLOT.time, property: `${name} Property`,
  });
  expect([200, 201]).toContain(showing.status);
  const showingId = (showing.body as { id?: number; data?: { id?: number } }).id
    ?? (showing.body as { data?: { id?: number } }).data?.id as number;

  await apiSend(page, 'PUT', `/api/leads/${leadId}/showings/${showingId}`, { status: 'completed' });
  return { leadId, showingId, name };
}

const showingNow = async (page: Page, leadId: number, showingId: number): Promise<Showing | undefined> => {
  const res = await apiGet(page, `/api/leads/${leadId}`);
  const body = res.body as { showings?: Showing[]; data?: { showings?: Showing[] } };
  return (body.showings ?? body.data?.showings ?? []).find((s) => s.id === showingId);
};

const openLead = async (page: Page, leadId: number) => {
  await page.goto(`/crm/lead/${leadId}`);
  await expect(page.getByText(/Showings \(/)).toBeVisible({ timeout: 15_000 });
};

test.describe('rescheduling a showing from the lead', () => {
  test('Reschedule asks for a new date and time instead of firing', async ({ page }) => {
    await signIn(page, 'admin');
    const { leadId } = await makeLeadWithCompletedShowing(page);
    await openLead(page, leadId);

    await page.getByRole('button', { name: /^Reschedule$/ }).click();

    // THE DEFECT: nothing was asked. The showing simply went back to Scheduled, unmoved.
    const dialog = page.locator('.modal').filter({ hasText: 'Reschedule this showing' });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog.locator('input[type="date"]')).toHaveValue(SLOT.date);
    await expect(dialog.locator('input[type="time"]')).toHaveValue(SLOT.time);
  });

  test('it moves the showing to the day you choose', async ({ page }) => {
    await signIn(page, 'admin');
    const { leadId, showingId } = await makeLeadWithCompletedShowing(page);
    await openLead(page, leadId);

    await page.getByRole('button', { name: /^Reschedule$/ }).click();
    const dialog = page.locator('.modal').filter({ hasText: 'Reschedule this showing' });
    await dialog.locator('input[type="date"]').fill('2026-09-17');
    await dialog.locator('input[type="time"]').fill('15:30');
    await dialog.getByRole('button', { name: /^Reschedule$/ }).click();

    await expect.poll(async () => {
      const s = await showingNow(page, leadId, showingId);
      return `${s?.showing_date} ${s?.time} ${s?.status}`;
    }, { timeout: 15_000 }).toBe('2026-09-17 15:30 scheduled');
  });

  test('cancelling moves nothing and leaves the status alone', async ({ page }) => {
    await signIn(page, 'admin');
    const { leadId, showingId } = await makeLeadWithCompletedShowing(page);
    await openLead(page, leadId);

    await page.getByRole('button', { name: /^Reschedule$/ }).click();
    const dialog = page.locator('.modal').filter({ hasText: 'Reschedule this showing' });
    await dialog.locator('input[type="date"]').fill('2026-09-17');
    await dialog.getByRole('button', { name: /^Cancel$/ }).click();

    await expect(dialog).toBeHidden();
    const s = await showingNow(page, leadId, showingId);
    // Still completed, still on its original day: opening the dialog is not the action.
    expect(`${s?.showing_date} ${s?.time} ${s?.status}`).toBe(`${SLOT.date} ${SLOT.time} completed`);
  });

  test('confirming it unchanged still un-does a mis-clicked Complete', async ({ page }) => {
    /*
     * The behaviour the old button had, kept. This is the case an agent hits after pressing
     * Complete by accident, and it must not have got harder - so the affirmative button says what
     * it will do rather than making them read a date they did not change.
     */
    await signIn(page, 'admin');
    const { leadId, showingId } = await makeLeadWithCompletedShowing(page);
    await openLead(page, leadId);

    await page.getByRole('button', { name: /^Reschedule$/ }).click();
    const dialog = page.locator('.modal').filter({ hasText: 'Reschedule this showing' });
    await expect(dialog.getByRole('button', { name: /Return to Scheduled/ })).toBeVisible();
    await dialog.getByRole('button', { name: /Return to Scheduled/ }).click();

    await expect.poll(async () => {
      const s = await showingNow(page, leadId, showingId);
      return `${s?.showing_date} ${s?.time} ${s?.status}`;
    }, { timeout: 15_000 }).toBe(`${SLOT.date} ${SLOT.time} scheduled`);
  });

  test('a scheduled showing offers no Reschedule, as before', async ({ page }) => {
    // The button appears only on a showing that has been completed or cancelled. Unchanged.
    await signIn(page, 'admin');
    const { leadId, showingId } = await makeLeadWithCompletedShowing(page);
    await apiSend(page, 'PUT', `/api/leads/${leadId}/showings/${showingId}`, { status: 'scheduled' });
    await openLead(page, leadId);

    await expect(page.getByRole('button', { name: /^Reschedule$/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Complete$/ })).toBeVisible();
  });
});
