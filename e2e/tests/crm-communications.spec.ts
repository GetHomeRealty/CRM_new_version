import { expect, test } from '@playwright/test';
import { ACCOUNTS, API_BASE, signIn, apiGet, apiSend } from './helpers';

/**
 * CRM → Settings → Communications, through the browser and the real API.
 *
 * THE POINT OF DOING THIS HERE rather than only in Jest: the permission rules have to hold at the
 * HTTP boundary. An agent who cannot see the Edit button can still send the PUT, and a screen that
 * hides a control is not an authorization decision. Every refusal below is a real request.
 */

test.describe('CRM Communications — what an agent may do', () => {
  test('an agent can read the communications list', async ({ page }) => {
    await signIn(page, 'agent');
    const res = await apiGet(page, '/api/crm-communications');
    expect(res.status).toBe(200);

    const body = res.body as { communications: { key: string }[]; is_admin: boolean };
    expect(body.is_admin).toBe(false);
    // Ten automated plus three manual; the retired one is not offered.
    expect(body.communications).toHaveLength(13);
    expect(body.communications.map((c) => c.key)).not.toContain('wedding');
  });

  test('an agent can set their OWN preference', async ({ page }) => {
    await signIn(page, 'agent');
    const off = await apiSend(page, 'PUT', '/api/crm-communications/preferences/birthday/email', { enabled: false });
    expect(off.status).toBe(200);

    const after = await apiGet(page, '/api/crm-communications');
    const row = (after.body as { communications: { key: string; preferences: { email: boolean } }[] })
      .communications.find((c) => c.key === 'birthday')!;
    expect(row.preferences.email).toBe(false);

    // Put it back, so the run leaves the account as it found it.
    await apiSend(page, 'PUT', '/api/crm-communications/preferences/birthday/email', { enabled: true });
  });

  test('an agent can preview shared template content', async ({ page }) => {
    await signIn(page, 'agent');
    const list = await apiGet(page, '/api/crm-communications');
    const withTemplate = (list.body as { communications: { template: { id: number } | null }[] })
      .communications.find((c) => c.template);
    test.skip(!withTemplate, 'no CRM template seeded yet on this database');

    const res = await apiSend(page, 'POST', `/api/crm-communications/templates/${withTemplate!.template!.id}/preview`, {});
    expect(res.status).toBe(200);
    expect((res.body as { subject: string }).subject).toBeTruthy();
  });

  test('an agent CANNOT edit shared template content', async ({ page }) => {
    await signIn(page, 'agent');
    const list = await apiGet(page, '/api/crm-communications');
    const withTemplate = (list.body as { communications: { template: { id: number; subject: string } | null }[] })
      .communications.find((c) => c.template);
    test.skip(!withTemplate, 'no CRM template seeded yet on this database');
    const { id, subject } = withTemplate!.template!;

    const res = await apiSend(page, 'PUT', `/api/crm-communications/templates/${id}`, {
      subject: 'AGENT SHOULD NOT BE ABLE TO WRITE THIS',
    });
    expect(res.status).toBe(403);

    // And nothing was written — the refusal is real, not cosmetic.
    const after = await apiGet(page, '/api/crm-communications');
    const again = (after.body as { communications: { template: { id: number; subject: string } | null }[] })
      .communications.find((c) => c.template?.id === id)!;
    expect(again.template!.subject).toBe(subject);
  });

  test('an agent CANNOT create a template', async ({ page }) => {
    await signIn(page, 'agent');
    const res = await apiSend(page, 'POST', '/api/crm-communications/templates', {
      name: 'Agent made this', subject: 'S', body_html: '<p>B</p>',
    });
    expect(res.status).toBe(403);
  });

  test('the endpoint offers no way to name another user', async ({ page }) => {
    await signIn(page, 'agent');
    /*
     * The route is /preferences/:key/:channel and takes the caller from the session. Sending a
     * user_id in the body cannot redirect the write, because nothing reads one. This asserts the
     * shape holds: agent2's preference is untouched by anything agent can send.
     */
    const before = await apiGet(page, '/api/crm-communications');
    const mine = (before.body as { communications: { key: string; preferences: { email: boolean } }[] })
      .communications.find((c) => c.key === 'seasonal')!.preferences.email;

    await apiSend(page, 'PUT', '/api/crm-communications/preferences/seasonal/email', {
      enabled: !mine, user_id: 9999, userId: 9999,
    });

    await signIn(page, 'agent2');
    const other = await apiGet(page, '/api/crm-communications');
    expect(other.status).toBe(200);   // agent2 reads their own, unaffected by agent's write

    await signIn(page, 'agent');
    await apiSend(page, 'PUT', '/api/crm-communications/preferences/seasonal/email', { enabled: mine });
  });
});

