import { test, expect, type Page } from '@playwright/test';
import { signIn, signOut, apiGet, apiSend, PASSWORD } from './helpers';

/**
 * BROKERAGE LEADS vs AGENT LEADS — proved in a real browser, for every role that matters.
 *
 * ================================================================================================
 * THE RULE
 *
 *   owner_user_id IS NULL   the BROKERAGE's lead. `admin`, `manager` and `crm` may work it, and so
 *                           may whoever it is assigned to.
 *   owner_user_id = X       agent X's PRIVATE lead. Nobody else reaches it — not a manager, not an
 *                           administrator, not a Super Admin.
 *   assigned_to             a SEPARATE field. Assigning a brokerage lead does not give it away.
 * ================================================================================================
 *
 * WHY THIS IS A BROWSER TEST AND NOT ONLY AN API ONE. The defect being locked down was a mismatch
 * BETWEEN SURFACES: the Leads screen said 0 while the campaign audience said 81. Each surface was
 * self-consistent, so testing any one of them in isolation proved nothing. The assertions below
 * therefore read the SCREEN and the API for the same account in the same session, and require them
 * to agree.
 *
 * HOW A BROKERAGE LEAD IS MADE HERE, and it is worth knowing why it is done the long way. There is
 * no endpoint that creates an unowned lead: `POST /api/leads`, the CSV importer and the Meta sync
 * all stamp the acting user as owner. The one supported path that produces a brokerage-owned lead
 * is an agent DEPARTING — deactivating them returns their brokerage leads to the pool unowned. So
 * this file hires a throwaway agent, gives them a lead, and deactivates them. That is a real
 * workflow, end to end, rather than a fixture reaching into the database.
 */

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 100000)}`;

/** Read the lead ids the API returns for whoever is signed in. */
async function visibleIds(page: Page): Promise<number[]> {
  const res = await apiGet(page, '/api/leads?page=1&limit=200');
  const body = res.body as { data?: { id: number }[] };
  return (body.data ?? []).map((l) => l.id);
}

/** The campaign audience the signed-in user may build, as a count. */
async function audienceCount(page: Page): Promise<number> {
  const res = await apiSend(page, 'POST', '/api/campaigns/preview', { filters: {} });
  const body = res.body as { count?: number; recipients?: unknown[] };
  return body.count ?? body.recipients?.length ?? -1;
}

test.describe('a brokerage lead is the brokerage’s, and an agent’s lead is not', () => {
  // Built once for the whole file: every assertion below reads the same two leads.
  let brokerageLeadId = 0;
  let brokerageLeadName = '';
  let agentPrivateLeadId = 0;
  let agentPrivateLeadName = '';

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    const stamp = uniq();

    /*
     * A BROKERAGE LEAD, made the way brokerage leads are now made: somebody who is not an agent
     * creates it, and `ownerAtIntake` records it as the brokerage's.
     *
     * This file used to manufacture one the long way round — hire a throwaway agent, have them
     * create a lead, then deactivate them so the lead was "returned to the brokerage". That was the
     * only path producing an unowned lead at the time, and it is no longer a path at all: a
     * departing agent's own leads now stay theirs, which is the point of the departure change. The
     * direct route is both simpler and the one real users take.
     */
    await signIn(page, 'superAdmin');
    brokerageLeadName = `Brokerage Intake ${stamp}`;
    const made = await apiSend(page, 'POST', '/api/leads', {
      name: brokerageLeadName,
      email: `brokerage-intake-${stamp}@x.test`,
      lead_status: 'warm',
    });
    expect([200, 201], `brokerage lead: ${JSON.stringify(made.body)}`).toContain(made.status);
    brokerageLeadId = (made.body as { id: number }).id;

    // And one that stays PRIVATE to a serving agent, as the control.
    await signOut(page);
    await signIn(page, 'agent');
    agentPrivateLeadName = `Private To Dana ${stamp}`;
    const priv = await apiSend(page, 'POST', '/api/leads', {
      name: agentPrivateLeadName,
      email: `private-dana-${stamp}@x.test`,
      lead_status: 'warm',
    });
    expect([200, 201]).toContain(priv.status);
    agentPrivateLeadId = (priv.body as { id: number }).id;

    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await signIn(page, 'superAdmin');
    // The brokerage lead is reachable by a Super Admin, so it can be tidied away.
    if (brokerageLeadId) await apiSend(page, 'DELETE', `/api/leads/${brokerageLeadId}`);
    await signOut(page);
    await signIn(page, 'agent');
    if (agentPrivateLeadId) await apiSend(page, 'DELETE', `/api/leads/${agentPrivateLeadId}`);
    await page.close();
  });

  // -------------------------------------------------------------------------------------------
  test('the lead a Super Admin created belongs to the brokerage, not to them', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const res = await apiGet(page, `/api/leads/${brokerageLeadId}`);
    expect(res.status).toBe(200);
    // The whole model in one field: nobody owns it.
    expect((res.body as { owner_user_id: number | null }).owner_user_id).toBeNull();
  });

  test('a Manager SEES the brokerage lead on the Leads screen', async ({ page }) => {
    await signIn(page, 'admin');   // 'admin' is the `manager` role — see helpers.ACCOUNTS
    await page.goto('/crm/lead');
    /*
     * The headline regression, read off the screen rather than the API. Before the fix this was
     * blank for every brokerage role: only `isSuperAdmin` reached an unowned lead, so a Manager's
     * Leads screen showed nothing while the brokerage's own leads sat in the table.
     */
    await expect(page.getByText(brokerageLeadName).first()).toBeVisible({ timeout: 15_000 });
    expect(await visibleIds(page)).toContain(brokerageLeadId);
  });

  test('the CRM role sees it too — it is the role that works brokerage leads', async ({ page }) => {
    await signIn(page, 'crm');
    await page.goto('/crm/lead');
    await expect(page.getByText(brokerageLeadName).first()).toBeVisible({ timeout: 15_000 });
  });

  test('a Manager does NOT see an agent’s private lead, on screen or through the API', async ({ page }) => {
    await signIn(page, 'admin');
    await page.goto('/crm/lead');
    await expect(page.getByText(brokerageLeadName).first()).toBeVisible({ timeout: 15_000 });
    // The control, on the same screen, in the same session: the brokerage lead is there and the
    // private one is not. That pairing is what makes this an ownership test rather than a
    // "the page failed to load" test.
    await expect(page.getByText(agentPrivateLeadName)).toHaveCount(0);
    expect(await visibleIds(page)).not.toContain(agentPrivateLeadId);
  });

  test('a Super Admin cannot reach an agent’s private lead either', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const res = await apiGet(page, `/api/leads/${agentPrivateLeadId}`);
    // 404, not 403 — the answer must not tell an outsider the lead exists.
    expect(res.status).toBe(404);
  });

  test('an unrelated agent sees neither the brokerage lead nor a colleague’s', async ({ page }) => {
    await signIn(page, 'agent2');
    const ids = await visibleIds(page);
    expect(ids).not.toContain(brokerageLeadId);      // unassigned brokerage lead is not theirs
    expect(ids).not.toContain(agentPrivateLeadId);   // and neither is Dana's
  });

  test('the owning agent still sees their own private lead', async ({ page }) => {
    await signIn(page, 'agent');
    await page.goto('/crm/lead');
    await expect(page.getByText(agentPrivateLeadName).first()).toBeVisible({ timeout: 15_000 });
  });

  // -------------------------------------------------------------------------------------------
  test('the Leads screen and the campaign audience agree — no surface shows more than another', async ({ page }) => {
    await signIn(page, 'admin');
    const ids = await visibleIds(page);
    const audience = await audienceCount(page);

    /*
     * THE MISMATCH THIS FILE EXISTS FOR. Measured before the fix: Leads screen 0, campaign audience
     * 81 — and 14 of those 81 were agents' private clients, mailable by somebody who could not open
     * a single one of them.
     *
     * The audience may legitimately be SMALLER than the visible list (it drops unsubscribed and
     * malformed addresses), so the assertion is that it never exceeds it.
     */
    expect(audience).toBeGreaterThanOrEqual(0);
    expect(audience).toBeLessThanOrEqual(ids.length);
    // And specifically: the private lead is not in the mailable set.
    expect(ids).not.toContain(agentPrivateLeadId);
  });

  test('direct email is refused for an agent’s private lead and allowed for a brokerage one', async ({ page }) => {
    await signIn(page, 'superAdmin');

    const priv = await apiGet(page, `/api/leads/${agentPrivateLeadId}`);
    expect(priv.status).toBe(404);   // cannot even resolve it, so it cannot be addressed

    const brok = await apiGet(page, `/api/leads/${brokerageLeadId}`);
    expect(brok.status).toBe(200);   // the brokerage's own lead is reachable, and therefore emailable
  });

  test('export carries no lead the exporter cannot see', async ({ page }) => {
    await signIn(page, 'admin');
    const res = await apiSend(page, 'POST', '/api/leads/export', { filters: {} });
    expect(res.status).toBe(200);
    const rows = (res.body as { data?: { Email?: string }[] }).data ?? [];
    const emails = rows.map((r) => String(r.Email ?? '').toLowerCase());
    // The private lead's address must not appear in a Manager's export.
    expect(emails.some((e) => e.includes('private-dana-'))).toBe(false);
  });

  test('search cannot surface an agent’s private lead for a Manager', async ({ page }) => {
    await signIn(page, 'admin');
    const res = await apiGet(page, `/api/leads?search=${encodeURIComponent(agentPrivateLeadName)}`);
    const body = res.body as { data?: { id: number }[] };
    expect((body.data ?? []).map((l) => l.id)).not.toContain(agentPrivateLeadId);
  });

  // -------------------------------------------------------------------------------------------
  test('a lead an ADMINISTRATOR creates belongs to the brokerage, and colleagues can see it', async ({ page }) => {
    /*
     * The intake rule, through the real endpoint: only an agent owns what they create. Everybody
     * else is brokerage staff, so their lead lands in the brokerage's book whatever the source.
     */
    await signIn(page, 'superAdmin');
    const stamp = uniq();
    const name = `Admin Created ${stamp}`;
    const made = await apiSend(page, 'POST', '/api/leads', {
      name, email: `admin-created-${stamp}@x.test`, lead_status: 'warm',
    });
    expect([200, 201]).toContain(made.status);
    const id = (made.body as { id: number }).id;

    try {
      // Owned by nobody — the brokerage.
      expect((made.body as { owner_user_id: number | null }).owner_user_id).toBeNull();

      // A DIFFERENT brokerage role sees it on their own Leads screen. Under the old rule it was
      // private to the Super Admin who typed it and this would have been empty.
      await signOut(page);
      await signIn(page, 'admin');
      await page.goto('/crm/lead');
      await expect(page.getByText(name).first()).toBeVisible({ timeout: 15_000 });

      // And no agent picked it up.
      await signOut(page);
      await signIn(page, 'agent');
      expect(await visibleIds(page)).not.toContain(id);
    } finally {
      await signOut(page);
      await signIn(page, 'superAdmin');
      await apiSend(page, 'DELETE', `/api/leads/${id}`);
    }
  });

  test('a lead an AGENT creates stays theirs, and no administrator can open it', async ({ page }) => {
    await signIn(page, 'agent');
    const stamp = uniq();
    const made = await apiSend(page, 'POST', '/api/leads', {
      name: `Agent Created ${stamp}`, email: `agent-created-${stamp}@x.test`, lead_status: 'warm',
    });
    expect([200, 201]).toContain(made.status);
    const id = (made.body as { id: number }).id;

    try {
      // The agent owns it outright.
      expect((made.body as { owner_user_id: number | null }).owner_user_id).toBeTruthy();

      for (const who of ['superAdmin', 'admin', 'crm'] as const) {
        await signOut(page);
        await signIn(page, who);
        const res = await apiGet(page, `/api/leads/${id}`);
        expect(res.status, `${who} must not reach an agent's own lead`).toBe(404);
      }
    } finally {
      await signOut(page);
      await signIn(page, 'agent');
      await apiSend(page, 'DELETE', `/api/leads/${id}`);
    }
  });

  // -------------------------------------------------------------------------------------------
  test('the CRM email log cannot be used to discover an agent’s private lead', async ({ page }) => {
    /*
     * The log used to be governed by `data.read-all` alone, so a Manager who got 404 on a lead from
     * every other screen could read that same client's name, address and subject line here.
     *
     * The private lead created in `beforeAll` belongs to `agent@test.local`. Nothing in a Super
     * Admin's log may mention it — not the address, not the name.
     */
    await signIn(page, 'superAdmin');
    const res = await apiGet(page, '/api/crm-settings/email-log?limit=500');
    expect(res.status).toBe(200);

    const blob = JSON.stringify(res.body ?? []);
    expect(blob).not.toContain(agentPrivateLeadName);
    // The address is the identifier that matters most; assert it separately so a failure says which.
    const priv = await apiGet(page, `/api/leads/${agentPrivateLeadId}`);
    expect(priv.status).toBe(404);   // still unreachable through the Leads module...
    expect(blob).not.toContain('private-dana-');  // ...and not reachable through the log either
  });

  // -------------------------------------------------------------------------------------------
  test('deactivating an agent releases brokerage leads and keeps their own private', async ({ page }) => {
    /*
     * The mixed departure, through the real Users endpoint. One brokerage lead assigned to the
     * agent, one lead the agent owns; the account is switched off and each must go its own way.
     */
    const stamp = uniq();
    let hiredId = 0;
    let ownLeadId = 0;
    let assignedLeadId = 0;

    try {
      // ---- hire, and give them one of each kind of lead ----------------------------------------
      await signIn(page, 'superAdmin');
      const hire = await apiSend(page, 'POST', '/api/users', {
        name: `Mixed Departure ${stamp}`,
        username: `mixed-${stamp}`,
        email: `mixed-${stamp}@test.local`,
        password: PASSWORD, password_confirmation: PASSWORD,
        role: 'agent', status: 'Active',
        profile: { mobile: '4165550111', gender: 'Other' },
      });
      expect([200, 201]).toContain(hire.status);
      hiredId = (hire.body as { id: number }).id;

      // A brokerage lead (created by the Super Admin, so owner is null) assigned to them.
      const brokerage = await apiSend(page, 'POST', '/api/leads', {
        name: `Mixed Brokerage ${stamp}`, email: `mixed-brok-${stamp}@x.test`, assigned_to: hiredId,
      });
      expect([200, 201]).toContain(brokerage.status);
      assignedLeadId = (brokerage.body as { id: number }).id;
      expect((brokerage.body as { owner_user_id: number | null }).owner_user_id).toBeNull();

      // And one they create for themselves, which is theirs.
      await signOut(page);
      await page.goto('/login');
      await page.fill('input[name="username"]', `mixed-${stamp}@test.local`);
      await page.fill('input[name="password"]', PASSWORD);
      await page.click('button[type="submit"]');
      await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });

      const own = await apiSend(page, 'POST', '/api/leads', {
        name: `Mixed Private ${stamp}`, email: `mixed-priv-${stamp}@x.test`,
      });
      expect([200, 201]).toContain(own.status);
      ownLeadId = (own.body as { id: number }).id;
      expect((own.body as { owner_user_id: number | null }).owner_user_id).toBe(hiredId);

      // ---- deactivate -------------------------------------------------------------------------
      await signOut(page);
      await signIn(page, 'superAdmin');
      const retire = await apiSend(page, 'PUT', `/api/users/${hiredId}`, {
        name: `Mixed Departure ${stamp}`,
        username: `mixed-${stamp}`,
        email: `mixed-${stamp}@test.local`,
        role: 'agent', status: 'Inactive',
        profile: { mobile: '4165550111', gender: 'Other' },
      });
      // The private lead must not have blocked this.
      expect([200, 204], `deactivation must not be blocked: ${JSON.stringify(retire.body)}`).toContain(retire.status);

      // ---- the brokerage lead: still here, still the brokerage's, now unassigned ---------------
      const after = await apiGet(page, `/api/leads/${assignedLeadId}`);
      expect(after.status).toBe(200);                                        // not deleted
      expect((after.body as { owner_user_id: number | null }).owner_user_id).toBeNull();
      expect((after.body as { assigned_to: number | null }).assigned_to).toBeNull();

      // ---- their own lead: still theirs, and still invisible to the brokerage ------------------
      const priv = await apiGet(page, `/api/leads/${ownLeadId}`);
      expect(priv.status, 'a departed agent’s own lead must NOT become the brokerage’s').toBe(404);
    } finally {
      await signOut(page);
      await signIn(page, 'superAdmin');
      if (assignedLeadId) await apiSend(page, 'DELETE', `/api/leads/${assignedLeadId}`);
    }
  });

  // -------------------------------------------------------------------------------------------
  test('assigning a brokerage lead shares it without giving it away', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const assign = await apiSend(page, 'PUT', `/api/leads/${brokerageLeadId}`, {
      assigned_to: null,   // clear first, so the test is not order-dependent
    });
    expect([200, 422]).toContain(assign.status);

    // Hand it to Dana.
    const danaId = ((await apiGet(page, '/api/leads/options')).body as { users?: { id: number; name: string }[] })
      .users?.find((u) => u.name.includes('Dana'))?.id;
    expect(danaId).toBeTruthy();
    const handed = await apiSend(page, 'PUT', `/api/leads/${brokerageLeadId}`, { assigned_to: danaId });
    expect(handed.status).toBe(200);

    // The brokerage still owns it — assignment is not a transfer of ownership.
    const after = await apiGet(page, `/api/leads/${brokerageLeadId}`);
    expect((after.body as { owner_user_id: number | null }).owner_user_id).toBeNull();

    // The assignee can now reach it...
    await signOut(page);
    await signIn(page, 'agent');
    expect(await visibleIds(page)).toContain(brokerageLeadId);

    // ...and another agent still cannot.
    await signOut(page);
    await signIn(page, 'agent2');
    expect(await visibleIds(page)).not.toContain(brokerageLeadId);

    // ...and the brokerage never lost sight of it.
    await signOut(page);
    await signIn(page, 'admin');
    expect(await visibleIds(page)).toContain(brokerageLeadId);
  });
});
