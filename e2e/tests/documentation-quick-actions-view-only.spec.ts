import { test, expect, type Page } from '@playwright/test';
import { signIn, signOut, apiGet, apiSend, ACCOUNTS } from './helpers';

/**
 * EVERY TRANSACTION QUICK ACTION IS VIEW-ONLY FOR THE DOCUMENTATION ROLE.
 *
 * WHAT WAS REPORTED. Team Split showed a blue "View" bar and, beneath it, an "Is this a Team
 * Split?" dropdown. The dropdown was already `disabled` — nothing could be changed through it —
 * but a greyed select with an arrow is a form that looks stuck rather than a record, and a banner
 * explaining why it will not respond is a label compensating for exactly that. Both are gone for
 * this role: the controls render as plain text, so the bar has nothing left to explain.
 *
 * THE RESTRICTION THAT IS REAL, AND NEW. Documents was genuinely editable for this role, in both
 * halves — the screen passed `readOnly={false}` for it specifically, and the eleven document write
 * routes are gated on `transactions: 'edit'`, which this role holds. Uploading, replacing,
 * submitting and deleting drafts were all allowed and are now refused, on the server as well as on
 * screen. That is a REDUCTION in what the role can do, asked for on 2026-10-13.
 *
 * WHY THE API TESTS CARRY THE WEIGHT. A disabled input is a courtesy; the 403 is the restriction.
 * These send real requests from a real Documentation session, which is also the only honest proof
 * the guard is WIRED UP rather than merely written — the unit spec cannot import that controller
 * (it pulls in an ESM-only zip library), so this is where that is established.
 *
 * ONE DEAL, CREATED AND DELETED. The suite leaves the database as it found it, and asserts against
 * a transaction whose shape it chose rather than whichever row happened to sort first.
 */

/** The deal these tests read, created as Super Admin and removed afterwards. */
async function createDeal(page: Page): Promise<number> {
  const created = await apiSend(page, 'POST', '/api/transactions', {
    type: 'Residential Buying',
    property: 'ZZ-DOCVIEW Quick Actions Road',
    status: 'Secured Firm',
    price: 640000,
    comm_type: '%',
    comm_value: 2.5,
    offer_date: '2026-09-01',
    closing_date: '2026-11-28',
    primary_agent: ACCOUNTS.agent.name,
  });
  expect(created.status).toBe(201);
  return (created.body as { data: { id: number } }).data.id;
}

const removeDeal = (page: Page, id: number) =>
  apiSend(page, 'DELETE', `/api/transactions/${id}`).catch(() => undefined);

/** Open a Quick Action by label; returns its modal, or null when the role is not offered it. */
async function openQuickAction(page: Page, label: RegExp) {
  const button = page.getByRole('button', { name: label }).first();
  if (!(await button.count())) return null;
  await button.click();
  const modal = page.locator('.modal').first();
  await expect(modal).toBeVisible({ timeout: 15_000 });
  return modal;
}

/** How many controls in this panel actually accept input. The assertion that survives new fields. */
const editableCount = (modal: ReturnType<Page['locator']>) =>
  modal.evaluate((el) => [...el.querySelectorAll('input, select, textarea')]
    .filter((f) => !f.matches(':disabled') && !(f as HTMLInputElement).readOnly).length);

// =====================================================================================
test.describe('the server refuses document changes from a Documentation session', () => {
  test('REFUSES EVERY SHAPE OF DOCUMENT WRITE, which is the half a hand-made request meets', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const id = await createDeal(page);
    try {
      await signOut(page);
      await signIn(page, 'docs');

      // The bulk update the Documents modal's Save used to call.
      const put = await apiSend(page, 'PUT', `/api/transactions/${id}/documents`, { documents: [] });
      expect(put.status).toBe(403);
      expect(JSON.stringify(put.body)).toMatch(/view-only/i);

      // Other shapes, so this is a rule about the resource rather than one guarded route.
      expect((await apiSend(page, 'POST', `/api/transactions/${id}/documents/submit`, { draft_ids: [] })).status).toBe(403);
      expect((await apiSend(page, 'POST', `/api/transactions/${id}/documents/send-reminders`, {})).status).toBe(403);
    } finally {
      await signOut(page);
      await signIn(page, 'superAdmin');
      await removeDeal(page, id);
    }
  });

  test('STILL ALLOWS READING — the role\'s job is the paperwork, and taking that away is not the ask', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const id = await createDeal(page);
    try {
      await signOut(page);
      await signIn(page, 'docs');
      expect((await apiGet(page, `/api/transactions/${id}/documents`)).status).toBe(200);
    } finally {
      await signOut(page);
      await signIn(page, 'superAdmin');
      await removeDeal(page, id);
    }
  });

  test('ANOTHER ROLE IS UNAFFECTED, so the brokerage can still manage documents', async ({ page }) => {
    /*
     * The counterweight to the test above. A guard that over-reached would stop the brokerage
     * managing documents at all — a worse outcome than the gap it closed. The write is sent with
     * the documents exactly as they already are, so it is authorised-and-harmless rather than a
     * change this test would have to undo.
     */
    await signIn(page, 'superAdmin');
    const id = await createDeal(page);
    try {
      const read = await apiGet(page, `/api/transactions/${id}/documents`);
      expect(read.status).toBe(200);
      const current = ((read.body as { documents?: unknown[] }).documents ?? []) as unknown[];
      expect((await apiSend(page, 'PUT', `/api/transactions/${id}/documents`, { documents: current })).status)
        .not.toBe(403);
    } finally {
      await removeDeal(page, id);
    }
  });
});