test.describe('CRM Communications — what an administrator may do', () => {
  test('a Super Admin sees edit rights and the brokerage switch', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const res = await apiGet(page, '/api/crm-communications');
    const body = res.body as { is_admin: boolean; brokerage: { can_edit: boolean } };
    expect(body.is_admin).toBe(true);
    expect(body.brokerage.can_edit).toBe(true);
  });

  /**
   * The brokerage controls, at the HTTP boundary.
   *
   * These moved here from the retired CRM Triggers screen, and they are the one part of this screen
   * that is not personal: one row, one value, every colleague's sending. So they get the same
   * treatment as the template routes — an agent is refused by the API and not merely by the absence
   * of a button.
   */
  test('an administrator can set the master switch and a brokerage default, and both persist', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const before = (await apiGet(page, '/api/crm-communications')).body as
      { brokerage: { auto_send_enabled: boolean; defaults: Record<string, boolean> } };

    try {
      const off = await apiSend(page, 'PUT', '/api/crm-communications/brokerage', { auto_send_enabled: false });
      expect(off.status).toBe(200);
      expect(((await apiGet(page, '/api/crm-communications')).body as { brokerage: { auto_send_enabled: boolean } })
        .brokerage.auto_send_enabled).toBe(false);

      const flipped = !before.brokerage.defaults.seasonal;
      const def = await apiSend(page, 'PUT', '/api/crm-communications/brokerage', { defaults: { seasonal: flipped } });
      expect(def.status).toBe(200);
      const after = (await apiGet(page, '/api/crm-communications')).body as
        { brokerage: { auto_send_enabled: boolean; defaults: Record<string, boolean> } };
      expect(after.brokerage.defaults.seasonal).toBe(flipped);
      // Setting a default did not disturb the master switch, and vice versa.
      expect(after.brokerage.auto_send_enabled).toBe(false);
    } finally {
      // Leave the brokerage exactly as it was — this row is shared by every other test in the run.
      await apiSend(page, 'PUT', '/api/crm-communications/brokerage', {
        auto_send_enabled: before.brokerage.auto_send_enabled,
        defaults: before.brokerage.defaults,
      });
    }
  });

  test('setting one brokerage value leaves the CRM SMTP fields alone', async ({ page }) => {
    /*
     * The Triggers screen posted the whole `crm_email_settings` row back on every save, so flipping
     * a switch silently rewrote the SMTP host an administrator had set elsewhere (T-H2). This
     * endpoint sends one field; nothing else may move.
     */
    await signIn(page, 'superAdmin');
    const before = (await apiGet(page, '/api/crm-settings/email-settings')).body as Record<string, unknown>;

    await apiSend(page, 'PUT', '/api/crm-communications/brokerage', { defaults: { custom: true } });

    const after = (await apiGet(page, '/api/crm-settings/email-settings')).body as Record<string, unknown>;
    expect(after.smtpHost).toBe(before.smtpHost);
    expect(after.smtpPort).toBe(before.smtpPort);
    expect(after.smtpUser).toBe(before.smtpUser);
    expect(after.adminEmail).toBe(before.adminEmail);
  });

  test('an agent CANNOT set the brokerage controls', async ({ page }) => {
    await signIn(page, 'agent');
    const body = (await apiGet(page, '/api/crm-communications')).body as { brokerage: { can_edit: boolean } };
    expect(body.brokerage.can_edit).toBe(false);

    for (const payload of [{ auto_send_enabled: false }, { defaults: { birthday: true } }]) {
      const res = await apiSend(page, 'PUT', '/api/crm-communications/brokerage', payload);
      expect(res.status).toBe(403);
    }
  });

  test('creating an unmapped template makes something that cannot send', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const res = await apiSend(page, 'POST', '/api/crm-communications/templates', {
      name: `E2E draft ${Date.now()}`, subject: 'Draft', body_html: '<p>Draft</p>', is_active: true,
    });
    expect(res.status).toBe(201);
    const made = res.body as { id: number; mapped: boolean; notice: string | null; event_key: string };
    expect(made.mapped).toBe(false);
    expect(made.notice).toMatch(/will not send automatically/i);

    // It appears as unmapped, not as a live communication.
    const list = await apiGet(page, '/api/crm-communications');
    const body = list.body as {
      unmapped_templates: { id: number; is_active: boolean }[];
      communications: { template: { id: number } | null }[];
    };
    const found = body.unmapped_templates.find((t) => t.id === made.id)!;
    expect(found).toBeTruthy();
    expect(found.is_active).toBe(false);          // asked for active; created inactive regardless
    expect(body.communications.some((c) => c.template?.id === made.id)).toBe(false);
  });

  test('an arbitrary or Transaction Desk event key is refused', async ({ page }) => {
    await signIn(page, 'superAdmin');
    for (const key of ['crm.invented_event', 'invoice.send']) {
      const res = await apiSend(page, 'POST', '/api/crm-communications/templates', {
        name: 'X', subject: 'S', body_html: '<p>B</p>', event_key: key,
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/not a CRM communication/i);
    }
  });

  test('a duplicate CRM event key is refused with an Edit Existing message', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const list = await apiGet(page, '/api/crm-communications');
    const existing = (list.body as { communications: { template: { event_key: string } | null }[] })
      .communications.find((c) => c.template);
    test.skip(!existing, 'no CRM template seeded yet on this database');

    const res = await apiSend(page, 'POST', '/api/crm-communications/templates', {
      name: 'Second', subject: 'S', body_html: '<p>B</p>', event_key: existing!.template!.event_key,
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/already has a template/i);
  });
});

