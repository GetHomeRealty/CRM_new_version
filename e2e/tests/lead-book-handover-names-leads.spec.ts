import { test, expect, type Page } from '@playwright/test';
import { signIn, apiGet, apiSend } from './helpers';

/**
 * CRM-043: the hand-over confirmation names the leads it is about to move.
 *
 * WHAT THE DIALOG SAID, in full: "<N> unassigned brokerage lead(s) become <agent>'s to work. Oldest
 * first, so the longest-waiting enquiry goes over first. Only leads nobody holds are eligible - no
 * agent loses anything. Recorded in the audit trail with the name and the number moved." A count, a
 * recipient and an ordering rule. Never which lead.
 *
 * WHY THAT IS WORTH A DIALOG CHANGE. "Oldest first" is doing real work. On the brokerage that
 * reported this the pool held four leads: the oldest a real client from 25 August, the other three
 * test records from the 26th. Handing over "just one" therefore moved the real client's file -
 * permanently, since nothing in the application moves an assigned lead back to the pool - and the
 * window a broker reads before confirming gave them no way to know. The system already knew, because
 * that is how it chooses.
 *
 * IT IS ALSO WHY NINE ACCEPTANCE CRITERIA WENT UNTESTED for that round: the hand-over could not be
 * exercised safely without knowing which record would move.
 *
 * MOST OF THIS SUITE HANDS NOTHING OVER. The dialog is opened and cancelled, which is the behaviour
 * under test. The one test that does commit checks the outcome against what the dialog promised.
 */

const unique = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const created: { page: Page; id: number }[] = [];

test.afterEach(async () => {
  while (created.length) {
    const c = created.pop()!;
    await apiSend(c.page, 'DELETE', `/api/leads/${c.id}`).catch(() => undefined);
  }
});

type Preview = { moving: { id: number; name: string; created_at: string | null }[]; available: number };

/**
 * An unassigned brokerage lead.
 *
 * NO BACK-DATING, because `created_at` cannot be set through the API - intake stamps it with now and
 * no update path writes it. These tests therefore assert on IDENTITY, never on sort order.
 *
 * THE ORDERING RULE IS PROVED AT THE SERVER LAYER INSTEAD, where a fixture can write `created_at`
 * directly: `lead-book-preview.spec.ts` and the "oldest first" case in `core/lead-transfer.spec.ts`
 * build a pool whose id order is the reverse of its age order, which is the only shape in which
 * "oldest first" is distinguishable from "lowest id first". Asserting it here would look like
 * coverage while passing under either rule.
 */
async function poolLead(page: Page, name: string): Promise<number> {
  const res = await apiSend(page, 'POST', '/api/leads', { name, email: `${unique('zz-pool')}@example.test` });
  expect([200, 201]).toContain(res.status);
  const id = (res.body as { id?: number; data?: { id?: number } }).id
    ?? (res.body as { data?: { id?: number } }).data?.id as number;
  created.push({ page, id });
  return id;
}

const openLeadBooks = async (page: Page) => {
  await page.goto('/desk/settings?tab=roles');
  await expect(page.getByRole('heading', { name: 'Lead books' })).toBeVisible({ timeout: 15_000 });
};

/** Arm the hand-over form without pressing the final button. Blank `howMany` means the whole pool. */
async function armHandover(page: Page, howMany: string) {
  const card = page.locator('.card').filter({ hasText: 'Lead books' });
  await card.locator('input[type="number"]').fill(howMany);
  await card.locator('select').selectOption({ index: 1 });
  await card.getByRole('button', { name: 'Hand over' }).click();
  return page.locator('.modal').filter({ hasText: /Hand leads to/ });
}

