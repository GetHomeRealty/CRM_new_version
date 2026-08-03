import { test, expect } from '@playwright/test';
import { signIn, apiGet, apiSend, ACCOUNTS, type AccountKey } from './helpers';

/**
 * CRM › Settings — the High-band findings of the 2026-08-03 audit, pinned at the API.
 *
 * These live here rather than in the server suite because two of them are about guard WIRING —
 * which decorator sits on which route — and a service-level test cannot see a guard at all.
 */

/** Roles that produce the documents printing the brokerage's banking details. */
const MAY_READ_BANKING: AccountKey[] = ['superAdmin', 'admin', 'accounting', 'docs'];
/** Roles that cannot open a single screen displaying them. */
const MAY_NOT: AccountKey[] = ['agent', 'crm'];

const BANK_FIELDS = ['bank_beneficiary', 'bank_name', 'transit_no', 'account_no', 'institution_no', 'hst_number'];

test.describe('S-H1 — the brokerage bank account', () => {
  for (const who of MAY_READ_BANKING) {
    test(`${who} (${ACCOUNTS[who].role}) receives it — they produce the documents that print it`, async ({ page }) => {
      await signIn(page, who);
      const res = await apiGet(page, '/api/company-settings');
      const body = res.body as Record<string, unknown>;
      expect(res.status).toBe(200);
      for (const f of BANK_FIELDS) expect(body).toHaveProperty(f);
    });
  }

  for (const who of MAY_NOT) {
    test(`${who} (${ACCOUNTS[who].role}) does not`, async ({ page }) => {
      await signIn(page, who);
      const res = await apiGet(page, '/api/company-settings');
      const body = res.body as Record<string, unknown>;

      // 200 with the branding, not a 403: the same request legitimately carries the name, address,
      // logo and tax rate that every screen needs.
      expect(res.status).toBe(200);
      expect(body).toHaveProperty('name');
      for (const f of BANK_FIELDS) expect(body).not.toHaveProperty(f);
    });
  }
});

test.describe('S-H2 — granting settings:edit actually grants it', () => {
  test('the grant the Roles screen offers is the one the API enforces', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const roles = await apiGet(page, '/api/roles');
    const list = (Array.isArray(roles.body) ? roles.body : []) as Array<Record<string, unknown>>;
    const manager = list.find((r) => String(r.key) === 'manager');
    expect(manager, 'the manager role must exist').toBeTruthy();
    const original = manager!.permissions as Record<string, string>;
    expect(original.settings).toBe('view');

    const ctx = await page.context().browser()!.newContext();
    try {
      const asAdmin = await ctx.newPage();
      await signIn(asAdmin, 'admin');
      const before = await apiGet(asAdmin, '/api/company-settings');
      const name = String((before.body as Record<string, unknown>).name);

      // With `view`, the write is refused and the form renders read-only. Unchanged by the fix.
      expect((await apiSend(asAdmin, 'PUT', '/api/company-settings', { name })).status).toBe(403);

      /*
       * Now grant `settings: edit` — the exact action the Roles & Permissions screen exists to
       * perform. Before the fix this returned 200, `/api/user` reported "edit", the form enabled
       * its inputs and showed Save, and every save came back 403 because the controller was gated
       * on AdminGuard (isSuperAdmin) while the client gated on the permission.
       */
      expect((await apiSend(page, 'PUT', `/api/roles/${manager!.id}/permissions`, {
        permissions: { ...original, settings: 'edit' },
      })).status).toBe(200);

      const fresh = await ctx.browser()!.newContext();
      try {
        const regranted = await fresh.newPage();
        await signIn(regranted, 'admin');
        const me = await apiGet(regranted, '/api/user');
        expect((me.body as { permissions?: Record<string, string> }).permissions?.settings).toBe('edit');

        // The client renders an editable form from exactly this permission, so the API must agree.
        const write = await apiSend(regranted, 'PUT', '/api/company-settings', { name });
        expect(write.status).toBe(200);

        // The logo buttons enable from the same permission and must agree too.
        expect((await apiSend(regranted, 'DELETE', '/api/company-settings/logo')).status).toBe(200);
      } finally {
        await fresh.close();
      }
    } finally {
      // Always put the role back, even if an expectation above failed.
      await apiSend(page, 'PUT', `/api/roles/${manager!.id}/permissions`, { permissions: original });
      await ctx.close();
    }

    const restored = ((await apiGet(page, '/api/roles')).body as Array<Record<string, unknown>>)
      .find((r) => String(r.key) === 'manager');
    expect((restored!.permissions as Record<string, string>).settings).toBe('view');
  });

  test('a role with settings:none is still refused', async ({ page }) => {
    await signIn(page, 'crm');
    const res = await apiSend(page, 'PUT', '/api/company-settings', { name: 'Should not apply' });
    expect(res.status).toBe(403);
  });
});

test.describe('S-H4 — the CRM profile form cannot take another account’s name', () => {
  test('an Admin cannot rename themselves to a working agent', async ({ page }) => {
    await signIn(page, 'admin');
    const me = (await apiGet(page, '/api/crm-settings/profile')).body as Record<string, unknown>;

    /*
     * The restore is not defensive padding — it is here because this test corrupted the seed data
     * the first time it ran. Against a build without the fix the rename SUCCEEDS, and a test whose
     * only assertion is "it was refused" leaves the account renamed and two people sharing a name
     * for every test that follows. A probe for a guard has to undo the thing it is probing for the
     * case where the guard is missing.
     */
    try {
      const res = await apiSend(page, 'PUT', '/api/crm-settings/profile', {
        name: ACCOUNTS.agent.name, email: me.email,
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/already has this name/i);

      // And nothing was written.
      const after = (await apiGet(page, '/api/crm-settings/profile')).body as Record<string, unknown>;
      expect(after.name).toBe(me.name);
    } finally {
      await apiSend(page, 'PUT', '/api/crm-settings/profile', { name: me.name, email: me.email });
    }
  });

  test('saving your own profile unchanged still works', async ({ page }) => {
    await signIn(page, 'admin');
    const me = (await apiGet(page, '/api/crm-settings/profile')).body as Record<string, unknown>;
    const res = await apiSend(page, 'PUT', '/api/crm-settings/profile', { name: me.name, email: me.email });
    expect(res.status).toBe(200);
  });
});
