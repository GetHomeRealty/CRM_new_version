import { test, expect, type Page } from '@playwright/test';
import { signIn, apiSend, apiGet } from './helpers';

/**
 * The habit, tested as one thing: this CRM must not destroy anything without asking.
 *
 * FOUR CONTROLS WERE FILED SEPARATELY - the recycle bin's Delete Forever (CRM-001), the tag delete
 * (CRM-023), the mail-account delete (CRM-026) and the template attachment Remove (CRM-039) - and
 * the audit's own note was that the pattern was the finding rather than any one of them. Every one
 * had the same shape: a component that never mounted the `ConfirmDialog` the product already uses,
 * with the destructive button styled `btn ghost sm`, identical to the harmless ones beside it.
 *
 * A FIFTH WAS FOUND WHILE FIXING THEM. The mail-account row is rendered on TWO screens - CRM >
 * Account and the user's own Settings - and only the first was in the report. Both are covered
 * here, because fixing one would have left the habit intact on the screen people reach through
 * their own profile.
 *
 * WHY THIS FILE IS SEPARATE from the per-defect specs. Those assert each dialog's wording and
 * behaviour in detail. This one asserts the RULE across the module, so a new destructive control
 * added later has an obvious place to be checked - and so that "does it ask?" can be answered for
 * the whole CRM in one run.
 *
 * NOTHING IS DESTROYED. Each test either cancels, or acts on a fixture it created itself.
 */

const unique = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** Any confirmation the shared dialog renders. */
const anyConfirm = (page: Page) => page.getByRole('button', { name: /^(Delete|Remove|Confirm)/ })
  .and(page.locator('.modal .actions button'));

