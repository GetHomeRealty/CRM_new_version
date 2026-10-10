import { test, expect, type Page } from '@playwright/test';
import { ACCOUNTS, apiGet, apiSend, signIn } from './helpers';

/**
 * THE DOCUMENTATION ROLE'S COMMISSION CHANGE REQUEST, and its Basic Info lockdown.
 *
 * This role reads the commission rather than setting it, so instead of an edit it proposes
 * numbers for a Super Admin to approve — and approval APPLIES them rather than merely unlocking
 * the fields. The two halves worth proving in a browser are the ones a unit test cannot see: that
 * submitting changes nothing on screen or in the record, and that `?mode=edit` does not hand the
 * role a Basic Info form the server would then discard.
 *
 * THE ROLE IS MOCKED for what the SPA renders. Where the question is what the SERVER allows, the
 * test signs in as the seeded `docs@test.local` account instead — a mocked payload proves nothing
 * about an API, because the session behind it is still an admin's.
 */

const uniq = (p: string) => `${p}${Date.now().toString().slice(-7)}${Math.floor(Math.random() * 1000)}`;

type Made = { deals: number[] };

async function deal(page: Page, made: Made): Promise<{ id: number; property: string }> {
  const property = uniq('ZZ-TEST Commission Request Road ');
  const res = await apiSend(page, 'POST', '/api/transactions', {
    type: 'Residential Buying', property, status: 'Secured Firm', price: 500000,
    comm_type: '%', comm_value: 2.5, offer_date: '2026-08-13', closing_date: '2026-09-30',
    primary_agent: ACCOUNTS.agent.name,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const id = (res.body as { data: { id: number } }).data.id;
  made.deals.push(id);

  await apiSend(page, 'PUT', `/api/transactions/${id}`, {
    comm_pct: 2.5, comm_amt: 12500,
    team: [
      { name: ACCOUNTS.agent.name, split: 60, agent_pct: 80, brok_pct: 20, is_primary: true },
      { name: ACCOUNTS.agent2.name, split: 40, agent_pct: 70, brok_pct: 30 },
    ],
  });
  return { id, property };
}

const cleanUp = async (page: Page, made: Made) => {
  for (const id of made.deals) await apiSend(page, 'DELETE', `/api/transactions/${id}`).catch(() => undefined);
  made.deals = [];
};

const asDocumentation = (page: Page) => page.route('**/api/user', async (route) => {
  const real = await route.fetch();
  const u = await real.json() as Record<string, unknown>;
  await route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      ...u, role: 'documentation', is_admin: false, is_super_admin: false, is_admin_or_above: false,
      permissions: { ...(u.permissions as Record<string, string>), transactions: 'edit' },
    }),
  });
});

const openFinancial = async (page: Page, id: number) => {
  await page.goto(`/desk/transactions/${id}?mode=view`);
  await page.getByRole('button', { name: /Financial/i }).first().click();
  await expect(page.getByText('Financial Information')).toBeVisible({ timeout: 15_000 });
};

/** The saved commission figures, straight from the API. */
const figures = async (page: Page, id: number) => {
  const r = await apiGet(page, `/api/transactions/${id}`);
  const d = ((r.body as { data?: Record<string, unknown> }).data ?? r.body) as Record<string, unknown>;
  return { comm_pct: Number(d.comm_pct ?? 0), comm_amt: Number(d.comm_amt ?? 0) };
};

const requests = async (page: Page, id: number) => {
  const r = await apiGet(page, `/api/transactions/${id}`);
  const d = ((r.body as { data?: Record<string, unknown> }).data ?? r.body) as Record<string, unknown>;
  return (d.edit_requests ?? []) as { id: number; status: string; scope: string | null; reason: string | null;
    proposed: Record<string, unknown> | null; baseline: Record<string, unknown> | null; requested_by_name: string | null }[];
};

  /** Raised by somebody who may ask — a Super Admin is told to change it directly instead. */
  const raise = async (p: Page, txnId: number, proposed: Record<string, unknown>, reason: string): Promise<number> => {
    await p.context().clearCookies();
    await signIn(p, 'admin');
    const res = await apiSend(p, 'POST', `/api/transactions/${txnId}/edit-requests`, { reason, scope: 'commission', proposed });
    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    const id = ((res.body as { data?: { id: number } }).data ?? res.body as { id: number }).id;
    expect(typeof id).toBe('number');
    await p.context().clearCookies();
    await signIn(p, 'superAdmin');
    return id;
  };

