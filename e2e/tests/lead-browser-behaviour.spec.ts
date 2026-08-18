import { test, expect, type Page } from '@playwright/test';
import { signIn, apiSend } from './helpers';

/**
 * WHAT REAL PEOPLE DO TO A FORM, IN A REAL BROWSER.
 *
 * ================================================================================================
 * WHY THIS FILE EXISTS. The suite already drives Leads heavily — creating, editing, deleting,
 * checking permissions — and it does all of it in one clean pass per test. What it almost never does
 * is what an actual person does on a slow laptop with fourteen tabs open. Counted across all 34 spec
 * files before this one was written:
 *
 *     page.reload()              3 files
 *     browser back button        0 files
 *     double-clicking Save       0 files
 *     stale tab / storage        0 files
 *
 * Those four are where the interesting defects live, because each of them re-enters code that was
 * written assuming it runs once, in order, on fresh state: a double-submitted form creates two
 * records, a refresh loses an unsaved draft or shows a stale one, a back button lands on a page
 * whose data has since changed.
 *
 * Multi-user IS well covered elsewhere (20 files open a second context), so the concurrency case
 * here is the narrow one those miss: two people editing the SAME lead, where the question is what
 * the second save does to the first person's screen.
 * ================================================================================================
 *
 * EVERY TEST CLEANS UP AFTER ITSELF. The Leads list is newest-first, so litter from previous runs
 * pushes the seeded book off page one and later assertions fail for reasons that have nothing to do
 * with the code — a lesson `leads.spec.ts` records in its own header.
 */

const unique = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const created: number[] = [];

async function trackCreated(page: Page, name: string): Promise<number | null> {
  const res = await page.evaluate(async (n) => {
    const r = await fetch(`${window.location.origin.replace('5174', '8100')}/api/leads?search=${encodeURIComponent(n)}`, {
      credentials: 'include', headers: { Accept: 'application/json' },
    });
    return r.ok ? r.json() : null;
  }, name);
  const id = (res as { data?: { id: number }[] } | null)?.data?.[0]?.id ?? null;
  if (id) created.push(id);
  return id;
}

test.afterAll(async ({ browser }) => {
  if (!created.length) return;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await signIn(page, 'agent');
    for (const id of created) await apiSend(page, 'DELETE', `/api/leads/${id}`);
  } finally {
    await ctx.close();
  }
});

/** Open Leads and the Add-Lead modal, ready to type. */
async function openEditor(page: Page) {
  await page.goto('/crm/lead');
  await page.getByRole('button', { name: '+ Add Lead' }).click();
  await expect(page.getByText('Add New Lead')).toBeVisible();
}

async function fillRequired(page: Page, name: string, email: string) {
  const modal = page.locator('.modal').first();
  await modal.locator('.field', { hasText: 'Name *' }).locator('input').first().fill(name);
  await modal.locator('.field', { hasText: 'Email *' }).locator('input').first().fill(email);
}

// ================================================================ modal behaviour

test.describe('the Add Lead modal', () => {
  test('opens, and Cancel closes it without creating anything', async ({ page }) => {
    await signIn(page, 'agent');
    await openEditor(page);

    const name = unique('Cancelled');
    await fillRequired(page, name, `${unique('cancel')}@example.test`);
    await page.locator('.modal').first().getByRole('button', { name: 'Cancel' }).first().click();

    await expect(page.getByText('Add New Lead')).toBeHidden();
    // The lead must not exist — a Cancel that saves is the worst kind of surprise.
    await page.reload();
    await expect(page.getByText(name)).toBeHidden();
  });

  test('closes on the ✕ control as well as on Cancel', async ({ page }) => {
    await signIn(page, 'agent');
    await openEditor(page);

    await page.locator('.modal').first().getByRole('button', { name: 'Close' }).click();
    await expect(page.getByText('Add New Lead')).toBeHidden();
  });

  test('refuses to submit with the required fields empty, and stays open', async ({ page }) => {
    await signIn(page, 'agent');
    await openEditor(page);

    await page.getByRole('button', { name: 'Create Lead' }).click();

    // The modal must still be there — a form that closes on a rejected save loses the typing.
    await expect(page.getByText('Add New Lead')).toBeVisible();
  });

  test('rejects a malformed address rather than saving it', async ({ page }) => {
    await signIn(page, 'agent');
    await openEditor(page);

    await fillRequired(page, unique('BadEmail'), 'not-an-address');
    await page.getByRole('button', { name: 'Create Lead' }).click();

    await expect(page.getByText('Add New Lead')).toBeVisible();
  });
});