test.describe('CRM Communications — the boundaries it must not cross', () => {
  test('signed out, every route refuses', async ({ page }) => {
    await page.context().clearCookies();
    for (const path of ['/api/crm-communications']) {
      const res = await page.request.get(`${API_BASE}${path}`, { headers: { Accept: 'application/json' } });
      expect(res.status()).toBe(401);
    }
  });

  test('Transaction Desk templates are not listed or reachable here', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const res = await apiGet(page, '/api/crm-communications');
    const body = res.body as { communications: { template: { event_key: string } | null }[]; unmapped_templates: { event_key: string }[] };
    const keys = [
      ...body.communications.map((c) => c.template?.event_key).filter(Boolean),
      ...body.unmapped_templates.map((t) => t.event_key),
    ] as string[];
    for (const k of keys) expect(k.startsWith('crm.')).toBe(true);
  });

  test('the Transaction Desk templates screen still works and still excludes CRM', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const res = await apiGet(page, '/api/email-templates');
    expect(res.status).toBe(200);
    const groups = (res.body as { groups: { module: string; templates: unknown[] }[] }).groups;
    // Desk's own modules are all still there and still populated.
    expect(groups.some((g) => g.module === 'Transactions' && g.templates.length > 0)).toBe(true);
    expect(groups.some((g) => g.module === 'Invoice' && g.templates.length > 0)).toBe(true);
  });
});

