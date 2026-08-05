import { test, expect } from '@playwright/test';
import { signIn, apiGet, apiSend } from './helpers';

/**
 * Two things whose whole point is what a person sees, so a service test cannot reach them.
 *
 *   L7            — a role without `settings` reaching /crm/settings
 *   CRM-DASH-M01  — the four invoice tiles on the Transaction Desk dashboard
 *
 * CRM-DASH-M01 was measured in the browser before it was changed, and it was WRONG ON SCREEN rather
 * than merely wrong in a payload, which is why it belongs here.
 *
 * L7 IS A CORRECTION TO MY OWN WORK, and the correction is the useful part — see below.
 */

// ---------------------------------------------------------------------------- L7
test.describe('L7 — a role without Settings is told so, not shown an empty room', () => {
  /*
   * THE FINDING WAS ALREADY CLOSED, AND NOT WHERE THE REPORT SAID.
   *
   * L7 records "agent, crm, accounting and documentation reach /crm/settings and get an empty tab
   * bar and nothing else — no redirect, no 'you do not have access'". I read `SettingsPage`, found
   * its fallback tab was the literal string 'company', concluded the finding was open and changed it.
   *
   * Then this test failed, and the failure screenshot showed the answer: `RequireScreen` in
   * `desk/guards.tsx` renders "🔒 No access — You don't have permission to view this screen. Ask an
   * administrator to grant you access under Users." before `SettingsPage` ever mounts. The route
   * guard had closed it. My change to `SettingsPage` was for a case those four roles cannot reach.
   *
   * Reading one file and inferring the behaviour of a screen was the mistake; the route table is
   * part of that screen. These tests now pin the mechanism that actually does the work.
   */
  for (const who of ['agent', 'crm', 'accounting', 'docs'] as const) {
    test(`${who} is refused at the route, with an explanation`, async ({ page }) => {
      await signIn(page, who);
      await page.goto('/crm/settings');
      await page.waitForTimeout(1200);

      await expect(page.getByRole('heading', { name: /No access/i })).toBeVisible();
      // Naming where to ask is the difference between a refusal and a dead end.
      await expect(page.locator('.stub')).toContainText(/Users/);
      // And no tab bar, because there is nothing behind it.
      await expect(page.locator('.settings-tabs .btn')).toHaveCount(0);
    });
  }

  test('a role WITH Settings still gets its tabs — the guard did not swallow everyone', async ({ page }) => {
    await signIn(page, 'superAdmin');
    await page.goto('/crm/settings');
    await page.waitForTimeout(1200);
    await expect(page.getByRole('heading', { name: /No access/i })).toHaveCount(0);
    expect(await page.locator('.settings-tabs .btn').count()).toBeGreaterThan(0);
  });

  test('a bogus ?tab is still corrected for someone who has access', async ({ page }) => {
    await signIn(page, 'superAdmin');
    await page.goto('/crm/settings?tab=doesnotexist');
    await page.waitForTimeout(1200);
    expect(new URL(page.url()).searchParams.get('tab')).not.toBe('doesnotexist');
  });

  test('a Super Admin is above the permission map, so the tab list is never empty', async ({ page, browser }) => {
    /*
     * WHY THIS EXISTS: it is the second half of the correction above, and the reason the
     * `SettingsPage` change was REVERTED rather than kept.
     *
     * Having found that `RequireScreen` closes L7 for the four roles that lack `settings`, the
     * remaining question was the account that gets past it: the Settings route is `orSuperAdmin`, so
     * a Super Admin whose `settings` permission had been revoked would reach the component with —
     * apparently — no tabs to show, since 'crm' and 'company' both ask `can('settings','view')`.
     *
     * That cannot happen. `PermissionService.effectiveFor` short-circuits `isSuperAdmin` to every
     * screen at `edit` before the role map or any override is consulted, so revoking the permission
     * changes nothing for them. This test revokes it and proves exactly that — which is what makes
     * the empty-tab-list branch unreachable, and an unreachable branch is dead code rather than
     * defence.
     */
    await signIn(page, 'superAdmin');
    const roles = await apiGet(page, '/api/roles');
    const admin = ((roles.body as { key: string; id: number; permissions: Record<string, string> }[]) ?? [])
      .find((r) => r.key === 'admin');
    expect(admin, 'the admin (Super Admin) role must exist').toBeTruthy();
    const original = { ...admin!.permissions };

    const revoke = await apiSend(page, 'PUT', `/api/roles/${admin!.id}/permissions`, {
      permissions: { ...original, settings: 'none' },
    });
    expect(revoke.status).toBe(200);

    const ctx = await browser.newContext();
    try {
      const p = await ctx.newPage();
      await signIn(p, 'superAdmin');
      await p.goto('/crm/settings');
      await p.waitForTimeout(1500);

      // All three CRM-area tabs, despite the revoke.
      await expect(p.locator('.settings-tabs button', { hasText: 'CRM Settings' })).toBeVisible();
      await expect(p.locator('.settings-tabs button', { hasText: 'Company Settings' })).toBeVisible();
      await expect(p.getByRole('heading', { name: /No access/i })).toHaveCount(0);
    } finally {
      await ctx.close();
      // Restore before anything else runs — a probe for a guard has to undo the thing it probes for,
      // for the case where the guard is missing. The S-H4 test learned this the hard way.
      const back = await apiSend(page, 'PUT', `/api/roles/${admin!.id}/permissions`, { permissions: original });
      expect(back.status, 'the Super Admin role must be restored').toBe(200);
      expect(((await apiGet(page, '/api/roles')).body as { key: string; permissions: Record<string, string> }[])
        .find((r) => r.key === 'admin')?.permissions.settings).toBe(original.settings);
    }
  });
});

