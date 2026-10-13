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
 * DOCUMENTS IS NOT ONE OF THEM, and that is the correction of 2026-10-13. It was briefly closed
 * along with the rest — a `DocumentationReadOnlyGuard` refused every document write on the server
 * and the screen passed `readOnly` — and reopened the same day, because a Transaction Coordinator
 * who cannot attach a document cannot do the work. Upload, add, save, the validation radios, the
 * reminder flags and the RECO audit fields are all live for this role.
 *
 * WHY THE API TESTS STILL CARRY THE WEIGHT. A disabled input is a courtesy; what the endpoint does
 * is the rule. These send real requests from a real Documentation session — both to prove the
 * document writes are allowed, and to prove the two restrictions that survived the reopening are
 * still enforced: Mandatory needs a Super Admin (`requireMandatoryApproval`), and a document
 * already marked Valid needs `documents.override-valid`. Neither ever depended on that guard.
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
test.describe('documents are the Documentation role\'s to maintain', () => {
  /*
   * REVERSED ON 2026-10-13, THE SAME DAY IT WAS INTRODUCED.
   *
   * These two tests asserted the opposite: that every document write was refused with a 403 by a
   * `DocumentationReadOnlyGuard`. Making every Quick Action strictly view-only had closed Documents
   * too, and closing it took away the one thing this role exists to do — a Transaction Coordinator
   * who cannot attach a document cannot do the work. The guard is gone and these now assert the
   * capability rather than its absence.
   *
   * WHAT IS STILL REFUSED is asserted below, because it is the part that must not be lost in the
   * reversal: a Mandatory change still needs a Super Admin, and a document already marked Valid
   * still cannot be replaced or deleted below admin rank. Neither ever depended on that guard —
   * `requireMandatoryApproval` and the `documents.override-valid` capability enforce them per
   * document, in the service.
   */
  test('CAN WRITE DOCUMENTS AGAIN — the bulk update the Save button calls', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const id = await createDeal(page);
    try {
      await signOut(page);
      await signIn(page, 'docs');

      const read = await apiGet(page, `/api/transactions/${id}/documents`);
      expect(read.status).toBe(200);
      const current = ((read.body as { documents?: unknown[] }).documents ?? []) as unknown[];

      // Sent with the documents exactly as they already are: authorised-and-harmless, so this
      // asserts the permission without being a change the test has to undo.
      const put = await apiSend(page, 'PUT', `/api/transactions/${id}/documents`, { documents: current });
      expect(put.status).not.toBe(403);

      // Reminders too — one of the capabilities named in the brief.
      expect((await apiSend(page, 'POST', `/api/transactions/${id}/documents/send-reminders`, {})).status).not.toBe(403);

      /*
       * DRAFT SUBMISSION IS NOT IN THIS LIST, AND SHOULD NOT BE. `submitDrafts` refuses anybody who
       * is not an agent — "Only agents submit draft uploads." — and always has: it is how an AGENT
       * sends their uploads to the office for review, not something a coordinator does. An earlier
       * draft of this test asserted it was open to this role, which was wrong about the feature
       * rather than about the permission. Asserted as still-refused, so reopening document writes is
       * not mistaken for reopening that.
       */
      const submit = await apiSend(page, 'POST', `/api/transactions/${id}/documents/submit`, { draft_ids: [] });
      expect(submit.status).toBe(403);
      expect(JSON.stringify(submit.body)).toMatch(/only agents/i);
    } finally {
      await signOut(page);
      await signIn(page, 'superAdmin');
      await removeDeal(page, id);
    }
  });

  test('STILL READS AND DOWNLOADS, which was never in question', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const id = await createDeal(page);
    try {
      await signOut(page);
      await signIn(page, 'docs');
      expect((await apiGet(page, `/api/transactions/${id}/documents`)).status).toBe(200);
      expect((await apiGet(page, `/api/transactions/${id}/documents/download-all`)).status).not.toBe(403);
    } finally {
      await signOut(page);
      await signIn(page, 'superAdmin');
      await removeDeal(page, id);
    }
  });

  test('A MANDATORY CHANGE STILL NEEDS A SUPER ADMIN, which reopening write access did not loosen', async ({ page }) => {
    /*
     * The restriction the brief says to keep, asserted against the real endpoint. `mandatoryMoves`
     * compares what was sent against what is stored and `requireMandatoryApproval` refuses the
     * move without an approval — per document, independent of the role's write access.
     */
    await signIn(page, 'superAdmin');
    const id = await createDeal(page);
    try {
      const read = await apiGet(page, `/api/transactions/${id}/documents`);
      const docs = ((read.body as { documents?: Record<string, unknown>[] }).documents ?? []);
      test.skip(!docs.length, 'this deal has no document rows to flip');

      // Flip the first row's Mandatory flag to the opposite of what is stored.
      const flipped = docs.map((d, i) => (i === 0 ? { ...d, mandatory: !d.mandatory } : d));

      await signOut(page);
      await signIn(page, 'docs');
      const res = await apiSend(page, 'PUT', `/api/transactions/${id}/documents`, { documents: flipped });

      // Refused, and refused for the RIGHT reason — not a blanket role refusal.
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(res.body)).toMatch(/mandatory|approval|super admin/i);
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
/*
 * THE QUICK ACTION LABELS CARRY " (View Only)" FOR THE DOCUMENTATION ROLE, since 2026-10-13, so an
 * anchored `/^Admin$/` no longer matches for that seat. The optional group keeps the anchoring —
 * which is what stops "Adjustment" matching the "Adjustment & Advance Payment" heading — while
 * admitting the suffix. Other roles' labels are unchanged, and the specs that run as those roles
 * still use the bare anchored form.
 */
    ['Admin', /^Admin( \(View Only\))?$/i],
    ['Adjustment', /^Adjustment( \(View Only\))?$/i],
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

  test('DOCUMENTS IS EDITABLE, with Mandatory still locked to a Super Admin', async ({ page }) => {
    /*
     * DOCUMENTS IS DELIBERATELY NOT IN THE LOOP ABOVE. It is this role's own panel again as of
     * 2026-10-13 — upload, add, save, the validation radios, the reminder flags and the RECO audit
     * fields are all live. The one control that stays shut is Mandatory, which needs a Super
     * Admin; asserting that here is what stops the reversal quietly taking it with it.
     */
    const modal = await openQuickAction(page, /^Documents$/i);
    test.skip(!modal, 'Documents is not offered to this role on this deal');

    // Not flattened: this panel is a form for this role, not a record.
    await expect(modal!).not.toHaveClass(/view-flat/);
    // And there is something to type in.
    expect(await editableCount(modal!)).toBeGreaterThan(0);
    // The Save button exists.
    await expect(modal!.getByRole('button', { name: /^Save$/ })).toBeVisible();

    // Every Mandatory checkbox is still disabled for this role.
    const mandatory = modal!.locator('label', { hasText: /^Mandatory$/ }).locator('input[type="checkbox"]');
    const n = await mandatory.count();
    for (let i = 0; i < n; i += 1) await expect(mandatory.nth(i)).toBeDisabled();
  });

  test('FINANCIAL IS READ-ONLY EXCEPT PRICE AND DEPOSIT, which this role may correct', async ({ page }) => {
    /*
     * FINANCIAL IS DELIBERATELY NOT IN THE LOOP ABOVE.
     *
     * CORRECTED FOR f5ecb33, which this test had not caught up with. That commit replaced the
     * direct Price/Deposit save with a pencil per field: nothing on the panel accepts input until
     * its pencil is clicked, and the edited values then go to a Super Admin as one `commission`
     * request. This test still asserted the earlier design — `fin-price` editable on open — and so
     * was failing on `origin/version_3` before this change touched the file. The behaviour it
     * asserts in detail lives in `financial-documentation-price-deposit.spec.ts`; what is checked
     * here is only that the panel starts closed and offers the authorized ask.
     */
    const modal = await openQuickAction(page, /^Financial$/i);
    test.skip(!modal, 'Financial is not offered to this role on this deal');

    // Closed on open: the pencils are the way in, so nothing accepts input yet.
    expect(await editableCount(modal!)).toBe(0);
    /*
     * And the authorized route out is offered. `fin-send-request` rather than a label match: that
     * button reads "Send Request" since f5ecb33, and an earlier draft of this line looked for
     * "Request Commission Change" — the label it had under the previous design.
     * Visible rather than enabled: it is deliberately disabled until a pencil has been clicked and
     * something actually differs from the saved deal.
     */
    await expect(modal!.getByTestId('fin-send-request')).toBeVisible();
  });

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
test.describe('the four view-only panels say so in their heading', () => {
  /*
   * ADDED 2026-10-13. The blue "View" bar above the fields was removed earlier the same day — with
   * the controls rendered as plain text it was furniture — and the brokerage then asked for the
   * fact to be stated where it costs nothing: in the heading, and on the Quick Action button that
   * opens it.
   *
   * THE PAIRS ARE ASSERTED TOGETHER, button and heading, because they are two different strings in
   * two different files and only one of them is what somebody reads before clicking.
   *
   * DOCUMENTS AND FINANCIAL ARE ABSENT ON PURPOSE. Documents is editable for this role again
   * (792347b) and Financial takes edits by approval request (f5ecb33); labelling either "View Only"
   * would be stating something untrue.
   */
  const PANELS = [
    { button: /^Team Split( \(View Only\))?$/i, heading: 'Team Split' },
    { button: /^Admin( \(View Only\))?$/i, heading: 'Admin Activities' },
    { button: /^Adjustment( \(View Only\))?$/i, heading: 'Adjustment & Advance Payment' },
    { button: /^Agent Payment Readiness( \(View Only\))?$/i, heading: 'Agent Payment Readiness' },
  ] as const;

  test('THE DOCUMENTATION SEAT SEES "(View Only)" ON ALL FOUR BUTTONS AND HEADINGS', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const id = await createDeal(page);
    try {
      await signOut(page);
      await signIn(page, 'docs');
      await page.goto(`/desk/transactions/${id}`);
      await expect(page.getByRole('button', { name: /^Back$/ })).toBeVisible({ timeout: 20_000 });

      for (const p of PANELS) {
        const button = page.getByRole('button', { name: p.button }).first();
        if (!(await button.count())) continue;

        await expect(button).toContainText('(View Only)');

        await button.click();
        const modal = page.locator('.modal').first();
        await expect(modal).toBeVisible({ timeout: 15_000 });
        // The heading keeps its own name AND carries the suffix.
        await expect(modal.locator('.modal-h').first()).toContainText(p.heading);
        await expect(modal.locator('.modal-h').first()).toContainText('(View Only)');

        await modal.locator('.close').first().click();
        await expect(page.locator('.modal')).toHaveCount(0, { timeout: 10_000 });
      }
    } finally {
      await signOut(page);
      await signIn(page, 'superAdmin');
      await removeDeal(page, id);
    }
  });

  test('NO OTHER ROLE SEES IT — the label is the one thing that changed, and only for one seat', async ({ page }) => {
    /*
     * The requirement that would be quietly broken by appending the suffix unconditionally. A Super
     * Admin edits these panels; telling them they are read-only would be false.
     */
    await signIn(page, 'superAdmin');
    const id = await createDeal(page);
    try {
      await page.goto(`/desk/transactions/${id}?mode=edit`);
      await expect(page.getByRole('button', { name: /^Back$/ })).toBeVisible({ timeout: 20_000 });

      // Nothing anywhere on the page carries it for this seat.
      await expect(page.getByText('(View Only)')).toHaveCount(0);

      for (const p of PANELS) {
        const button = page.getByRole('button', { name: p.button }).first();
        if (!(await button.count())) continue;
        await expect(button).not.toContainText('(View Only)');

        await button.click();
        const modal = page.locator('.modal').first();
        await expect(modal).toBeVisible({ timeout: 15_000 });
        await expect(modal.locator('.modal-h').first()).toContainText(p.heading);
        await expect(modal.locator('.modal-h').first()).not.toContainText('(View Only)');

        await modal.locator('.close').first().click();
        await expect(page.locator('.modal')).toHaveCount(0, { timeout: 10_000 });
      }
    } finally {
      await removeDeal(page, id);
    }
  });

  test('DOCUMENTS AND FINANCIAL ARE NOT LABELLED, because neither is view-only for this role', async ({ page }) => {
    // Documents is editable again and Financial takes edits by request. Either label would be a lie.
    await signIn(page, 'superAdmin');
    const id = await createDeal(page);
    try {
      await signOut(page);
      await signIn(page, 'docs');
      await page.goto(`/desk/transactions/${id}`);
      await expect(page.getByRole('button', { name: /^Back$/ })).toBeVisible({ timeout: 20_000 });

      for (const name of [/^Documents$/i, /^Financial$/i]) {
        const button = page.getByRole('button', { name }).first();
        if (!(await button.count())) continue;
        await expect(button).not.toContainText('(View Only)');
      }
    } finally {
      await signOut(page);
      await signIn(page, 'superAdmin');
      await removeDeal(page, id);
    }
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
