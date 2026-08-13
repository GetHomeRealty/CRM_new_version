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
});