// ================================================================ double submission

test.describe('a person who clicks twice', () => {
  /**
   * THE CLASSIC DUPLICATE: a slow save and an impatient second click must not produce two leads.
   *
   * WHAT ACTUALLY PREVENTS IT, measured rather than assumed. The Save button carries
   * `disabled={saving}`, and the obvious reading is that this is the guard. It is not the one that
   * matters — removing that attribute entirely and re-running this test still produces exactly one
   * lead. The real backstop is in the database:
   *
   *     CREATE UNIQUE INDEX leads_owner_email_key
   *       ON leads (COALESCE(owner_user_id, 0), lower(email))
   *
   * so a second submission of the same address into the same book cannot be written whatever the
   * browser does. That is the right place for it — a disabled button is a courtesy that any network
   * hiccup, replayed request or second tab defeats.
   *
   * The test therefore asserts the OUTCOME (one lead) rather than the mechanism, which is what keeps
   * it honest: it would still pass if the button guard were reworked, and still fail if the unique
   * index were dropped.
   */
  test('double-clicking Create makes one lead, not two', async ({ page }) => {
    await signIn(page, 'agent');
    await openEditor(page);

    const name = unique('DoubleClick');
    await fillRequired(page, name, `${unique('dbl')}@example.test`);

    const save = page.getByRole('button', { name: 'Create Lead' });
    await save.dblclick({ delay: 0 });

    await expect(page.getByText('Add New Lead')).toBeHidden({ timeout: 15_000 });
    await page.goto(`/crm/lead?search=${encodeURIComponent(name)}`);
    await page.waitForLoadState('networkidle');

    // Exactly one row carries the name.
    await expect(page.getByText(name, { exact: false })).toHaveCount(1);
    await trackCreated(page, name);
  });
});

// ================================================================ refresh and back

test.describe('refresh, and the browser back button', () => {
  test('a created lead survives a full page reload', async ({ page }) => {
    await signIn(page, 'agent');
    await openEditor(page);

    const name = unique('Persisted');
    await fillRequired(page, name, `${unique('persist')}@example.test`);
    await page.getByRole('button', { name: 'Create Lead' }).click();
    await expect(page.getByText('Add New Lead')).toBeHidden({ timeout: 15_000 });

    await page.reload();
    await page.goto(`/crm/lead?search=${encodeURIComponent(name)}`);
    await expect(page.getByText(name, { exact: false }).first()).toBeVisible();
    await trackCreated(page, name);
  });

  test('a reload mid-edit discards the unsaved draft rather than half-saving it', async ({ page }) => {
    await signIn(page, 'agent');
    await openEditor(page);

    const name = unique('Abandoned');
    await fillRequired(page, name, `${unique('abandon')}@example.test`);

    // Walk away and come back — the browser equivalent of closing the laptop.
    await page.reload();

    await expect(page.getByText('Add New Lead')).toBeHidden();
    await page.goto(`/crm/lead?search=${encodeURIComponent(name)}`);
    await expect(page.getByText(name, { exact: false })).toHaveCount(0);
  });

  test('the back button returns to the list from a lead, and the list still works', async ({ page }) => {
    await signIn(page, 'agent');
    await page.goto('/crm/lead');
    await page.waitForLoadState('networkidle');

    /*
     * The ROW is not the control — the lead's name is a button and there is a View icon beside it.
     * Clicking the row did nothing at all, so `goBack` went back to the sign-in page and the
     * assertion failed for a reason that had nothing to do with the back button.
     */
    const firstRow = page.locator('tbody tr').first();
    await expect(firstRow).toBeVisible();
    await firstRow.locator('button.prop-link').first().click();
    await expect(page).toHaveURL(/\/crm\/lead\/\d+/);
    await page.waitForLoadState('networkidle');

    await page.goBack();
    await page.waitForLoadState('networkidle');

    // Back on the list, and it is a working list rather than a blank shell.
    await expect(page).toHaveURL(/\/crm\/lead(\?|$)/);
    await expect(page.locator('tbody tr').first()).toBeVisible();
  });

  test('signing out and back in leaves the lead exactly as it was', async ({ page, context }) => {
    await signIn(page, 'agent');
    await openEditor(page);

    const name = unique('SurvivesLogout');
    await fillRequired(page, name, `${unique('logout')}@example.test`);
    await page.getByRole('button', { name: 'Create Lead' }).click();
    await expect(page.getByText('Add New Lead')).toBeHidden({ timeout: 15_000 });
    await trackCreated(page, name);

    await context.clearCookies();
    await signIn(page, 'agent');
    await page.goto(`/crm/lead?search=${encodeURIComponent(name)}`);

    await expect(page.getByText(name, { exact: false }).first()).toBeVisible();
  });
});