test.describe('proposing a commission change', () => {
  test('SUBMITTING CHANGES NOTHING, and records the comparison', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const made: Made = { deals: [] };
    try {
      const { id } = await deal(page, made);
      const before = await figures(page, id);

      /*
       * THE SEEDED DOCUMENTATION ACCOUNT, not a mocked payload. The submit is a real POST, and the
       * workflow refuses a Super Admin — a mocked role would leave an admin's session behind the
       * request and the server would turn it down for the right reason at the wrong moment.
       */
      await page.context().clearCookies();
      await signIn(page, 'docs');
      await openFinancial(page, id);

      await page.getByTestId('request-commission-change').click();
      await expect(page.getByTestId('commission-change-dialog')).toBeVisible();
      // The dialog shows what the figure is now, beside where the new one goes.
      await expect(page.getByTestId('current-comm_pct')).toHaveText('2.5');

      await page.getByTestId('proposed-comm_pct').fill('3');
      await page.getByTestId('commission-change-reason').fill('Brokerage agreed 3% with the builder');
      await page.getByTestId('commission-change-submit').click();
      await expect(page.getByTestId('commission-change-dialog')).toHaveCount(0, { timeout: 15_000 });

      // THE DEAL IS UNTOUCHED — the whole promise of a proposal.
      expect(await figures(page, id)).toEqual(before);

      const open = (await requests(page, id)).filter((r) => r.scope === 'commission');
      expect(open).toHaveLength(1);
      expect(open[0].status).toBe('pending');
      expect(open[0].proposed).toMatchObject({ comm_pct: 3 });
      expect(open[0].baseline).toMatchObject({ comm_pct: 2.5 });
      expect(open[0].reason).toContain('agreed 3%');
    } finally {
      await page.context().clearCookies();
      await signIn(page, 'superAdmin');
      await cleanUp(page, made);
    }
  });

  test('APPROVAL APPLIES THE NEW FIGURE; REJECTION LEAVES IT ALONE', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const made: Made = { deals: [] };
    try {
      // --- rejected first, on its own deal
      const rejected = await deal(page, made);
      const beforeRejected = await figures(page, rejected.id);
      let reqId = await raise(page, rejected.id, { comm_pct: 4 }, 'no');
      expect((await apiSend(page, 'POST', `/api/edit-requests/${reqId}/reject`)).status).toBe(200);
      expect(await figures(page, rejected.id)).toEqual(beforeRejected);

      // --- approved, on another
      const approved = await deal(page, made);
      reqId = await raise(page, approved.id, { comm_pct: 3, comm_amt: 15000 }, 'yes');
      expect((await apiSend(page, 'POST', `/api/edit-requests/${reqId}/approve`)).status).toBe(200);

      // Applied, not merely unlocked.
      expect(await figures(page, approved.id)).toMatchObject({ comm_pct: 3, comm_amt: 15000 });
    } finally {
      await cleanUp(page, made);
    }
  });

  test('A STALE PROPOSAL IS REFUSED and the newer figure survives', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const made: Made = { deals: [] };
    try {
      const { id } = await deal(page, made);
      const reqId = await raise(page, id, { comm_pct: 3 }, 'from 2.5');

      // Somebody changes it in the meantime.
      await apiSend(page, 'PUT', `/api/transactions/${id}`, { comm_pct: 2.75 });

      const approve = await apiSend(page, 'POST', `/api/edit-requests/${reqId}/approve`);
      expect(approve.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(approve.body)).toMatch(/changed since/i);

      // The newer value stands, and the request is still waiting rather than reading as decided.
      expect((await figures(page, id)).comm_pct).toBe(2.75);
      expect((await requests(page, id)).find((r) => r.id === reqId)?.status).toBe('pending');
    } finally {
      await cleanUp(page, made);
    }
  });

  test('a second proposal on the same deal is refused while one is open', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const made: Made = { deals: [] };
    try {
      const { id } = await deal(page, made);
      await raise(page, id, { comm_pct: 3 }, 'first');
      await page.context().clearCookies();
      await signIn(page, 'admin');
      const again = await apiSend(page, 'POST', `/api/transactions/${id}/edit-requests`, {
        reason: 'second', scope: 'commission', proposed: { comm_pct: 4 },
      });
      expect(again.status).toBeGreaterThanOrEqual(400);
      await page.context().clearCookies();
      await signIn(page, 'superAdmin');
      expect((await requests(page, id)).filter((r) => r.scope === 'commission' && r.status === 'pending')).toHaveLength(1);
    } finally {
      await cleanUp(page, made);
    }
  });

  test('ACCOUNTING IS NOT OFFERED THE BUTTON — it reads the figures, it does not propose', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const made: Made = { deals: [] };
    try {
      const { id } = await deal(page, made);
      await page.route('**/api/user', async (route) => {
        const real = await route.fetch();
        const u = await real.json() as Record<string, unknown>;
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({
            ...u, role: 'accounting', is_admin: false, is_super_admin: false, is_admin_or_above: false,
            permissions: { ...(u.permissions as Record<string, string>), transactions: 'edit' },
          }),
        });
      });
      await openFinancial(page, id);

      await expect(page.getByTestId('fin-readonly-banner')).toHaveText('View');
      await expect(page.getByTestId('request-commission-change')).toHaveCount(0);
    } finally {
      await page.unroute('**/api/user');
      await cleanUp(page, made);
    }
  });

  test('a Super Admin has no need of it, and is not offered it either', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const made: Made = { deals: [] };
    try {
      const { id } = await deal(page, made);
      await openFinancial(page, id);
      await expect(page.getByTestId('request-commission-change')).toHaveCount(0);
    } finally {
      await cleanUp(page, made);
    }
  });
});

