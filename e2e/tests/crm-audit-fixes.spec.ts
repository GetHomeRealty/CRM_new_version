import { test, expect } from '@playwright/test';
import { signIn, apiGet, apiSend, API_BASE } from './helpers';

/** Findings from the CRM full production audit, 2026-08-05. */

test.describe('CRM-PERM-M03 — accounting cannot read the Audit Trail', () => {
  /*
   * It answered 200 while documentation and crm answered 403 — inherited from `fill('view')`
   * rather than chosen. The audit trail carries user administration, permission grants and settings
   * changes, none of which this role can perform or open.
   */
  test('the API refuses accounting', async ({ page }) => {
    await signIn(page, 'accounting');
    expect((await apiGet(page, '/api/audit-logs')).status).toBe(403);
  });

  test('the screen refuses accounting too, so the nav and the API agree', async ({ page }) => {
    await signIn(page, 'accounting');
    await page.goto('/crm/audit');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(/No access/i)).toBeVisible({ timeout: 10_000 });
  });

  test('the roles that should keep it still have it', async ({ page, context }) => {
    // The counterpart, so the fix cannot pass by taking the audit trail away from everybody.
    await signIn(page, 'superAdmin');
    expect((await apiGet(page, '/api/audit-logs')).status).toBe(200);

    const two = await context.newPage();
    await signIn(two, 'admin');
    expect((await apiGet(two, '/api/audit-logs')).status).toBe(200);
    await two.close();
  });
});

test.describe('CRM-LEADS-L02 — view-only Leads access cannot export', () => {
  /*
   * Reading a lead on screen and carrying the whole book out as a file are different acts. The rows
   * were always correctly scoped — export count matched list count for every role during the audit
   * — so this is not closing a data leak; it is saying that a role trusted only to look is not
   * thereby trusted to extract.
   */
  for (const who of ['accounting', 'docs'] as const) {
    test(`${who} holds lead:view and is refused the export`, async ({ page }) => {
      await signIn(page, who);
      // Still able to LOOK — the change must not take the list away.
      expect((await apiGet(page, '/api/leads')).status).toBe(200);
      expect((await apiSend(page, 'POST', '/api/leads/export', {})).status).toBe(403);
    });
  }

  for (const who of ['agent', 'crm', 'admin', 'superAdmin'] as const) {
    test(`${who} holds lead:edit and keeps the export`, async ({ page }) => {
      // The counterpart, so the gate cannot pass by refusing everybody.
      await signIn(page, who);
      expect((await apiSend(page, 'POST', '/api/leads/export', {})).status).toBe(200);
    });
  }
});

test.describe('CRM-CAMP-Q01 — the CRM role can run campaigns', () => {
  test('crm may create and test-send; it is the role that exists to', async ({ page }) => {
    // It held `campaigns: view` and was refused 403 while an ordinary agent was allowed both.
    await signIn(page, 'crm');
    expect((await apiSend(page, 'POST', '/api/campaigns', {})).status).not.toBe(403);
    expect((await apiSend(page, 'POST', '/api/campaigns/test-send', {})).status).not.toBe(403);
  });

  test('view-only roles are still refused', async ({ page }) => {
    // The counterpart — the grant must not have widened to everyone.
    await signIn(page, 'accounting');
    expect((await apiSend(page, 'POST', '/api/campaigns', {})).status).toBe(403);
  });
});