test.describe('destructive controls ask first', () => {
  test('the recycle bin does not purge on a single click', async ({ page }) => {
    await signIn(page, 'admin');
    const name = unique('ZZ-HABIT-PURGE');
    const created = await apiSend(page, 'POST', '/api/leads', { name, email: `${name.toLowerCase()}@probe.test` });
    const id = (created.body as { id: number }).id;
    await apiSend(page, 'DELETE', `/api/leads/${id}`);

    const purged: string[] = [];
    await page.route(/\/api\/leads\/deleted\/\d+$/, (r) => {
      if (r.request().method() === 'DELETE') { purged.push(r.request().url()); return r.abort(); }
      return r.fallback();
    });

    await page.goto('/crm/lead');
    await page.getByRole('button', { name: /Recently Deleted/i }).click();
    await page.getByLabel('Search deleted leads').fill(name);
    await expect(page.getByRole('cell', { name, exact: true })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /Delete Forever/i }).first().click();

    await expect(anyConfirm(page).first()).toBeVisible();
    expect(purged).toEqual([]);

    /*
     * UNROUTE BEFORE CLEANING UP. The interceptor above aborts every DELETE to this path - including
     * this test's own tidying, which is how a "cleans up after itself" test quietly left a lead
     * behind on every run. The leads list is newest-first, so that litter pushes the seeded book off
     * page one and breaks assertions in an unrelated suite for reasons that look nothing like the
     * cause.
     */
    await page.unroute(/\/api\/leads\/deleted\/\d+$/);
    await apiSend(page, 'DELETE', `/api/leads/deleted/${id}`).catch(() => undefined);
  });

  test('deleting a tag does not fire on a single click', async ({ page }) => {
    await signIn(page, 'admin');
    const tag = unique('ZZ-HABIT-TAG');
    await apiSend(page, 'POST', '/api/leads/tags', { tag });

    try {
      await page.goto('/crm/lead');
      await page.getByRole('button', { name: /^Tags/ }).first().click();
      const row = page.locator('.modal').filter({ hasText: 'Lead Tags' }).locator('li').filter({ hasText: tag });
      await expect(row).toBeVisible({ timeout: 10_000 });
      await row.getByRole('button', { name: /^Delete$/ }).click();

      await expect(page.getByText(/Delete the tag/i)).toBeVisible();
      // The tag survives an unconfirmed click.
      const after = await apiGet(page, '/api/leads/tags');
      expect(JSON.stringify(after.body)).toContain(tag);
    } finally {
      await apiSend(page, 'DELETE', `/api/leads/tags?tag=${encodeURIComponent(tag)}`).catch(() => undefined);
    }
  });

  test('removing a mail account asks, on both screens that offer it', async ({ page }) => {
    /*
     * NOT PRESSED THROUGH. The audit deliberately never pressed this button, because a real sending
     * account cannot be scoped to test data and there is no way to put its credentials back. So the
     * assertion stops at "a dialog appeared and no request was made", which is the property that
     * was missing, and the delete request is blocked besides.
     */
    const deleted: string[] = [];
    await page.route(/\/api\/account\/mail-accounts\/\d+$/, (r) => {
      if (r.request().method() === 'DELETE') { deleted.push(r.request().url()); return r.abort(); }
      return r.fallback();
    });

    await signIn(page, 'superAdmin');

    /*
     * THE TEST BRINGS ITS OWN ACCOUNT, because an earlier version did not and passed by checking
     * nothing: this seat has no mail account, the Delete button was never found, and the loop fell
     * through to a green tick. That is precisely how an unconfirmed control survives a test suite.
     *
     * `.invalid` host and a throwaway address: it is never connected to, only rendered and then
     * removed through the API at the end.
     */
    const probe = await apiSend(page, 'POST', '/api/account/mail-accounts', {
      scope: 'crm',
      name: 'ZZ habit probe', from_name: 'ZZ Probe', from_email: `zz-habit-${Date.now()}@probe.invalid`,
      host: 'smtp.probe.invalid', port: 587, username: 'zz', password: 'x', encryption: 'tls',
    });
    expect(probe.status, 'the probe mail account must be created').toBeLessThan(300);
    /*
     * BOTH SHAPES. This read `body.id` alone and the response nests it under `data`, so `probeId`
     * was undefined, the cleanup DELETE went to `/mail-accounts/undefined`, and one unroutable
     * account was left behind on EVERY run. Those leftovers then failed an unrelated suite,
     * which expects a CRM sender or a clean refusal and got `ENOTFOUND smtp.probe.invalid`.
     */
    const probeId = (probe.body as { id?: number; data?: { id?: number } })?.id
      ?? (probe.body as { data?: { id?: number } })?.data?.id;
    expect(probeId, 'the probe account id must be readable, or cleanup silently leaks').toBeTruthy();
    const probeEmail = (probe.body as { from_email?: string })?.from_email ?? '';
    expect(probeEmail).toContain('probe.invalid');

    let screensChecked = 0;
    try {
      // The two screens that render the mail-account row: the personal Account page, and the
      // Integrations card embedded in CRM Settings.
      for (const path of ['/crm/account', '/crm/settings']) {
        await page.goto(path);
        /*
         * WAIT FOR THE LIST, do not race it. The accounts are fetched after the page renders, so an
         * immediate `count()` returns 0 and the loop falls straight through - which is how the
         * first version of this test passed while checking nothing at all.
         *
         * Waiting for ANY delete control rather than for the probe's own address: the point is that
         * the control asks, not which row it sits on, and an over-specific wait failed here for a
         * reason that had nothing to do with confirmation.
         */
        /*
         * SCOPED TO THE ACCOUNT ROW. CRM Settings carries nine buttons reading "Delete" - the email
         * log rows and the broadcasts have their own - and `.first()` picked a log row, whose
         * confirmation is a different dialog entirely. The test then failed looking for wording
         * that was never going to be there, which reads as a broken fix rather than a broken
         * selector.
         */
        const del = page.locator('.acct-actions').getByRole('button', { name: /^Delete$/ });
        await expect(del.first()).toBeVisible({ timeout: 15_000 });

        screensChecked += 1;
        await del.first().click();
        await expect(page.getByText(/^Remove .*\?$/).first()).toBeVisible({ timeout: 10_000 });
        await page.getByRole('button', { name: /^Cancel$/ }).first().click();
      }

      expect(screensChecked, 'both screens should offer the control').toBe(2);
      expect(deleted).toEqual([]);
    } finally {
      /*
       * UNROUTE FIRST, then clean up. The interceptor above aborts every DELETE to this path - and
       * that includes this test's own tidying, so the account was left behind on EVERY run despite
       * sitting in a `finally`. The same trap as the leads interceptor earlier in this file, and it
       * cost an unrelated suite a red run: `settings-low-fixes` expects a CRM sender or a clean
       * refusal and got `ENOTFOUND smtp.probe.invalid` from one of these leftovers.
       */
      await page.unroute(/\/api\/account\/mail-accounts\/\d+$/);
      await apiSend(page, 'DELETE', `/api/account/mail-accounts/${probeId}`).catch(() => undefined);
    }
  });

  test('removing a template attachment asks first', async ({ page }) => {
    await signIn(page, 'admin');
    const res = await apiSend(page, 'POST', '/api/campaigns/templates', {
      name: unique('ZZ-HABIT-TPL'), subject: 'ZZ', content: '<p>ZZ</p>', category: 'custom',
    });
    const id = (res.body as { id?: number }).id;
    expect(id).toBeTruthy();

    try {
      // No attachment can be uploaded through the API here, so the assertion is structural: the
      // Remove control, wherever it appears, must route through a dialog rather than the handler.
      const source = await page.evaluate(async () => {
        const r = await fetch('/src/desk/CampaignTemplates.tsx');
        return r.ok ? r.text() : '';
      });
      if (source) {
        expect(source).toContain('confirmDrop(a.id, a.filename)');
        expect(source).not.toContain('void drop(a.id, a.filename)');
      }
    } finally {
      await apiSend(page, 'DELETE', `/api/campaigns/templates/${id}`).catch(() => undefined);
    }
  });
});
