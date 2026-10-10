import { test, expect, type Page } from '@playwright/test';
import { ACCOUNTS, apiSend, signIn } from './helpers';

/**
 * THE ACCOUNTING ROLE ON A TRANSACTION — what it reads, and what is not its job.
 *
 * Accounting works in Invoice and the money. On a deal it reads the commission figures rather than
 * setting them, and the closing paperwork — Notice of Sale, Trade Sheet — belongs to the people
 * running the deal. So Financial is view-only and says simply "View", and those three buttons are
 * not offered.
 *
 * THE ROLE IS MOCKED, as in the sibling Documentation specs: what is under test is a decision the
 * SPA makes from the user payload, so the payload is what the test hands it. `is_admin: false`
 * matters as much as the role — `can()` in AuthContext short-circuits to true for an admin — and
 * `transactions: 'edit'` is what Accounting genuinely holds, which is the point: this role CAN
 * edit a deal, and Financial still must not accept input from it.
 *
 * EVERY CLAIM IS PAIRED WITH A CONTROL. "Hidden for Accounting" is only correct if it is still
 * shown to somebody else, so each test has a Super Admin counterpart on the same deal.
 */

const uniq = (p: string) => `${p}${Date.now().toString().slice(-7)}${Math.floor(Math.random() * 1000)}`;

type Made = { deals: number[] };

async function deal(page: Page, made: Made): Promise<number> {
  const res = await apiSend(page, 'POST', '/api/transactions', {
    type: 'Residential Buying', property: uniq('ZZ-TEST Accounting Road '),
    status: 'Secured Firm', price: 700000, comm_type: '%', comm_value: 2.5,
    offer_date: '2026-08-13', closing_date: '2026-09-30', primary_agent: ACCOUNTS.agent.name,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const id = (res.body as { data: { id: number } }).data.id;
  made.deals.push(id);

  // A two-agent split, so the Financial modal renders the Agent Comm % controls at all. Without
  // it the "no lock controls" assertions would pass against a screen that never had any.
  const teamed = await apiSend(page, 'PUT', `/api/transactions/${id}`, {
    team: [
      { name: ACCOUNTS.agent.name, split: 60, agent_pct: 80, brok_pct: 20, is_primary: true },
      { name: ACCOUNTS.agent2.name, split: 40, agent_pct: 70, brok_pct: 30 },
    ],
  });
  expect(teamed.status).toBe(200);
  return id;
}

const cleanUp = async (page: Page, made: Made) => {
  for (const id of made.deals) await apiSend(page, 'DELETE', `/api/transactions/${id}`).catch(() => undefined);
  made.deals = [];
};

const asAccounting = (page: Page) => page.route('**/api/user', async (route) => {
  const real = await route.fetch();
  const u = await real.json() as Record<string, unknown>;
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ...u,
      role: 'accounting',
      is_admin: false,
      is_super_admin: false,
      is_admin_or_above: false,
      // What the role actually holds — including `transactions: 'edit'`.
      permissions: { ...(u.permissions as Record<string, string>), transactions: 'edit', invoice: 'edit' },
    }),
  });
});

async function openFinancial(page: Page, id: number): Promise<void> {
  await page.goto(`/desk/transactions/${id}?mode=view`);
  await page.getByRole('button', { name: /Financial/i }).first().click();
  await expect(page.getByText('Financial Information')).toBeVisible({ timeout: 15_000 });
}

/** Every lock, unlock and request-edit control the Financial modal can render. */
const LOCK_CONTROLS = /(Lock|Unlock to edit) (Agent Comm|Commission) %|request Super Admin approval to edit|Edit approval pending/;