// -------------------------------------------------------------- CRM-DASH-M01
test.describe('CRM-DASH-M01 — the invoice tiles belong to whoever may read invoices', () => {
  /*
   * Measured on the development database: the agent "Akhil" saw transactions 3 of the brokerage's 7
   * — correctly their own — beside `invoices { total: 5, billed: 123396, outstanding: 123396 }`,
   * identical to the Super Admin's and identical to `SELECT sum(total) FROM invoices`. The agent role
   * holds `invoice: 'none'`.
   */
  const MONEY_TILES = ['Billed', 'Collected', 'Outstanding'];

  for (const who of ['agent', 'docs', 'crm'] as const) {
    test(`${who} holds invoice: none and sees no money tiles`, async ({ page }) => {
      await signIn(page, who);
      await page.goto('/desk/dashboard');
      await page.waitForTimeout(2000);

      for (const label of MONEY_TILES) {
        await expect(page.getByText(label, { exact: true })).toHaveCount(0);
      }
      await expect(page.getByText('Invoices', { exact: true })).toHaveCount(0);
    });

    test(`${who} is not sent the figures either — the API withholds them, not the CSS`, async ({ page }) => {
      // Hiding a tile whose numbers are still in the payload is not a fix; anybody can open the
      // console. This is the assertion that distinguishes the two.
      await signIn(page, who);
      const r = await apiGet(page, '/api/dashboard/desk');
      if (r.status !== 200) return;                       // the module may not be assigned to them
      expect((r.body as { invoices: unknown }).invoices).toBeNull();
    });
  }

  test('a Super Admin still sees them', async ({ page }) => {
    await signIn(page, 'superAdmin');
    await page.goto('/desk/dashboard');
    await page.waitForTimeout(2000);
    for (const label of MONEY_TILES) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
    }
  });

  for (const who of ['admin', 'accounting'] as const) {
    test(`${who} still receives the figures`, async ({ page }) => {
      await signIn(page, who);
      const r = await apiGet(page, '/api/dashboard/desk');
      if (r.status !== 200) return;
      expect((r.body as { invoices: unknown }).invoices).not.toBeNull();
    });
  }

  test('the rest of an agent\'s desk dashboard still renders', async ({ page }) => {
    // The fix must not take the deal figures with it — those were already correct, and a blank
    // dashboard would be a worse outcome than the one being fixed.
    await signIn(page, 'agent');
    await page.goto('/desk/dashboard');
    await page.waitForTimeout(2000);
    await expect(page.getByText('Todo List', { exact: true }).first()).toBeVisible();
  });
});