test.describe('the hand-over confirmation says which leads would move', () => {
  test('the preview endpoint names the leads and dates them', async ({ page }) => {
    // Checked at the API because it is the fact the dialog rests on.
    await signIn(page, 'superAdmin');
    const name = unique('ZZ-BOOK-API');
    await poolLead(page, name);

    const res = await apiGet(page, '/api/leads/books/preview');
    expect(res.status).toBe(200);
    const preview = res.body as Preview;

    // THE DEFECT: none of this was obtainable before pressing the button.
    const mine = preview.moving.find((m) => m.name === name);
    expect(mine).toBeDefined();
    expect(mine!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(preview.available).toBeGreaterThanOrEqual(1);
  });

  test('the dialog shows the lead by name, not just a number', async ({ page }) => {
    /*
     * ASSERTS ON THE LEAD THE PREVIEW NAMES FIRST, not on one this test created, and the difference
     * matters. The shared database carries more than ten unassigned leads; a lead created here is
     * the NEWEST, so oldest-first puts it last and the dialog's display cap hides it. Looking for
     * it would fail for a reason that has nothing to do with the defect.
     */
    await signIn(page, 'superAdmin');
    await poolLead(page, unique('ZZ-BOOK-NAMED'));

    const first = ((await apiGet(page, '/api/leads/books/preview?count=1')).body as Preview).moving[0];
    expect(first).toBeDefined();

    await openLeadBooks(page);
    const dialog = await armHandover(page, '1');

    await expect(dialog).toBeVisible({ timeout: 10_000 });
    // THE DEFECT: the window named a count and an agent, and no lead.
    await expect(dialog.getByText(first.name, { exact: false })).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByText(`#${first.id}`, { exact: false })).toBeVisible();
    await expect(dialog.getByText(/waiting since \d{4}-\d{2}-\d{2}/).first()).toBeVisible();

    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  test('a long list is capped, and says it is capped', async ({ page }) => {
    /*
     * A hand-over of four hundred cannot list four hundred names in a window somebody will read, and
     * a list nobody reads protects nobody. The front of the queue is what matters, since the order
     * is oldest first - but the dialog must say the list is partial rather than imply it is whole.
     */
    await signIn(page, 'superAdmin');
    const available = ((await apiGet(page, '/api/leads/books/preview')).body as Preview).available;
    test.skip(available <= 10, 'pool is smaller than the display cap on this database');

    await openLeadBooks(page);
    const dialog = await armHandover(page, '');

    await expect(dialog.locator('.book-preview li')).toHaveCount(10);
    await expect(dialog.getByText(/and \d+ more/)).toBeVisible();
    await expect(dialog.getByText(/full list is written to the audit trail/i)).toBeVisible();

    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  test('cancelling moves nothing', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const id = await poolLead(page, unique('ZZ-BOOK-CANCEL'));

    await openLeadBooks(page);
    const dialog = await armHandover(page, '1');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    const after = await apiGet(page, `/api/leads/${id}`);
    const lead = (after.body as { assigned_to?: number | null; data?: { assigned_to?: number | null } });
    expect((lead.data ?? lead).assigned_to ?? null).toBeNull();
  });

  test('the confirm button waits until the leads have been named', async ({ page }) => {
    /*
     * Confirming a permanent hand-over while the window still says "finding out which leads these
     * are" would leave the dialog exactly as uninformative as it was. The request is DELAYED here
     * rather than blocked, so the button is observed disabled and then enabled.
     */
    await signIn(page, 'superAdmin');
    await poolLead(page, unique('ZZ-BOOK-SLOW'));

    await openLeadBooks(page);
    await page.route('**/api/leads/books/preview**', async (route) => {
      await new Promise((r) => setTimeout(r, 2500));
      await route.continue();
    });

    const dialog = await armHandover(page, '1');
    const confirm = dialog.getByRole('button', { name: /Hand over \d+ lead/ });
    await expect(confirm).toBeDisabled();
    await expect(confirm).toBeEnabled({ timeout: 15_000 });

    // Unrouted before the teardown runs: an interceptor that outlives its test has twice in this
    // suite's history swallowed the cleanup that follows it.
    await page.unroute('**/api/leads/books/preview**');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  test('it says so plainly when the leads cannot be looked up', async ({ page }) => {
    // A dialog that cannot name them must say that, not fall back to the silent version.
    await signIn(page, 'superAdmin');
    await poolLead(page, unique('ZZ-BOOK-FAIL'));

    await openLeadBooks(page);
    await page.route('**/api/leads/books/preview**', (route) => route.fulfill({ status: 500, body: '{}' }));

    const dialog = await armHandover(page, '1');
    await expect(dialog.getByText(/could not be looked up/i)).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByRole('button', { name: /Hand over \d+ lead/ })).toBeDisabled();

    await page.unroute('**/api/leads/books/preview**');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  test('what it names is what actually moves', async ({ page }) => {
    /*
     * The property the fix rests on: ONE selection, used by the dialog and by the hand-over. A
     * preview naming a different set from the one that moves would be worse than none, because it
     * would be believed.
     */
    await signIn(page, 'superAdmin');
    await poolLead(page, unique('ZZ-BOOK-COMMIT'));

    const promised = ((await apiGet(page, '/api/leads/books/preview?count=1')).body as Preview).moving;
    expect(promised).toHaveLength(1);

    await openLeadBooks(page);
    const dialog = await armHandover(page, '1');
    await expect(dialog.getByText(promised[0].name, { exact: false })).toBeVisible({ timeout: 10_000 });
    await dialog.getByRole('button', { name: /Hand over 1 lead/ }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    const after = await apiGet(page, `/api/leads/${promised[0].id}`);
    const lead = (after.body as { assigned_to?: number | null; data?: { assigned_to?: number | null } });
    expect((lead.data ?? lead).assigned_to ?? null).not.toBeNull();
    // Whatever it moved is this test's to clean up, whether or not this test created it.
    created.push({ page, id: promised[0].id });
  });

  test('an agent cannot read the list at all', async ({ page }) => {
    // Same door as the hand-over itself: naming the leads is not reachable where moving them is not.
    await signIn(page, 'agent');
    const res = await apiGet(page, '/api/leads/books/preview?count=1');
    expect([403, 404]).toContain(res.status);
  });
});