// =====================================================================================
test.describe('the authorized Documentation workflows still work', () => {
  /*
   * THE COUNTERWEIGHT TO THE GUARD, and the thing most at risk from it.
   *
   * This role is read-only on these panels, which is not the same as powerless: it may ASK a Super
   * Admin to change the commission, and to change whether a document is Mandatory. Both go to
   * `/api/transactions/:id/edit-requests` on the workflows controller — a different controller from
   * the documents one the guard is attached to — and both must keep working. If a future change
   * moves either onto the documents controller, or widens the guard, these fail.
   */
  test('CAN STILL RAISE A COMMISSION CHANGE REQUEST — asking is not editing', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const id = await createDeal(page);
    try {
      await signOut(page);
      await signIn(page, 'docs');

      const res = await apiSend(page, 'POST', `/api/transactions/${id}/edit-requests`, {
        reason: 'ZZ-DOCVIEW commission proposal',
        scope: 'commission',
        proposed: { comm_value: 2.75 },
      });
      // Accepted, or refused for a reason about the PROPOSAL rather than about permission.
      // What must never happen is 403: that would mean the role lost its authorized route.
      expect(res.status).not.toBe(403);
    } finally {
      await signOut(page);
      await signIn(page, 'superAdmin');
      await removeDeal(page, id);
    }
  });

  test('CAN STILL RAISE A MANDATORY DOCUMENT-FLAG REQUEST, which the documents guard must not catch', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const id = await createDeal(page);
    try {
      await signOut(page);
      await signIn(page, 'docs');

      const res = await apiSend(page, 'POST', `/api/transactions/${id}/edit-requests`, {
        reason: 'ZZ-DOCVIEW mandatory flag',
        scope: 'mandatory',
      });
      expect(res.status).not.toBe(403);
    } finally {
      await signOut(page);
      await signIn(page, 'superAdmin');
      await removeDeal(page, id);
    }
  });

  test('CAN STILL DOWNLOAD — reading the paperwork is the job, and the guard allows every GET', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const id = await createDeal(page);
    try {
      await signOut(page);
      await signIn(page, 'docs');

      // Not asserted as 200: a fresh deal may carry no uploaded file, and "nothing to download"
      // is a 404. The property under test is that it is not FORBIDDEN.
      const all = await apiGet(page, `/api/transactions/${id}/documents/download-all`);
      expect(all.status).not.toBe(403);
    } finally {
      await signOut(page);
      await signIn(page, 'superAdmin');
      await removeDeal(page, id);
    }
  });
});