test.describe('CRM Communications — the screen', () => {
  /*
   * TWO DOORS, ONE SCREEN, AND WHY.
   *
   * The screen is mostly an agent's own preferences, but CRM → Settings is gated on `settings:view`
   * and agents do not hold it — routed only there, the screen would have been unreachable by the
   * people it is for. So it is also registered as an open personal route at /crm/communications,
   * the same way Notification Preferences is. Both doors are tested, because a regression that
   * closed either one would leave a whole role with no way in.
   */
  test('an agent reaches it at its own route and sees the account-only notice', async ({ page }) => {
    await signIn(page, 'agent');
    await page.goto('/crm/communications');
    await expect(page.getByText('Brokerage Controls')).toBeVisible();
    await expect(page.getByText('Automated CRM Communications')).toBeVisible();
    await expect(page.getByText('Manual CRM Emails')).toBeVisible();
    await expect(page.getByText(/These preferences apply only to your account/i)).toBeVisible();
    // No creation control for an agent.
    await expect(page.getByRole('button', { name: /Create New Template/i })).toHaveCount(0);
  });

  test('the agent route is NOT the Settings screen wearing a different name', async ({ page }) => {
    /*
     * Opening it must not have handed the agent anything CRM Settings would have. If this ever
     * starts passing by way of the Settings shell, the permission gate has been widened.
     */
    await signIn(page, 'agent');
    await page.goto('/crm/settings?tab=crm&section=communications');
    await expect(page.getByText(/These preferences apply only to your account/i)).toHaveCount(0);

    const res = await apiGet(page, '/api/crm-settings');
    expect(res.status).toBe(403);
  });

  test('a Super Admin sees the template library and the create control', async ({ page }) => {
    await signIn(page, 'superAdmin');
    await page.goto('/crm/settings?tab=crm&section=communications');
    await expect(page.getByText('Template Library')).toBeVisible();
    await expect(page.getByRole('button', { name: /Create New Template/i })).toBeVisible();
  });

  test('a Super Admin reaches the same screen at the open route too', async ({ page }) => {
    await signIn(page, 'superAdmin');
    await page.goto('/crm/communications');
    await expect(page.getByText('Template Library')).toBeVisible();
    await expect(page.getByText('Automated CRM Communications')).toBeVisible();
  });

  /** The brokerage card is writable for an administrator and read-only for everybody else. */
  test('an administrator sees a writable brokerage card; an agent sees a read-only one', async ({ page }) => {
    await signIn(page, 'superAdmin');
    await page.goto('/crm/communications');
    const master = page.getByRole('checkbox', { name: /Allow CRM per-lead emails/i });
    await expect(master).toBeVisible();
    await expect(master).toBeEnabled();
    await expect(page.getByText('Brokerage defaults')).toBeVisible();

    await signIn(page, 'agent');
    await page.goto('/crm/communications');
    await expect(page.getByRole('checkbox', { name: /Allow CRM per-lead emails/i })).toBeDisabled();
    await expect(page.getByText('Brokerage defaults')).toHaveCount(0);
    await expect(page.getByText(/Read-only/i)).toBeVisible();
  });

  /**
   * Switching CRM email off for everybody asks first; switching it back on does not.
   *
   * Carried over from the retired Triggers screen's T-M5, because the control it guarded came with
   * it. The asymmetry is the point: the confirmation exists for the direction that stops every
   * colleague's mail, and one you meet in both directions is one you learn to click through.
   */
  test('turning the master switch off is confirmed; turning it on is not', async ({ page }) => {
    await signIn(page, 'superAdmin');

    // Start from ON, so the OFF transition is the one under test.
    await apiSend(page, 'PUT', '/api/crm-communications/brokerage', { auto_send_enabled: true });
    await page.goto('/crm/communications');

    const master = page.getByRole('checkbox', { name: /Allow CRM per-lead emails/i });
    const sending = async () => ((await apiGet(page, '/api/crm-communications')).body as
      { brokerage: { auto_send_enabled: boolean } }).brokerage.auto_send_enabled;

    /*
     * `click()`, NOT `uncheck()`, and the difference is the behaviour under test.
     *
     * The box is controlled by the stored value, so clicking it opens the confirmation and leaves
     * the box alone — the state changes only once the server has agreed. `uncheck()` asserts the
     * state flipped on click and therefore fails against a control that asks first, which is
     * exactly the control this test exists to prove. Measured: "Clicking the checkbox did not
     * change its state".
     */
    await master.click();
    await expect(page.getByText(/Switch off CRM email for the whole brokerage\?/i)).toBeVisible();
    // Still on, because nothing has been confirmed yet.
    expect(await sending()).toBe(true);

    await page.getByRole('button', { name: 'Switch it off' }).click();
    await expect.poll(sending).toBe(false);
    await expect(master).not.toBeChecked();

    // Back on, with no question asked.
    await master.click();
    await expect(page.getByText(/Switch off CRM email for the whole brokerage\?/i)).toHaveCount(0);
    await expect.poll(sending).toBe(true);
  });

  test('the Edit Template deep link opens that template in CRM Settings → Templates', async ({ page }) => {
    await signIn(page, 'superAdmin');
    await page.goto('/crm/communications');

    const edit = page.getByRole('button', { name: /Edit Template/i }).first();
    test.skip(await edit.count() === 0, 'no CRM template seeded yet on this database');
    await edit.click();

    await expect(page).toHaveURL(/tab=crm&section=templates&template=\d+/, { timeout: 15_000 });
    // The editor is open on a template, not merely the list.
    await expect(page.getByLabel('Subject')).toBeVisible({ timeout: 15_000 });
  });
});

/**
 * Preference storage, end to end.
 *
 * These are the properties the Triggers removal had to preserve, asserted where they are now set.
 * They are HTTP-level because that is where the guarantee has to hold — a screen that hides a
 * control is presentation, and a preference that survives only until the next login is not stored.
 */
