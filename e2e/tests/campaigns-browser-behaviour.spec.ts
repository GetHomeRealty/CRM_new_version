import { test, expect, type Page } from '@playwright/test';
import { signIn, apiGet, apiSend } from './helpers';

/**
 * THE CAMPAIGN BUILDER, DRIVEN THROUGH THE BROWSER.
 *
 * ================================================================================================
 * WHY THIS FILE EXISTS. `campaigns.spec.ts` carries forty tests and almost all of them are
 * API-level: endpoint authorization, CSRF, the tracking pixel, unsubscribe, audience scoping. It
 * never opens the builder — "Create Campaign" does not appear anywhere in it — and across the whole
 * suite the campaign screens have zero `reload`, zero `goBack` and zero double-click coverage.
 *
 * That matters more here than on most screens, because a campaign is the one CRM action that is
 * IRREVERSIBLE AND FAN-OUT: a lead saved twice is untidy, a campaign sent twice reaches every
 * recipient twice, from their point of view for no reason. So the interesting questions are about
 * the moment of commitment — what a second click does, what a refresh mid-build does, what an
 * expired session does when the button is finally pressed.
 * ================================================================================================
 *
 * SCHEDULING RATHER THAN SENDING, WHEREVER THE TEST ALLOWS. "Send later" exercises the same builder,
 * the same audience resolution and the same commit path, and leaves a row in a known state without
 * dispatching to anybody. Mail is redirected to a sink in this environment (see `playwright.config`),
 * so a real send is safe — but it is also slow and noisy, and a test that does not need one should
 * not do one.
 */

const unique = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const created: number[] = [];

test.afterAll(async ({ browser }) => {
  if (!created.length) return;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await signIn(page, 'superAdmin');
    for (const id of created) await apiSend(page, 'DELETE', `/api/campaigns/${id}`);
  } finally { await ctx.close(); }
});

/** Every campaign the signed-in caller can see. */
async function listCampaigns(page: Page): Promise<{ id: number; name: string; status: string }[]> {
  const res = await apiGet(page, '/api/campaigns');
  const body = res.body as { data?: unknown[] } | unknown[];
  const rows = (Array.isArray(body) ? body : body.data ?? []) as { id: number; name: string; status: string }[];
  return rows;
}

async function findByName(page: Page, name: string) {
  return (await listCampaigns(page)).filter((c) => c.name === name);
}

async function openBuilder(page: Page) {
  await page.goto('/crm/campaigns');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: '+ Create Campaign' }).first().click();
  /*
   * The MODAL, not the words. `getByText('Create Campaign')` matches three things on this page —
   * the two "+ Create Campaign" buttons and the modal's own heading — and Playwright's strict mode
   * rejects the ambiguity rather than guessing. Asserting on the dialog is also what the test
   * actually means.
   */
  await expect(builder(page)).toBeVisible();
}

const builder = (page: Page) => page.locator('.modal').filter({ hasText: 'Create Campaign' }).first();

/**
 * Fill the two fields a campaign cannot go without, and wait for the audience to resolve.
 *
 * The recipient count is fetched from the server as the segment changes, and the commit button is
 * disabled while it is zero — so a test that types a name and clicks immediately is racing the
 * audience lookup, not testing anything.
 */
async function fillBuilder(page: Page, name: string): Promise<number> {
  const b = builder(page);
  await b.locator('input').first().fill(name);

  // The template select is the one offering "Choose a template to send".
  const template = b.locator('select').filter({ hasText: 'Choose a template to send' }).first();
  const options = await template.locator('option').evaluateAll(
    (o) => o.map((x) => (x as HTMLOptionElement).value).filter((v) => v !== ''),
  );
  expect(options.length, 'the brokerage needs at least one campaign template for this suite').toBeGreaterThan(0);
  await template.selectOption(options[0]);

  // No segment filters: the whole of the caller's own book.
  await expect(b.locator('.camp-audience')).toBeVisible();
  await expect.poll(async () => {
    const txt = await b.locator('.camp-audience').innerText();
    return Number(/(\d+)\s+recipient/.exec(txt)?.[1] ?? 0);
  }, { timeout: 15_000 }).toBeGreaterThan(0);

  /*
   * ARM THE UNFILTERED AUDIENCE, which is now a deliberate act rather than the opening state.
   *
   * These tests send to the whole of the caller's own book, and until CRM-011 that needed no
   * choosing: the composer opened with every filter at "any", the count showing the entire lead
   * table and the commit button already live. That was the defect - one careless click from mailing
   * the database - so an unfiltered send now asks first. Narrowing any axis would arm it too; these
   * tests want everybody, so they tick the box, exactly as a person would.
   */
  const everyone = b.getByRole('checkbox');
  if (await everyone.count()) await everyone.first().check();

  const txt = await b.locator('.camp-audience').innerText();
  return Number(/(\d+)\s+recipient/.exec(txt)?.[1] ?? 0);
}

