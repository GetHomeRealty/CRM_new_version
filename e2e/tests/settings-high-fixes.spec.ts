import { test, expect } from '@playwright/test';
import { signIn, apiGet, apiSend, type AccountKey } from './helpers';

/**
 * CRM › Settings — the seven High findings of the 2026-08-04 audit, each pinned by the case that
 * found it.
 *
 * Written as the failure rather than the feature — "a settings:view role cannot write the global
 * row", not "account settings work" — because the value is in catching the specific regression.
 * Every one of these was demonstrated against the running application before it was fixed; the
 * numbers in the comments are what the probes actually returned.
 *
 * They live here rather than in the server suite because four of them are about guard WIRING and
 * screen GATING — which decorator sits on which route, and which tab the interface offers — and
 * neither a service-level test nor a unit test can see either.
 */

/** A lead the Super Admin does not own, so H5 is tested against the case that failed. */
const AGENT_OWNED_LEAD = 'marcus.bell@example.test';

// ---------------------------------------------------------------------------- H1
test.describe('H1 — a settings:view role cannot write the brokerage-wide CRM settings', () => {
  /*
   * Measured before the fix, one session as the Admin (role `manager`, permission map
   * `settings: 'view'`): PUT /api/crm-settings -> 403, PUT /api/account/settings -> 200 with
   * `scope: "global"`, and the Super Admin then read the Admin's value back out of the shared row.
   * AccountController carries AuthGuard and nothing else, and `saveSettings` resolves its scope
   * from the caller's ROLE — so the screen permission the CRM Settings write asks for was simply
   * not on the path an administrator's own Settings page took.
   */
  test('the Admin’s own Settings page writes their own row, not the brokerage’s', async ({ page, browser }) => {
    const marker = `H1-${Date.now()}`;

    const ctx = await browser.newContext();
    try {
      const asAdmin = await ctx.newPage();
      await signIn(asAdmin, 'admin');

      const me = await apiGet(asAdmin, '/api/user');
      expect((me.body as any)?.permissions?.settings, 'the Admin must still be settings:view').toBe('view');

      // The gated door still refuses them. If this ever returns 200 the fix has been undone from
      // the other end.
      const front = await apiSend(asAdmin, 'PUT', '/api/crm-settings', { emailSettings: { signature: marker } });
      expect(front.status).toBe(403);

      // The ungated door now writes their OWN row.
      const side = await apiSend(asAdmin, 'PUT', '/api/account/settings', { emailSettings: { signature: marker } });
      expect(side.status).toBe(200);
      expect((side.body as any)?.scope, 'an account write must never land on the global row').toBe('user');

      // …and reads it back as their own.
      const mine = await apiGet(asAdmin, '/api/account/settings');
      expect((mine.body as any)?.emailSettings?.signature).toBe(marker);
    } finally {
      await ctx.close();
    }

    // The brokerage-wide row is untouched by any of that.
    await signIn(page, 'superAdmin');
    const global = await apiGet(page, '/api/crm-settings');
    expect((global.body as any)?.scope).toBe('global');
    expect((global.body as any)?.emailSettings?.signature,
      'the Admin’s personal signature must not have reached the shared row').not.toBe(marker);
  });

  test('an agent still gets their own row, as they always did', async ({ page }) => {
    // The fix must not change the four roles that were already correct.
    await signIn(page, 'agent');
    const res = await apiSend(page, 'PUT', '/api/account/settings', { emailSettings: { signature: 'H1-agent' } });
    expect(res.status).toBe(200);
    expect((res.body as any)?.scope).toBe('user');
  });

  test('a Super Admin’s own Settings page is theirs too', async ({ page }) => {
    // `admin` is in CRM_ADMIN_ROLES as well, so it took the same wrong branch.
    await signIn(page, 'superAdmin');
    const res = await apiSend(page, 'PUT', '/api/account/settings', { emailSettings: { signature: 'H1-super' } });
    expect(res.status).toBe(200);
    expect((res.body as any)?.scope).toBe('user');
  });
});

