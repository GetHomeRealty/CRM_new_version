import { test, expect, type Page } from '@playwright/test';
import { signIn, apiSend, apiGet } from './helpers';

/**
 * CRM-001: "Delete Forever" must ask before it destroys a lead.
 *
 * WHY THIS IS AN END-TO-END TEST rather than a unit one. The defect was never in the handler - it
 * was that `RecycleModal` is a SEPARATE component from `LeadsPage`, so the `ConfirmDialog` the page
 * mounts was simply not in scope on that screen. Nothing about the purge function was wrong, which
 * is exactly why reading it told you nothing. Only pressing the button in a browser shows whether
 * anything is asked.
 *
 * HOW THE ORIGINAL DEFECT WAS PROVED, and why this mirrors it: the tester intercepted the purge at
 * the network layer and blocked it, then counted dialogs (1 -> 1, none rendered) and confirmed the
 * request had been sent on the single click. Had the interceptor not been there, a real record
 * would have been destroyed. This test does the same interception, so a REGRESSION cannot destroy
 * its own fixture on the way to failing.
 *
 * THE SOFT DELETE IS THE CONTROL. It is reversible and it always confirmed; the permanent one did
 * not. Asserting both keeps the fix honest - "add a confirm everywhere" would pass a test that only
 * looked at the purge.
 */

const unique = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PURGE = /\/api\/leads\/deleted\/\d+$/;

/** A lead sitting in Recently Deleted, which is the only place the button exists. */
async function binnedLead(page: Page): Promise<{ id: number; name: string }> {
  const name = unique('ZZ-PURGE');
  const res = await apiSend(page, 'POST', '/api/leads', {
    name, email: `${name.toLowerCase()}@probe.test`, phone: '4165550000',
  });
  expect([200, 201]).toContain(res.status);
  const id = (res.body as { id: number }).id;
  // The ordinary delete: soft, reversible, and what puts it in the bin.
  expect((await apiSend(page, 'DELETE', `/api/leads/${id}`)).status).toBe(200);
  return { id, name };
}

async function openBin(page: Page, name: string): Promise<void> {
  await page.goto('/crm/lead');
  await page.getByRole('button', { name: /Recently Deleted/i }).click();
  // Search rather than page-hunt: the bin is newest-first and other runs leave litter.
  // BY ARIA-LABEL, not placeholder - the leads list behind this modal has its own search box, and
  // a placeholder match picks up whichever the DOM happens to order first.
  await page.getByLabel('Search deleted leads').fill(name);
  // The NAME cell specifically - the email is derived from the name, so a loose text match finds
  // two cells in the same row and trips strict mode.
  await expect(page.getByRole('cell', { name, exact: true })).toBeVisible({ timeout: 10_000 });
}

test.describe('Delete Forever asks first', () => {
  test('one click opens a confirmation and sends NOTHING', async ({ page }) => {
    await signIn(page, 'admin');

    // Block the purge outright. If the fix regresses, the fixture survives anyway.
    const sent: string[] = [];
    await page.route(PURGE, async (route) => {
      if (route.request().method() === 'DELETE') {
        sent.push(route.request().url());
        return route.abort();
      }
      return route.fallback();
    });

    const { id, name } = await binnedLead(page);
    await openBin(page, name);

    await page.getByRole('button', { name: /Delete Forever/i }).first().click();

    // THE DEFECT: this list was empty of dialogs and full of requests.
    await expect(page.getByRole('button', { name: /Delete permanently/i })).toBeVisible();
    expect(sent).toEqual([]);

    // It names the lead, because Restore sits one button-width away and the table has no ID column.
    await expect(page.getByText(new RegExp(`Delete ${name} permanently`, 'i'))).toBeVisible();
    // And it says the thing an agent cannot otherwise know: what goes with it.
    await expect(page.getByText(/cannot be undone/i)).toBeVisible();
    await expect(page.getByText(/email and message history/i)).toBeVisible();

    // Cancel means cancel: still in the bin, still restorable.
    await page.getByRole('button', { name: /^Cancel$/ }).click();
    expect(sent).toEqual([]);
    const still = await apiGet(page, `/api/leads/deleted?search=${encodeURIComponent(name)}`);
    expect(JSON.stringify(still.body)).toContain(name);

    // Unroute first: the guard above aborts every DELETE to this path, this test's own cleanup
    // included, which left one lead behind per run.
    await page.unroute(PURGE);
    await apiSend(page, 'DELETE', `/api/leads/deleted/${id}`).catch(() => undefined);
  });

  test('confirming actually purges', async ({ page }) => {
    // The other half: the dialog must not have turned the button into a no-op.
    await signIn(page, 'admin');
    const { name } = await binnedLead(page);
    await openBin(page, name);

    await page.getByRole('button', { name: /Delete Forever/i }).first().click();
    await page.getByRole('button', { name: /Delete permanently/i }).click();

    await expect(page.getByText(/permanently deleted/i)).toBeVisible({ timeout: 10_000 });
    const gone = await apiGet(page, `/api/leads/deleted?search=${encodeURIComponent(name)}`);
    expect(JSON.stringify(gone.body)).not.toContain(name);
  });

  test('the reversible delete still confirms too', async ({ page }) => {
    // The control. This one always asked; the fix must not have disturbed it.
    await signIn(page, 'admin');
    const name = unique('ZZ-SOFT');
    const res = await apiSend(page, 'POST', '/api/leads', {
      name, email: `${name.toLowerCase()}@probe.test`, phone: '4165550000',
    });
    const id = (res.body as { id: number }).id;

    await page.goto(`/crm/lead?search=${encodeURIComponent(name)}`);
    await expect(page.getByText(name, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /^Delete$/ }).first().click();
    await expect(page.getByText(/moves to Recently Deleted/i)).toBeVisible();

    await page.getByRole('button', { name: /^Cancel$/ }).click();
    await apiSend(page, 'DELETE', `/api/leads/${id}`).catch(() => undefined);
  });
});