/** Switch the builder to "Send later" and set a time comfortably in the future. */
async function scheduleFor(page: Page, daysAhead = 3) {
  const b = builder(page);
  /*
   * The RADIO, not its label. Clicking the label text timed out — the label is a flex container
   * holding the input and the words, and Playwright could not find a stable actionable point on it.
   * The two radios are "Send now" and "Send later" in that order, so the second is the one wanted;
   * `check()` is correct here because a radio genuinely does flip on click, unlike the controlled
   * settings toggles elsewhere in this suite.
   */
  await b.locator('input[type="radio"]').nth(1).check();
  const when = new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 16);
  await b.locator('input[type="datetime-local"]').fill(when);
}

const commitButton = (page: Page) =>
  builder(page).getByRole('button', { name: /^(Send to|Schedule for)\s+\d+/ });

/** The send confirmation, which now stands between the commit button and the campaign. */
const confirmDialog = (page: Page) =>
  page.locator('.modal').filter({ hasText: /Send this campaign\?|Schedule this campaign\?/ });

const confirmButton = (page: Page) =>
  confirmDialog(page).getByRole('button', { name: /^Confirm (Send|schedule)$/ });

/**
 * Commit the campaign: press the button, then confirm.
 *
 * COMMITTING IS TWO STEPS NOW. Sending used to happen on the one click these tests made; a
 * confirmation naming the count, the audience, the sender and the subject was added because
 * mailing clients was the last irreversible act in this module that never asked. The tests keep
 * doing what a person does, which is now one more press.
 */
async function commit(page: Page): Promise<void> {
  await commitButton(page).click();
  await confirmButton(page).click();
}

// ================================================================ create

test.describe('creating a campaign', () => {
  test('the builder opens, resolves an audience, and schedules a campaign that persists', async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, 'agent');
    await openBuilder(page);

    const name = unique('Scheduled');
    const count = await fillBuilder(page, name);
    expect(count).toBeGreaterThan(0);

    await scheduleFor(page);
    await commit(page);
    await expect(builder(page)).toBeHidden({ timeout: 30_000 });

    const rows = await findByName(page, name);
    expect(rows, 'exactly one campaign should exist').toHaveLength(1);
    expect(rows[0].status).toBe('scheduled');
    created.push(rows[0].id);

    // And it is still there, still scheduled, after a full reload.
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(name, { exact: false }).first()).toBeVisible();
    expect((await findByName(page, name))[0].status).toBe('scheduled');
  });

  test('the commit button stays disabled until a name, a template and an audience all exist', async ({ page }) => {
    await signIn(page, 'agent');
    await openBuilder(page);

    // Nothing chosen yet: there is no audience, so there is nothing to send to.
    await expect(commitButton(page)).toBeDisabled();

    await builder(page).locator('input').first().fill(unique('Incomplete'));
    // A name alone is not enough — no template has been chosen.
    await expect(commitButton(page)).toBeDisabled();
  });

  test('cancelling the builder creates nothing', async ({ page }) => {
    await signIn(page, 'agent');
    await openBuilder(page);

    const name = unique('Abandoned');
    await fillBuilder(page, name);
    await builder(page).getByRole('button', { name: 'Cancel' }).first().click();

    await expect(builder(page)).toBeHidden();
    expect(await findByName(page, name)).toHaveLength(0);
  });

  test('a refresh mid-build discards the draft rather than half-creating it', async ({ page }) => {
    await signIn(page, 'agent');
    await openBuilder(page);

    const name = unique('DraftLost');
    await fillBuilder(page, name);
    await page.reload();
    await page.waitForLoadState('networkidle');

    await expect(builder(page)).toBeHidden();
    expect(await findByName(page, name)).toHaveLength(0);
  });
});

// ================================================================ the moment of commitment

test.describe('pressing the commit button twice', () => {
  /**
   * THE ONE THAT WOULD HURT. A campaign is fan-out and irreversible: a second commit is a second
   * message to every recipient. Unlike a lead there is no unique index to catch it, so whatever
   * prevents this is in the application — which is exactly why it is worth an explicit test.
   */
  test('double-clicking Schedule creates one campaign, not two', async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, 'agent');
    await openBuilder(page);

    const name = unique('DoubleCommit');
    await fillBuilder(page, name);
    await scheduleFor(page);

    /*
     * THE DOUBLE CLICK MOVED WITH THE COMMIT. Double-clicking the button now only opens the
     * confirmation twice, which is harmless and proves nothing; the press that can create a
     * campaign is the confirm, so that is the one to hit twice.
     */
    await commitButton(page).click();
    await confirmButton(page).dblclick({ delay: 0 });
    await expect(builder(page)).toBeHidden({ timeout: 30_000 });

    const rows = await findByName(page, name);
    expect(rows, 'a second click must not produce a second campaign').toHaveLength(1);
    created.push(rows[0].id);
  });
});