test.describe('Basic Info is closed to Documentation', () => {
  test('THE SERVER DROPS IT, even from a hand-made request', async ({ page }) => {
    /*
     * The seeded Documentation account, not a mocked payload: this is about what the API accepts,
     * and a mocked payload leaves an admin's session behind the request.
     */
    await signIn(page, 'superAdmin');
    const made: Made = { deals: [] };
    try {
      const { id, property } = await deal(page, made);

      await page.context().clearCookies();
      await signIn(page, 'docs');

      const res = await apiSend(page, 'PUT', `/api/transactions/${id}`, {
        property: 'ZZ HIJACKED ADDRESS', price: 999999, type: 'Residential Selling',
      });
      // Accepted as a request — the keys are simply dropped — but nothing moved.
      expect(res.status).toBeLessThan(500);

      await page.context().clearCookies();
      await signIn(page, 'superAdmin');
      const r = await apiGet(page, `/api/transactions/${id}`);
      const d = ((r.body as { data?: Record<string, unknown> }).data ?? r.body) as Record<string, unknown>;
      expect(d.property).toBe(property);
      expect(Number(d.price)).toBe(500000);
      expect(d.type).toBe('Residential Buying');
    } finally {
      await page.context().clearCookies();
      await signIn(page, 'superAdmin');
      await cleanUp(page, made);
    }
  });

  test('THE UI OFFERS NO BASIC INFO FIELD, even with ?mode=edit', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const made: Made = { deals: [] };
    try {
      const { id } = await deal(page, made);
      await asDocumentation(page);
      await page.goto(`/desk/transactions/${id}?mode=edit`);

      const card = page.locator('.card').filter({ hasText: 'Basic Info' }).first();
      await expect(card).toBeVisible({ timeout: 15_000 });

      // Nothing inside that card accepts input. `:disabled` rather than the IDL property, which
      // reads false for a control inheriting from a disabled ancestor.
      const editable = await card.evaluate((el) => {
        const f = [...el.querySelectorAll('input, select, textarea')] as HTMLInputElement[];
        return f.filter((x) => !x.matches(':disabled') && !x.readOnly).length;
      });
      expect(editable).toBe(0);
    } finally {
      await page.unroute('**/api/user');
      await cleanUp(page, made);
    }
  });

  test('a Super Admin in edit mode still edits Basic Info', async ({ page }) => {
    // The control group: the lock is this role's, not a general regression.
    await signIn(page, 'superAdmin');
    const made: Made = { deals: [] };
    try {
      const { id } = await deal(page, made);
      await page.goto(`/desk/transactions/${id}?mode=edit`);
      const card = page.locator('.card').filter({ hasText: 'Basic Info' }).first();
      await expect(card).toBeVisible({ timeout: 15_000 });

      const editable = await card.evaluate((el) => {
        const f = [...el.querySelectorAll('input, select, textarea')] as HTMLInputElement[];
        return f.filter((x) => !x.matches(':disabled') && !x.readOnly).length;
      });
      expect(editable).toBeGreaterThan(0);
    } finally {
      await cleanUp(page, made);
    }
  });

  test('Documentation keeps its other sections', async ({ page }) => {
    // Conditions, clients, brokerage and statuses are still this role's job — only Basic Info went.
    await signIn(page, 'superAdmin');
    const made: Made = { deals: [] };
    try {
      const { id } = await deal(page, made);

      await page.context().clearCookies();
      await signIn(page, 'docs');
      const res = await apiSend(page, 'PUT', `/api/transactions/${id}`, {
        clients: [{ name: 'ZZ Client One', email: 'zz-client@probe.test' }],
      });
      expect(res.status).toBeLessThan(400);

      const r = await apiGet(page, `/api/transactions/${id}`);
      const d = ((r.body as { data?: Record<string, unknown> }).data ?? r.body) as Record<string, unknown>;
      expect(JSON.stringify(d.clients ?? [])).toContain('ZZ Client One');
    } finally {
      await page.context().clearCookies();
      await signIn(page, 'superAdmin');
      await cleanUp(page, made);
    }
  });
});