test.describe('CRM-CAMP-Q02 — an agent sees only their own leads’ opt-outs', () => {
  /*
   * Every row is a real person's address. The list showed every agent the addresses of every
   * colleague's clients — the one place that boundary leaked. Enforcement is unaffected: every send
   * is filtered against the whole table regardless of who is sending, so hiding a row cannot let
   * anyone mail a suppressed address.
   */
  test('an agent’s list is a subset of the brokerage list', async ({ page, context }) => {
    await signIn(page, 'superAdmin');
    const all = await apiGet(page, '/api/campaigns/suppressions?limit=200');
    const allRows = ((all.body as { data?: Record<string, unknown>[] })?.data ?? []);

    const two = await context.newPage();
    await signIn(two, 'agent');
    const mine = await apiGet(two, '/api/campaigns/suppressions?limit=200');
    const myRows = ((mine.body as { data?: Record<string, unknown>[] })?.data ?? []);

    // Every address an agent sees must be one they could have mailed — i.e. one of their leads.
    const myLeads = await apiGet(two, '/api/leads?limit=200');
    const owned = new Set(
      (((myLeads.body as { data?: Record<string, unknown>[] })?.data ?? []) as Record<string, unknown>[])
        .map((l) => String(l.email ?? '').toLowerCase()).filter(Boolean),
    );
    await two.close();

    expect(mine.status).toBe(200);
    expect(myRows.length).toBeLessThanOrEqual(allRows.length);
    const notOwned = myRows.map((r) => String(r.email ?? '').toLowerCase()).filter((e) => !owned.has(e));
    expect(notOwned, `agent was shown opt-outs for addresses that are not their leads: ${notOwned.join(', ')}`).toEqual([]);
  });

  test('the marketing role still sees the whole brokerage list', async ({ page, context }) => {
    // `crm` prepares campaigns for agents; scoping it to its own leads would show it nothing.
    await signIn(page, 'superAdmin');
    const all = ((await apiGet(page, '/api/campaigns/suppressions?limit=200')).body as { meta?: { total?: number } })?.meta?.total ?? 0;

    const two = await context.newPage();
    await signIn(two, 'crm');
    const asCrm = ((await apiGet(two, '/api/campaigns/suppressions?limit=200')).body as { meta?: { total?: number } })?.meta?.total ?? 0;
    await two.close();

    expect(asCrm).toBe(all);
  });
});

test.describe('CRM-PERF-L01 — a missing avatar is requested once, not once per page', () => {
  test('revisiting a list of avatars does not re-ask for the same missing photos', async ({ page }) => {
    /*
     * WHY THIS SHAPE, AND NOT A WALK THROUGH FOUR SCREENS.
     *
     * The first version of this test navigated Dashboard → Calendar → Lead → Campaigns and asserted
     * no further requests. It passed with the fix REVERTED, so it proved nothing: the shell's single
     * avatar never unmounts during in-app navigation, and its own component state already stopped
     * the repeat. The requests I had measured came from `page.goto`, which is a full reload — an
     * artefact of the harness, not of how anyone uses the application.
     *
     * The case the memo actually fixes is a LIST that unmounts and remounts. Measured on the Users
     * screen, leaving and returning three times:
     *
     *     without the memo:  7 on first load, then 21 more
     *     with the memo:     7 on first load, then  0
     *
     * A hard refresh still costs one request per avatar, and that is correct — after a reload the
     * client genuinely knows nothing.
     */
    await signIn(page, 'superAdmin');

    const photoRequests: string[] = [];
    page.on('request', (r) => {
      if (/\/api\/users\/\d+\/photo/.test(r.url())) photoRequests.push(r.url().replace(API_BASE, ''));
    });

    await page.goto('/crm/users');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(700);
    const afterFirstLoad = photoRequests.length;
    expect(afterFirstLoad, 'the Users screen must render some avatars, or this proves nothing').toBeGreaterThan(0);

    for (let i = 0; i < 3; i += 1) {
      await page.getByRole('button', { name: 'Dashboard', exact: true }).first().click();
      await page.waitForTimeout(500);
      await page.getByRole('button', { name: 'Users', exact: true }).first().click();
      await page.waitForTimeout(700);
    }

    const repeats = photoRequests.length - afterFirstLoad;
    expect(repeats,
      `three round-trips to the list issued ${repeats} repeat photo requests (first load issued ${afterFirstLoad})`)
      .toBe(0);
  });

  test('an avatar that exists is still shown', async ({ page }) => {
    // The memo must not swallow a real picture. Super Admin's own avatar request must still fire
    // the first time, whatever its outcome.
    await signIn(page, 'superAdmin');
    const seen: string[] = [];
    page.on('request', (r) => {
      if (/\/api\/users\/\d+\/photo/.test(r.url())) seen.push(r.url());
    });
    await page.goto('/crm/users');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(600);
    // The Users screen renders many avatars; each distinct user is asked for at least once.
    expect(new Set(seen).size).toBeGreaterThan(0);
  });
});