// ================================================================ stale sessions and tabs

test.describe('a tab that has been open too long', () => {
  /**
   * A tab left open overnight, then used. The session is gone, and what must NOT happen is a silent
   * failure that looks like a save — the person has to be told to sign in again.
   */
  test('a save from a tab whose session has expired does not silently succeed', async ({ page, context }) => {
    await signIn(page, 'agent');
    await openEditor(page);

    const name = unique('StaleTab');
    await fillRequired(page, name, `${unique('stale')}@example.test`);

    // The session ends while the modal is open.
    await context.clearCookies();
    await page.getByRole('button', { name: 'Create Lead' }).click();
    await page.waitForTimeout(1500);

    // Whatever the screen does, nothing may have been written.
    const ctx2 = await page.context().browser()!.newContext();
    const checker = await ctx2.newPage();
    try {
      await signIn(checker, 'agent');
      await checker.goto(`/crm/lead?search=${encodeURIComponent(name)}`);
      await expect(checker.getByText(name, { exact: false })).toHaveCount(0);
    } finally {
      await ctx2.close();
    }
  });
});

// ================================================================ two people, one lead

test.describe('two people editing the same lead', () => {
  /**
   * NOT the isolation case — that is covered in `lead-ownership-scope.spec.ts`. This is the one
   * those miss: a lead both people legitimately hold, edited by both. The question is whether the
   * second save is accepted and whether the first person's screen tells the truth afterwards.
   */
  test('the second save wins, and a reload shows the winning value to both', async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();

    try {
      await signIn(a, 'superAdmin');
      await signIn(b, 'superAdmin');

      // A brokerage lead, reachable by both sessions.
      const name = unique('Shared');
      const res = await apiSend(a, 'POST', '/api/leads', {
        name, email: `${unique('shared')}@example.test`, phone: '4165550000',
      });
      const id = (res.body as { id?: number }).id!;
      created.push(id);

      await apiSend(a, 'PUT', `/api/leads/${id}`, { name: `${name} EDITED-BY-A` });
      await apiSend(b, 'PUT', `/api/leads/${id}`, { name: `${name} EDITED-BY-B` });

      // Both reload; both must see the same, latest value. A cached first render that keeps
      // showing A's edit is the failure worth catching.
      for (const p of [a, b]) {
        await p.goto(`/crm/lead?search=${encodeURIComponent(name)}`);
        await p.waitForLoadState('networkidle');
        await expect(p.getByText('EDITED-BY-B', { exact: false }).first()).toBeVisible();
      }
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