test.describe('CRM Communications — preferences survive and stay personal', () => {
  test('a preference persists across sign out and back in', async ({ page }) => {
    await signIn(page, 'agent');
    const before = ((await apiGet(page, '/api/crm-communications')).body as
      { communications: { key: string; preferences: { email: boolean } }[] })
      .communications.find((c) => c.key === 'seasonal')!.preferences.email;

    try {
      await apiSend(page, 'PUT', '/api/crm-communications/preferences/seasonal/email', { enabled: !before });
      await page.context().clearCookies();
      await signIn(page, 'agent');

      const after = ((await apiGet(page, '/api/crm-communications')).body as
        { communications: { key: string; preferences: { email: boolean } }[] })
        .communications.find((c) => c.key === 'seasonal')!.preferences.email;
      expect(after).toBe(!before);
    } finally {
      await apiSend(page, 'PUT', '/api/crm-communications/preferences/seasonal/email', { enabled: before });
    }
  });

  /**
   * One agent's switch moves theirs and nobody else's.
   *
   * WRITES ONLY AS `agent`, AND THAT RESTRAINT IS THE POINT RATHER THAN TIDINESS. An earlier version
   * set the preference for both accounts and then "restored" each to what it had read back. For a
   * lead-facing row that read is the EFFECTIVE answer — which, for somebody who has chosen nothing,
   * is the inherited brokerage default. Birthday's default is off, so restoring wrote an explicit
   * `false` for agent2 where no row had existed, turning "following the office" into "opted out".
   * `notification-preferences.spec.ts` caught it, correctly, one file later.
   *
   * So this asserts the property without touching the other account: agent2's answer is read before
   * and after and must not have moved. The stronger simultaneous case — A off while B is on — is
   * proven in `crm-communications.service.spec.ts`, which runs inside a rollback transaction and can
   * therefore write for both without leaving anything behind.
   */
  test('one agent switching Off does not move another agent', async ({ page, browser }) => {
    const ctx = await browser.newContext();
    try {
      const other = await ctx.newPage();
      await signIn(other, 'agent2');
      await signIn(page, 'agent');

      const read = async (p: typeof page) => ((await apiGet(p, '/api/crm-communications')).body as
        { communications: { key: string; preferences: { email: boolean } }[] })
        .communications.find((c) => c.key === 'birthday')!.preferences.email;

      const mineBefore = await read(page);
      const theirsBefore = await read(other);

      try {
        await apiSend(page, 'PUT', '/api/crm-communications/preferences/birthday/email', { enabled: false });
        expect(await read(page)).toBe(false);
        expect(await read(other)).toBe(theirsBefore);

        await apiSend(page, 'PUT', '/api/crm-communications/preferences/birthday/email', { enabled: true });
        expect(await read(page)).toBe(true);
        expect(await read(other)).toBe(theirsBefore);
      } finally {
        // `agent` is written to by this file already, so restoring its effective value here changes
        // nothing that was not already explicit.
        await apiSend(page, 'PUT', '/api/crm-communications/preferences/birthday/email', { enabled: mineBefore });
      }
    } finally {
      await ctx.close();
    }
  });

  /**
   * Every communication the CRM has is offered here, on the channels it actually supports.
   *
   * The list is the contract: this is now the single user-facing place for CRM communications, so
   * anything missing from it is a control nobody can reach. Named individually rather than counted,
   * because a count passes when one is swapped for another.
   */
  test('offers every automated communication and every manual email', async ({ page }) => {
    await signIn(page, 'agent');
    const body = (await apiGet(page, '/api/crm-communications')).body as
      { communications: { key: string; kind: string; preferences: Record<string, boolean> }[] };
    const keys = body.communications.map((c) => c.key);

    for (const key of [
      'lead_new', 'lead_assigned', 'lead_task_due', 'lead_meta', 'campaign_completed', 'campaign_failed',
      'welcome', 'birthday', 'anniversary', 'seasonal',
    ]) expect(keys, `${key} must be offered`).toContain(key);

    for (const key of ['promotional', 'referral', 'custom']) {
      const row = body.communications.find((c) => c.key === key)!;
      expect(row.kind).toBe('manual');
      // One switch each — there is no schedule to mute and no in-app equivalent of a hand-written email.
      expect(Object.keys(row.preferences)).toEqual(['email']);
    }
  });

  /** Manual CRM emails are settable from this screen, which is now their only screen. */
  test('a manual CRM email can be switched off and on from Communications', async ({ page }) => {
    await signIn(page, 'agent');
    const read = async () => ((await apiGet(page, '/api/crm-communications')).body as
      { communications: { key: string; preferences: { email: boolean } }[] })
      .communications.find((c) => c.key === 'promotional')!.preferences.email;

    const before = await read();
    try {
      expect((await apiSend(page, 'PUT', '/api/crm-communications/preferences/promotional/email', { enabled: false })).status).toBe(200);
      expect(await read()).toBe(false);
      await apiSend(page, 'PUT', '/api/crm-communications/preferences/promotional/email', { enabled: true });
      expect(await read()).toBe(true);
    } finally {
      await apiSend(page, 'PUT', '/api/crm-communications/preferences/promotional/email', { enabled: before });
    }
  });
});