// ---------------------------------------------------------------------------- H2
test.describe('H2 — the CRM Settings tab and its API answer to one permission', () => {
  /*
   * Measured before the fix: granting `settings: edit` to the Admin role was honoured by every
   * endpoint — PUT /api/crm-settings 200, PUT email-settings 200, POST broadcasts 201, which emails
   * every member of staff — while `/crm/settings` offered that Admin exactly one tab, "Company
   * Settings". The grant was real and there was no screen to use it on. Before THAT it was the
   * mirror image: form enabled, save 403. Two authorities for one screen, failing in whichever
   * direction they happened to disagree.
   */
  test('a granted settings:edit produces the tab as well as the API access', async ({ page, browser }) => {
    await signIn(page, 'superAdmin');
    const roles = await apiGet(page, '/api/roles');
    const manager = ((roles.body as any[]) ?? []).find((r) => r.key === 'manager');
    expect(manager, 'the manager role must exist').toBeTruthy();
    const original = { ...(manager.permissions as Record<string, string>) };
    expect(original.settings, 'the default must still be view').toBe('view');

    const grant = await apiSend(page, 'PUT', `/api/roles/${manager.id}/permissions`, {
      permissions: { ...original, settings: 'edit' },
    });
    expect(grant.status).toBe(200);

    const ctx = await browser.newContext();
    try {
      const asAdmin = await ctx.newPage();
      await signIn(asAdmin, 'admin');
      await asAdmin.goto('/crm/settings');
      await expect(asAdmin.locator('.settings-tabs button', { hasText: 'CRM Settings' })).toBeVisible();

      // The writes the grant implies still work, so the tab is not decoration either.
      expect((await apiSend(asAdmin, 'PUT', '/api/crm-settings', { preferences: { theme: 'light' } })).status).toBe(200);
    } finally {
      await ctx.close();
      await apiSend(page, 'PUT', `/api/roles/${manager.id}/permissions`, { permissions: original });
    }
  });

  test('without the grant the tab is read-only rather than absent, and every write is refused', async ({ browser }) => {
    // `view` opens the screen; it must not offer a Save button whose every press returns 403 —
    // that is the failure the Company Settings audit opened with.
    const ctx = await browser.newContext();
    try {
      const asAdmin = await ctx.newPage();
      await signIn(asAdmin, 'admin');
      await asAdmin.goto('/crm/settings?tab=crm');
      await expect(asAdmin.getByText('Read-only.', { exact: false }).first()).toBeVisible();
      await expect(asAdmin.getByRole('button', { name: 'Save Preferences' })).toHaveCount(0);
      await expect(asAdmin.getByRole('button', { name: 'Send to All Users' })).toHaveCount(0);
      await expect(asAdmin.getByRole('button', { name: 'Send Email' })).toHaveCount(0);
      // Their own Personal Information stays theirs to change — its endpoint asks only for `view`.
      await expect(asAdmin.getByRole('button', { name: 'Save Personal Information' })).toBeVisible();

      expect((await apiSend(asAdmin, 'PUT', '/api/crm-settings', { preferences: {} })).status).toBe(403);
      expect((await apiSend(asAdmin, 'POST', '/api/crm-settings/broadcasts', { message: 'x' })).status).toBe(403);
    } finally {
      await ctx.close();
    }
  });

  test('a role with settings:none still sees nothing', async ({ page }) => {
    await signIn(page, 'crm');
    await page.goto('/crm/settings');
    await expect(page.locator('.settings-tabs button', { hasText: 'CRM Settings' })).toHaveCount(0);
    expect((await apiGet(page, '/api/crm-settings')).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------- H3
test.describe('H3 — the master switch blocks every send', () => {
  test.afterEach(async ({ page }) => {
    await signIn(page, 'superAdmin');
    await apiSend(page, 'PUT', '/api/crm-settings/email-settings', {
      smtpPort: '587', autoSendEnabled: true,
      emailTemplates: { wedding: true, seasonal: true, promotional: true, referral: true, custom: true },
    });
  });

  /*
   * `autoSendEnabled()` existed on CrmAdvancedEmailService since the migration and had no caller at
   * all. Measured: saved with the switch off, a custom email went straight through to the SMTP
   * layer, while the per-trigger switch one line down the same card refused correctly. The screen
   * offered one gate that held and one that did not, with the ineffective one labelled as the
   * stronger of the two.
   */
  test('a send with CRM emails switched off is refused before it reaches the mailer', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const off = await apiSend(page, 'PUT', '/api/crm-settings/email-settings', {
      smtpPort: '587', autoSendEnabled: false,
      emailTemplates: { wedding: true, seasonal: true, promotional: true, referral: true, custom: true },
    });
    expect((off.body as any)?.autoSendEnabled).toBe(false);

    const send = await apiSend(page, 'POST', '/api/crm-settings/email-settings', {
      action: 'sendCustomEmail', leadName: 'Marcus', leadEmail: AGENT_OWNED_LEAD,
      subject: 'H3 probe', content: '<p>x</p>',
    });
    const body = send.body as any;
    expect(body.success).toBe(false);
    // The refusal must name the master switch — reaching SMTP and failing there is the bug.
    expect(String(body.message)).toMatch(/CRM emails are switched off/i);
    expect(String(body.message)).not.toMatch(/getaddrinfo|ENOTFOUND|SMTP/i);
  });

  test('the two triggers with no send path are no longer offered as switches', async ({ page }) => {
    // `birthday` and `anniversary` gated nothing in either position: no send action exists for
    // either, so switching them on made nothing available and switching them off blocked nothing.
    await signIn(page, 'superAdmin');
    const res = await apiGet(page, '/api/crm-settings/email-settings');
    const keys = (res.body as any)?.trigger_keys as string[];
    expect(keys).toEqual(['wedding', 'seasonal', 'promotional', 'referral', 'custom']);
  });
});

// ---------------------------------------------------------------------------- H4
test.describe('H4 — the CRM Triggers screen edits the switches the sender reads', () => {
  test.afterEach(async ({ page }) => {
    await signIn(page, 'superAdmin');
    await apiSend(page, 'PUT', '/api/crm-settings/email-settings', {
      smtpPort: '587', autoSendEnabled: true,
      emailTemplates: { wedding: true, seasonal: true, promotional: true, referral: true, custom: true },
    });
  });

  /*
   * The screen wrote `crm_settings.templates`, a column with no consumer anywhere; the send path
   * reads `crm_email_settings.template_toggles`. Measured: weddingGreetings.enabled saved as false,
   * wedding email sent anyway. The two stores did not even name the same things, and the five on
   * this screen defaulted to OFF — so an administrator saw every trigger off here and sent mail
   * successfully from the other screen.
   */
  test('switching a trigger off on the Triggers screen stops that email', async ({ page }) => {
    await signIn(page, 'superAdmin');

    /*
     * Start from a known state. These switches are per-person and persist, so this test passed in
     * isolation and failed in the full suite: an earlier test had already left wedding off, the
     * `uncheck()` below did nothing, and the Save button — which counts pending changes — never
     * appeared. A test that depends on the order it runs in is not testing what it claims to.
     */
    await apiSend(page, 'PUT', '/api/crm-settings/triggers', { triggers: { wedding: true } });
    await page.goto('/crm/triggers');

    const wedding = page.locator('label.crm-toggle', { hasText: 'Wedding Congratulations' }).locator('input');
    await expect(wedding).toBeVisible();
    await expect(wedding).toBeChecked();
    await wedding.uncheck();
    /*
     * The button counts the pending changes rather than naming the screen, and the toast and the
     * refusal both say "your" — because these switches became one row per person. This test was
     * written against the brokerage-wide version and kept asserting its wording, so it failed on a
     * behaviour that had been deliberately changed rather than broken.
     */
    await page.getByRole('button', { name: /^Save \d+ change/ }).click();
    await expect(page.getByText('Your CRM triggers were saved')).toBeVisible();

    const send = await apiSend(page, 'POST', '/api/crm-settings/email-settings', {
      action: 'sendWeddingEmail', leadName: 'Marcus', leadEmail: AGENT_OWNED_LEAD, weddingDate: '2026-09-01',
    });
    expect((send.body as any)?.success).toBe(false);
    expect(String((send.body as any)?.message)).toMatch(/trigger is switched off/i);
  });

  test('a switch nobody has personally set follows the brokerage default', async ({ page }) => {
    /*
     * This asserted "one store, two screens" — true when the triggers lived on the brokerage row,
     * and no longer the design: they are one row per person. What still holds, and is what the test
     * is really for, is INHERITANCE — a switch this person has never touched follows the brokerage
     * default and keeps following it when an administrator changes that default.
     */
    await signIn(page, 'superAdmin');
    await apiSend(page, 'PUT', '/api/crm-settings/email-settings', {
      smtpPort: '587', autoSendEnabled: true,
      emailTemplates: { wedding: true, seasonal: false, promotional: true, referral: true, custom: true },
    });
    await page.goto('/crm/triggers');
    const seasonal = page.locator('label.crm-toggle', { hasText: 'Seasonal Wishes' }).locator('input');
    await expect(seasonal).not.toBeChecked();
  });
});

// ---------------------------------------------------------------------------- H5
test.describe('H5 — an administrator can email a lead on somebody else’s desk', () => {
  /*
   * "Send a CRM Email" sits on a screen requiring the `settings` permission, which only Super Admin
   * and Admin hold — and the recipient had to be assigned to or owned by the caller. Neither of
   * those roles owns leads: at a brokerage with hundreds of agents every lead belongs to an agent.
   * Measured as Super Admin against every seeded lead: "Not sent — this address is not one of your
   * leads." The card refused every recipient it was ever going to be given.
   */
  test('a Super Admin reaches an agent-owned lead', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const send = await apiSend(page, 'POST', '/api/crm-settings/email-settings', {
      action: 'sendCustomEmail', leadName: 'Marcus', leadEmail: AGENT_OWNED_LEAD,
      subject: 'H5 probe', content: '<p>x</p>',
    });
    // It may still fail at the mail server — this environment has no reachable SMTP host, and that
    // is fine. What must not happen is a refusal at the recipient check.
    expect(String((send.body as any)?.message)).not.toMatch(/not one of your leads|no lead in the CRM/i);
  });

  test('the relay hole stays closed — an address that is nobody’s lead is still refused', async ({ page }) => {
    // This is the protection the ownership rule was added for, and widening the rule must not
    // reopen it: arbitrary HTML to any address on earth, from the brokerage's own aligned domain.
    await signIn(page, 'superAdmin');
    const send = await apiSend(page, 'POST', '/api/crm-settings/email-settings', {
      action: 'sendCustomEmail', leadName: 'Nobody', leadEmail: 'stranger@not-a-lead.invalid',
      subject: 'H5 relay probe', content: '<p>x</p>',
    });
    expect((send.body as any)?.success).toBe(false);
    expect(String((send.body as any)?.message)).toMatch(/no lead in the CRM has this address/i);
  });

  test('an agent is still confined to their own book', async ({ page }) => {
    // `data.read-all` is manager and above. Nothing below it gained anything.
    await signIn(page, 'agent2');
    const send = await apiSend(page, 'POST', '/api/crm-settings/email-settings', {
      action: 'sendCustomEmail', leadName: 'Marcus', leadEmail: AGENT_OWNED_LEAD,
      subject: 'H5 isolation probe', content: '<p>x</p>',
    });
    // An agent has settings:none, so they never reach the endpoint at all — which is the strongest
    // form of "confined". Recorded explicitly so a future permission change is noticed here.
    expect(send.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------- H6
test.describe('H6 — a cleared company field stays cleared', () => {
  /*
   * `current()` re-filled every blank field from a constant ON EVERY READ, and the constant carried
   * this brokerage's real address, HST registration and TD beneficiary, transit, institution and
   * account numbers. Measured: blank five fields -> 200, the response echoed "", the very next GET
   * returned all five originals. A field could not be cleared, and on any deployment that is not
   * this brokerage a blank banking field silently populated with another company's account number —
   * which prints on the Deposit Receipt telling clients where to wire a trust deposit.
   */
  test('blanking a field is not silently undone by the next read', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const before = (await apiGet(page, '/api/company-settings')).body as Record<string, unknown>;

    try {
      const cleared = await apiSend(page, 'PUT', '/api/company-settings', { ...before, address: '', hst_number: '' });
      expect(cleared.status).toBe(200);

      const after = (await apiGet(page, '/api/company-settings')).body as Record<string, unknown>;
      expect(after.address, 'a cleared address must not come back').toBe('');
      expect(after.hst_number, 'a cleared HST number must not come back').toBe('');
    } finally {
      await apiSend(page, 'PUT', '/api/company-settings', before);
      const restored = (await apiGet(page, '/api/company-settings')).body as Record<string, unknown>;
      expect(restored.address).toBe(before.address);
      expect(restored.account_no).toBe(before.account_no);
    }
  });
});

// ---------------------------------------------------------------------------- H7
test.describe('H7 — the audit trail says which field changed and what it was', () => {
  /*
   * Every Company Settings save wrote ONE entry — `Settings updated`, details = the company name,
   * old_value and new_value null. Changing the operating bank account was byte-for-byte
   * indistinguishable from correcting a typo in the office phone number, and the previous value was
   * recorded nowhere. Payment redirection against a brokerage's trust deposits is the most
   * expensive fraud in this industry and these are the fields that decide where the money goes.
   */
  const entriesFor = async (page: any, field: string) => {
    const log = await apiGet(page, '/api/audit-logs?per_page=30&area=desk');
    const rows = ((log.body as any)?.data ?? []) as any[];
    return rows.filter((r) => r.section === 'Company Settings' && r.field === field);
  };

  test('a phone change records the field, the old value and the new one', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const before = (await apiGet(page, '/api/company-settings')).body as Record<string, unknown>;
    const next = '905-555-0H7';
    try {
      await apiSend(page, 'PUT', '/api/company-settings', { ...before, phone: next });
      const hits = await entriesFor(page, 'Phone');
      expect(hits.length, 'the change must be recorded against the field that changed').toBeGreaterThan(0);
      /*
       * `?? ''`, not `String(...)`. A field nobody has filled in is NULL, and `String(null)` is the
       * four-character word "null" — a value the application would never write. The trail records
       * an unset previous value as an empty string, so that is what this must expect.
       *
       * The test therefore passed only on a database where somebody had already set a phone number,
       * and failed on a freshly seeded one. That is the wrong way round: a clean seed is the state
       * a new environment starts in, so the suite was green exactly where it should have been red.
       */
      expect(hits[0].old_value).toBe(before.phone ?? '');
      expect(hits[0].new_value).toBe(next);
      expect(hits[0].action).toBe('Settings updated');
    } finally {
      await apiSend(page, 'PUT', '/api/company-settings', before);
    }
  });

  test('a banking change carries its own action string', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const before = (await apiGet(page, '/api/company-settings')).body as Record<string, unknown>;
    const next = '9999999';
    try {
      await apiSend(page, 'PUT', '/api/company-settings', { ...before, account_no: next });
      const hits = await entriesFor(page, 'Account No.');
      expect(hits.length).toBeGreaterThan(0);
      // Filterable and alertable without parsing a details sentence.
      expect(hits[0].action).toBe('Banking details changed');
      // Same reason as the phone assertion above: unset is '', never the string "null".
      expect(hits[0].old_value).toBe(before.account_no ?? '');
      expect(hits[0].new_value).toBe(next);
    } finally {
      await apiSend(page, 'PUT', '/api/company-settings', before);
    }
  });

  test('a save that changes nothing records nothing', async ({ page }) => {
    // A trail full of entries recording no change is how the previous version became unreadable.
    await signIn(page, 'superAdmin');
    const before = (await apiGet(page, '/api/company-settings')).body as Record<string, unknown>;
    const countBefore = (((await apiGet(page, '/api/audit-logs?per_page=50&area=desk')).body as any)?.data ?? [])
      .filter((r: any) => r.section === 'Company Settings').length;

    await apiSend(page, 'PUT', '/api/company-settings', before);

    const countAfter = (((await apiGet(page, '/api/audit-logs?per_page=50&area=desk')).body as any)?.data ?? [])
      .filter((r: any) => r.section === 'Company Settings').length;
    expect(countAfter).toBe(countBefore);
  });
});

// ---------------------------------------------------------------------------- guard rails
test.describe('the perimeter these fixes must not have moved', () => {
  const ROLES: AccountKey[] = ['agent', 'crm', 'accounting', 'docs'];

  for (const who of ROLES) {
    test(`${who} still cannot read or write CRM settings`, async ({ page }) => {
      await signIn(page, who);
      expect((await apiGet(page, '/api/crm-settings')).status).toBe(403);
      expect((await apiSend(page, 'PUT', '/api/crm-settings', { preferences: {} })).status).toBe(403);
    });
  }

  test('writes still need the CSRF header', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const res = await apiSend(page, 'PUT', '/api/crm-settings', { preferences: { theme: 'light' } }, { omitCsrf: true });
    expect(res.status).toBe(419);
  });

  test('over-length SMTP fields are a validation error, not a 500', async ({ page }) => {
    await signIn(page, 'superAdmin');
    for (const field of ['smtpHost', 'smtpUser']) {
      const res = await apiSend(page, 'PUT', '/api/crm-settings/email-settings', {
        [field]: 'x'.repeat(400), smtpPort: '587', autoSendEnabled: true, emailTemplates: {},
      });
      expect(res.status, `${field} must be refused, not crash`).toBe(400);
      expect((res.body as any)?.errors?.[field]).toBeTruthy();
    }
  });
});