// ================================================================ state, reload, navigation

test.describe('campaign state and navigation', () => {
  test('a scheduled campaign can be cancelled, and the new state survives a reload', async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, 'agent');
    await openBuilder(page);

    const name = unique('ToCancel');
    await fillBuilder(page, name);
    await scheduleFor(page);
    await commit(page);
    await expect(builder(page)).toBeHidden({ timeout: 30_000 });

    const rows = await findByName(page, name);
    const id = rows[0].id;
    created.push(id);
    expect(rows[0].status).toBe('scheduled');

    // Cancel it through the API the screen uses, then confirm the screen agrees after a reload.
    const cancel = await apiSend(page, 'POST', `/api/campaigns/${id}/cancel`, {});
    expect([200, 201, 204]).toContain(cancel.status);

    await page.reload();
    await page.waitForLoadState('networkidle');
    const after = (await listCampaigns(page)).find((c) => c.id === id)!;
    expect(after.status).not.toBe('scheduled');
  });

  test('the back button returns to the campaign list in a working state', async ({ page }) => {
    await signIn(page, 'agent');
    await page.goto('/crm/campaigns');
    await page.waitForLoadState('networkidle');

    await page.goto('/crm/lead');
    await page.waitForLoadState('networkidle');
    await page.goBack();
    await page.waitForLoadState('networkidle');

    await expect(page).toHaveURL(/\/crm\/campaigns/);
    await expect(page.getByRole('button', { name: '+ Create Campaign' }).first()).toBeVisible();
  });
});

// ================================================================ sessions and stale tabs

test.describe('sessions and stale tabs', () => {
  test('committing from a tab whose session has expired creates nothing', async ({ page, context, browser }) => {
    test.setTimeout(120_000);
    await signIn(page, 'agent');
    await openBuilder(page);

    const name = unique('ExpiredCommit');
    await fillBuilder(page, name);
    await scheduleFor(page);

    // The session ends while the builder is open.
    await context.clearCookies();
    await commit(page);
    await page.waitForTimeout(2000);

    const check = await browser.newContext();
    const p = await check.newPage();
    try {
      await signIn(p, 'agent');
      expect(await findByName(p, name), 'an expired session must not be able to schedule a campaign').toHaveLength(0);
    } finally { await check.close(); }
  });

  test('a stale tab cannot act on a campaign that was deleted elsewhere', async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await browser.newContext();
    const tabA = await ctx.newPage();
    const tabB = await ctx.newPage();

    try {
      await signIn(tabA, 'agent');
      await openBuilder(tabA);
      const name = unique('DeletedElsewhere');
      await fillBuilder(tabA, name);
      await scheduleFor(tabA);
      await commit(tabA);
      await expect(builder(tabA)).toBeHidden({ timeout: 30_000 });

      const id = (await findByName(tabA, name))[0].id;

      // Removed in the other tab.
      await tabB.goto('/crm/campaigns');
      await tabB.waitForLoadState('networkidle');
      const del = await apiSend(tabB, 'DELETE', `/api/campaigns/${id}`);
      expect([200, 204]).toContain(del.status);

      // The first tab still shows it and acts on it.
      const stale = await apiSend(tabA, 'POST', `/api/campaigns/${id}/cancel`, {});
      expect(stale.status, 'a deleted campaign must not accept an action').toBe(404);
    } finally { await ctx.close(); }
  });

  /**
   * Campaign history is scoped to its owner — proven at the API in `campaigns.spec.ts`. What is
   * checked here is the pair of screens: two people working at once must not see each other's work
   * appear in their own list.
   */
  test('two agents working at once do not see each other’s campaigns', async ({ browser }) => {
    test.setTimeout(120_000);
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();

    try {
      await signIn(a, 'agent');
      await signIn(b, 'agent2');

      await openBuilder(a);
      const name = unique('AgentAOnly');
      await fillBuilder(a, name);
      await scheduleFor(a);
      await commit(a);
      await expect(builder(a)).toBeHidden({ timeout: 30_000 });

      const mine = await findByName(a, name);
      expect(mine).toHaveLength(1);
      created.push(mine[0].id);

      // B refreshes and must not see it, on screen or through the API.
      await b.goto('/crm/campaigns');
      await b.waitForLoadState('networkidle');
      expect(await findByName(b, name)).toHaveLength(0);
      await expect(b.getByText(name, { exact: false })).toHaveCount(0);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