test.describe('Financial information, for Accounting', () => {
  test('A SUPER ADMIN STILL SEES THE FULL BANNER AND THE CONTROLS', async ({ page }) => {
    // The control group, first: these controls exist on this deal for somebody.
    await signIn(page, 'superAdmin');
    const made: Made = { deals: [] };
    try {
      await openFinancial(page, await deal(page, made));
      const modal = page.locator('.modal.xl');

      await expect(modal.getByTestId('fin-readonly-banner')).toContainText('View-only');
      await expect(modal.getByTestId('fin-readonly-banner')).not.toHaveText('View');
      expect(await modal.getByTitle(LOCK_CONTROLS).count()).toBeGreaterThan(1);
    } finally {
      await cleanUp(page, made);
    }
  });

  test('ACCOUNTING SEES EXACTLY "View", AND NO LOCK OR EDIT CONTROLS', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const made: Made = { deals: [] };
    try {
      const id = await deal(page, made);
      await asAccounting(page);
      await openFinancial(page, id);
      const modal = page.locator('.modal.xl');

      await expect(modal.getByTestId('fin-readonly-banner')).toHaveText('View');

      // None of the wording that would suggest they can change or ask to change the figures.
      await expect(modal.getByText(/View-only — click/)).toHaveCount(0);
      await expect(modal.getByText(/fields are locked/)).toHaveCount(0);
      await expect(modal.getByText(/request Super Admin approval/)).toHaveCount(0);
      await expect(modal.getByText(/edit the fields and Save/)).toHaveCount(0);

      // And none of the controls, which the test above proved this deal renders for others.
      await expect(modal.getByTitle(LOCK_CONTROLS)).toHaveCount(0);

      // The padlock beside "Brok Comm (%)" is a decorative <svg>, so it is counted, not read.
      const brok = modal.locator('label', { hasText: 'Brok Comm (%)' });
      expect(await brok.count()).toBeGreaterThan(0);
      expect(await brok.locator('svg').count()).toBe(0);
    } finally {
      await page.unroute('**/api/user');
      await cleanUp(page, made);
    }
  });

  test('IT REMAINS GENUINELY READ-ONLY, even though Accounting may edit the deal', async ({ page }) => {
    /*
     * The assertion that matters most. Accounting holds `transactions: 'edit'`, so this role can
     * put the deal into edit mode — and the Financial section still must not accept input. Opened
     * in EDIT mode on purpose, which is the state that would have been editable before.
     */
    await signIn(page, 'superAdmin');
    const made: Made = { deals: [] };
    try {
      const id = await deal(page, made);
      await asAccounting(page);

      await page.goto(`/desk/transactions/${id}?mode=edit`);
      await page.getByRole('button', { name: /Financial/i }).first().click();
      await expect(page.getByText('Financial Information')).toBeVisible({ timeout: 15_000 });
      const modal = page.locator('.modal.xl');

      // Counted with `:disabled` rather than the IDL property, which reads false for a control
      // inheriting its disabled state from an ancestor fieldset.
      const editable = await modal.evaluate((el) => {
        const fields = [...el.querySelectorAll('input, select, textarea')] as HTMLInputElement[];
        return fields.filter((f) => !f.matches(':disabled') && !f.readOnly).length;
      });
      expect(editable).toBe(0);
      await expect(modal.getByTestId('fin-readonly-banner')).toHaveText('View');
      await expect(modal.getByRole('button', { name: /^save$/i })).toHaveCount(0);
    } finally {
      await page.unroute('**/api/user');
      await cleanUp(page, made);
    }
  });
});

test.describe('the three actions that are not Accounting\'s', () => {
  const ACTIONS = [
    { name: 'Notice of Sale', testid: 'txn-notice-of-sale-btn' },
    { name: 'Invoice', testid: 'txn-invoice-btn' },
    { name: 'Trade Sheet', testid: 'txn-trade-sheet-btn' },
  ] as const;

  test('A SUPER ADMIN IS OFFERED ALL THREE', async ({ page }) => {
    // The control group. If this fails the deal type stopped rendering them and the test below
    // proves nothing — fix the fixture, do not relax it.
    await signIn(page, 'superAdmin');
    const made: Made = { deals: [] };
    try {
      const id = await deal(page, made);
      await page.goto(`/desk/transactions/${id}?mode=view`);
      await expect(page.getByTestId(ACTIONS[0].testid)).toBeVisible({ timeout: 15_000 });
      for (const a of ACTIONS) await expect(page.getByTestId(a.testid)).toHaveCount(1);
    } finally {
      await cleanUp(page, made);
    }
  });

  test('ACCOUNTING IS OFFERED NONE OF THEM', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const made: Made = { deals: [] };
    try {
      const id = await deal(page, made);
      await asAccounting(page);
      await page.goto(`/desk/transactions/${id}?mode=view`);

      // Wait for the page itself, so "absent" is not merely "not rendered yet".
      await expect(page.getByRole('button', { name: /Financial/i }).first()).toBeVisible({ timeout: 15_000 });
      for (const a of ACTIONS) await expect(page.getByTestId(a.testid)).toHaveCount(0);
      // By name as well as by testid, so a renamed hook cannot hide a regression.
      for (const a of ACTIONS) await expect(page.getByRole('button', { name: new RegExp(a.name) })).toHaveCount(0);
    } finally {
      await page.unroute('**/api/user');
      await cleanUp(page, made);
    }
  });

  test('ACCOUNTING KEEPS ITS OTHER WORK ON THE DEAL', async ({ page }) => {
    // Only three buttons were taken away. The rest of the screen is unchanged for this role.
    await signIn(page, 'superAdmin');
    const made: Made = { deals: [] };
    try {
      const id = await deal(page, made);
      await asAccounting(page);
      await page.goto(`/desk/transactions/${id}?mode=view`);

      for (const name of [/Financial/i, /^Admin$/, /^Adjustment$/, /Agent Payment Readiness/]) {
        await expect(page.getByRole('button', { name }).first()).toBeVisible({ timeout: 15_000 });
      }
    } finally {
      await page.unroute('**/api/user');
      await cleanUp(page, made);
    }
  });
});