// =====================================================================================
test.describe('each Quick Action reads as a record, not as a stuck form', () => {
  let dealId = 0;

  test.beforeEach(async ({ page }) => {
    await signIn(page, 'superAdmin');
    dealId = await createDeal(page);
    await signOut(page);
    await signIn(page, 'docs');
    await page.goto(`/desk/transactions/${dealId}`);
    await expect(page.getByRole('button', { name: /^Back$/ })).toBeVisible({ timeout: 20_000 });
  });

  test.afterEach(async ({ page }) => {
    await signOut(page);
    await signIn(page, 'superAdmin');
    await removeDeal(page, dealId);
  });

  test('THE BLUE "View" BAR IS GONE from Team Split for this role', async ({ page }) => {
    const modal = await openQuickAction(page, /Team Split/i);
    test.skip(!modal, 'Team Split is not offered on this deal');
    await expect(page.getByTestId('team-readonly-banner')).toHaveCount(0);
  });

  test('TEAM SPLIT SHOWS ITS STATUS AS TEXT, with nothing left enabled', async ({ page }) => {
    const modal = await openQuickAction(page, /Team Split/i);
    test.skip(!modal, 'Team Split is not offered on this deal');

    // The control the defect was reported on: present, showing the answer, not changeable.
    await expect(modal!.locator('select').first()).toBeDisabled();
    // The class is what turns a greyed dropdown into text.
    await expect(modal!).toHaveClass(/view-flat/);
    expect(await editableCount(modal!)).toBe(0);
  });

  for (const [name, label] of [
    ['Documents', /^Documents$/i],
    ['Admin', /^Admin$/i],
    ['Financial', /^Financial$/i],
    ['Adjustment', /^Adjustment$/i],
    ['Agent Payment Readiness', /Agent Payment Readiness/i],
  ] as const) {
    test(`${name} IS STRICTLY READ-ONLY — no control accepts input`, async ({ page }) => {
      /*
       * Asserted as an absence rather than field by field. A list of named fields goes stale the
       * moment somebody adds one; "nothing in here accepts input" keeps being true, and is the
       * requirement as stated.
       */
      const modal = await openQuickAction(page, label);
      test.skip(!modal, `${name} is not offered to this role on this deal`);

      expect(await editableCount(modal!)).toBe(0);

      // Close still works — read-only navigation is explicitly not supposed to change.
      await modal!.locator('.close').first().click();
      await expect(page.locator('.modal')).toHaveCount(0, { timeout: 10_000 });
    });
  }

  test('AUDIT TRAIL KEEPS ITS FILTER AND SEARCH, which are navigation and not modification', async ({ page }) => {
    /*
     * AUDIT TRAIL IS DELIBERATELY NOT IN THE LOOP ABOVE, and this test is why.
     *
     * It holds two enabled controls — a section filter and a search box — and the blanket
     * "nothing accepts input" assertion failed on them. The assertion was wrong, not the screen:
     * both only narrow what is DISPLAYED from a log this role is allowed to read, neither sends
     * anything, and the requirement says in terms to keep read-only navigation working. Flattening
     * them would turn a usable trail into an unfilterable wall of rows.
     *
     * `view-flat` leaves them alone by construction, because every rule in it is scoped to
     * `:disabled` and these are not disabled. What this asserts instead is the thing that would
     * actually matter: the panel offers no way to WRITE.
     */
    const modal = await openQuickAction(page, /Audit Trail/i);
    test.skip(!modal, 'Audit Trail is not offered to this role on this deal');

    await expect(modal!.locator('select').first()).toBeEnabled();
    await expect(modal!.getByPlaceholder(/Search field, user, value/i)).toBeEnabled();

    // Searching narrows the list rather than being refused.
    await modal!.getByPlaceholder(/Search field, user, value/i).fill('zzzz-no-such-entry');
    await expect(modal!.getByText(/0 of \d+/)).toBeVisible();

    // And there is nothing here that saves, submits or approves.
    const writeButtons = await modal!.getByRole('button', { name: /save|submit|approve|reject|request|delete|remove|add/i }).count();
    expect(writeButtons).toBe(0);
  });
});

// =====================================================================================
test.describe('other roles keep the screens they had', () => {
  test('A SUPER ADMIN\'S TEAM SPLIT IS STILL EDITABLE, and carries no flattening class', async ({ page }) => {
    /*
     * THE GUARD AGAINST OVER-REACH, and the test that would catch a CSS rule written without the
     * `.view-flat` scope. Making one role read-only by making the screen read-only for everybody
     * is not the change that was asked for.
     */
    await signIn(page, 'superAdmin');
    const id = await createDeal(page);
    try {
      await page.goto(`/desk/transactions/${id}?mode=edit`);
      await expect(page.getByRole('button', { name: /^Back$/ })).toBeVisible({ timeout: 20_000 });

      const modal = await openQuickAction(page, /Team Split/i);
      test.skip(!modal, 'Team Split is not offered on this deal');

      await expect(modal!).not.toHaveClass(/view-flat/);
      expect(await editableCount(modal!)).toBeGreaterThan(0);
    } finally {
      await removeDeal(page, id);
    }
  });

  test('AN AGENT IN VIEW ONLY STILL SEES THE "View" BAR, because their panel is still a disabled form', async ({ page }) => {
    // The bar was removed for Documentation alone. For a role whose controls are still rendered as
    // controls it is doing its original job, and `team-split-view-only.spec.ts` relies on it.
    await signIn(page, 'superAdmin');
    const id = await createDeal(page);
    try {
      await signOut(page);
      await signIn(page, 'agent');
      await page.goto(`/desk/transactions/${id}?mode=view`);
      await expect(page.getByRole('button', { name: /^Back$/ })).toBeVisible({ timeout: 20_000 });

      const modal = await openQuickAction(page, /Team Split/i);
      test.skip(!modal, 'Team Split is not offered to this agent on this deal');

      await expect(modal!).not.toHaveClass(/view-flat/);
      await expect(page.getByTestId('team-readonly-banner')).toBeVisible();
    } finally {
      await signOut(page);
      await signIn(page, 'superAdmin');
      await removeDeal(page, id);
    }
  });
});
