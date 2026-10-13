import { test, expect, type Page } from '@playwright/test';
import { signIn, signOut, apiGet, apiSend, ACCOUNTS } from './helpers';

/**
 * DOCUMENTATION MAY CORRECT PRICE AND DEPOSIT, AND NOTHING ELSE ON THE FINANCIAL PANEL.
 *
 * WHY THIS EXISTS. Commit af89621 made every Transaction Quick Action strictly view-only for this
 * role. The brokerage then asked, on 2026-10-13, for the two figures a deal is priced from to come
 * back — a coordinator correcting a typo in a price should not need an Admin.
 *
 * WHERE THE LINE IS. `price` and `deposit` were added to `DOCUMENTATION_EDITABLE`; the commission
 * percentages and amounts, the flat fees, every adjustment, the trust settlement and the `team`
 * splits were not. The screen additionally sends ONLY those two keys for this role, so it does not
 * even ask about the rest — but these tests send the rest deliberately, because the filter is the
 * thing that has to hold when the screen is not the client.
 *
 * THE LIMITATION, STATED RATHER THAN IMPLIED. A field is permitted or it is not: there is no way
 * to permit one "only from the Financial screen", because a request does not say which screen sent
 * it. The Basic Info card still renders Price and Deposit read-only for this role, and that is now
 * presentation rather than enforcement. The brokerage chose this shape knowing it.
 *
 * NOTHING IS BYPASSED. A test below proves a Price save by this role does NOT spend an approved
 * financial edit request belonging to somebody else, and another proves the commission-change
 * approval workflow still runs.
 */

async function createDeal(page: Page): Promise<number> {
  const created = await apiSend(page, 'POST', '/api/transactions', {
    type: 'Residential Buying',
    property: 'ZZ-DOCPRICE Financial Road',
    status: 'Secured Firm',
    price: 500000,
    deposit: 20000,
    comm_type: '%',
    comm_value: 2.5,
    comm_pct: 2.5,
    offer_date: '2026-09-01',
    closing_date: '2026-11-28',
    primary_agent: ACCOUNTS.agent.name,
  });
  expect(created.status).toBe(201);
  return (created.body as { data: { id: number } }).data.id;
}

const removeDeal = (page: Page, id: number) =>
  apiSend(page, 'DELETE', `/api/transactions/${id}`).catch(() => undefined);

const readDeal = async (page: Page, id: number): Promise<Record<string, unknown>> => {
  const r = await apiGet(page, `/api/transactions/${id}`);
  expect(r.status).toBe(200);
  const b = r.body as { data?: Record<string, unknown> };
  return b.data ?? (r.body as Record<string, unknown>);
};

const num = (v: unknown) => Number(v ?? 0);

/** Run `fn` as the Documentation seat against a freshly created deal, then clean up. */
async function asDocumentation(page: Page, fn: (id: number) => Promise<void>) {
  await signIn(page, 'superAdmin');
  const id = await createDeal(page);
  try {
    await signOut(page);
    await signIn(page, 'docs');
    await fn(id);
  } finally {
    await signOut(page);
    await signIn(page, 'superAdmin');
    await removeDeal(page, id);
  }
}

// =====================================================================================
test.describe('the two figures this role may correct', () => {
  test('CAN SAVE PRICE, and it persists', async ({ page }) => {
    await asDocumentation(page, async (id) => {
      const res = await apiSend(page, 'PUT', `/api/transactions/${id}`, { price: 575000 });
      expect(res.status).toBeLessThan(300);
      expect(num((await readDeal(page, id)).price)).toBe(575000);
    });
  });

  test('CAN SAVE DEPOSIT, and it persists', async ({ page }) => {
    await asDocumentation(page, async (id) => {
      const res = await apiSend(page, 'PUT', `/api/transactions/${id}`, { deposit: 35000 });
      expect(res.status).toBeLessThan(300);
      expect(num((await readDeal(page, id)).deposit)).toBe(35000);
    });
  });

  test('CAN SAVE BOTH AT ONCE, which is what the screen sends', async ({ page }) => {
    await asDocumentation(page, async (id) => {
      await apiSend(page, 'PUT', `/api/transactions/${id}`, { price: 610000, deposit: 41000 });
      const after = await readDeal(page, id);
      expect(num(after.price)).toBe(610000);
      expect(num(after.deposit)).toBe(41000);
    });
  });
});

// =====================================================================================
test.describe('everything else on the panel is still refused', () => {
  test('CANNOT CHANGE THE COMMISSION PERCENTAGE OR AMOUNT, even sent alongside a legitimate price', async ({ page }) => {
    /*
     * THE CASE THAT MATTERS MOST. The filter drops what it does not permit rather than refusing the
     * whole request, so a payload mixing one allowed field with several forbidden ones succeeds —
     * and must succeed having applied ONLY the allowed one. A test that sent the forbidden fields
     * alone would pass against a server that refused everything and prove nothing about the mix.
     */
    await asDocumentation(page, async (id) => {
      const before = await readDeal(page, id);

      const res = await apiSend(page, 'PUT', `/api/transactions/${id}`, {
        price: 560000,
        comm_pct: 9.9,
        comm_amt: 99999,
        comm_adjust_enabled: true,
        comm_adjust_before: 1234,
      });
      expect(res.status).toBeLessThan(300);

      const after = await readDeal(page, id);
      // The allowed field landed.
      expect(num(after.price)).toBe(560000);
      // None of the money fields moved.
      expect(num(after.comm_pct)).toBe(num(before.comm_pct));
      expect(num(after.comm_amt)).toBe(num(before.comm_amt));
      expect(after.comm_adjust_enabled).toEqual(before.comm_adjust_enabled);
      expect(num(after.comm_adjust_before)).toBe(num(before.comm_adjust_before));
    });
  });

  test('CANNOT CHANGE THE AGENT SPLITS through the same payload', async ({ page }) => {
    await asDocumentation(page, async (id) => {
      const before = await readDeal(page, id);
      await apiSend(page, 'PUT', `/api/transactions/${id}`, {
        price: 545000,
        team: [{ name: ACCOUNTS.agent.name, split: 10, agent_pct: 10, brok_pct: 90, is_primary: true }],
      });
      const after = await readDeal(page, id);
      expect(num(after.price)).toBe(545000);
      expect(JSON.stringify(after.team ?? [])).toBe(JSON.stringify(before.team ?? []));
    });
  });

  test('CANNOT CHANGE THE REST OF BASIC INFO — the 2026-10-12 rule still holds for those fields', async ({ page }) => {
    // Price and Deposit are the only two exceptions. Status, Type, Agent, Property and the dates
    // stay withheld, and this is the test that says so for the role rather than for the set.
    await asDocumentation(page, async (id) => {
      const before = await readDeal(page, id);
      await apiSend(page, 'PUT', `/api/transactions/${id}`, {
        price: 530000,
        property: 'ZZ-DOCPRICE SHOULD NOT CHANGE',
        type: 'Residential Selling',
      });
      const after = await readDeal(page, id);
      expect(num(after.price)).toBe(530000);
      expect(after.property).toBe(before.property);
      expect(after.type).toBe(before.type);
    });
  });
});

// =====================================================================================
test.describe('no approval rule is bypassed', () => {
  test('A PRICE SAVE DOES NOT SPEND SOMEBODY ELSE\'S APPROVED FINANCIAL UNLOCK', async ({ page }) => {
    /*
     * An approved `financial` request is a one-shot unlock: somebody asked, a Super Admin
     * approved, and the first financial save retires it. This role writes price and deposit by
     * allow-list and never holds such an unlock — so a coordinator correcting a price must not
     * spend one granted to an Admin who has not used it. The Admin would otherwise find the fields
     * locked again, the request marked `applied`, and nothing to explain it.
     */
    await signIn(page, 'superAdmin');
    const id = await createDeal(page);
    try {
      // An Admin asks; a Super Admin approves.
      await signOut(page);
      await signIn(page, 'admin');
      const asked = await apiSend(page, 'POST', `/api/transactions/${id}/edit-requests`, {
        reason: 'ZZ-DOCPRICE financial unlock', scope: 'financial',
      });
      test.skip(asked.status >= 300, `this seat cannot raise a financial request here (${asked.status})`);
      const reqId = ((asked.body as { data?: { id?: number } }).data?.id
        ?? (asked.body as { id?: number }).id) as number;

      await signOut(page);
      await signIn(page, 'superAdmin');
      const approved = await apiSend(page, 'POST', `/api/edit-requests/${reqId}/approve`, {});
      test.skip(approved.status >= 300, `could not approve (${approved.status})`);

      // Now the coordinator corrects a price.
      await signOut(page);
      await signIn(page, 'docs');
      await apiSend(page, 'PUT', `/api/transactions/${id}`, { price: 599000 });

      // The price changed; the unlock did NOT get spent.
      await signOut(page);
      await signIn(page, 'superAdmin');
      const after = await readDeal(page, id);
      expect(num(after.price)).toBe(599000);
      const reqs = (after.edit_requests ?? []) as { id: number; status: string; scope: string | null }[];
      const mine = reqs.find((r) => r.id === reqId);
      expect(mine?.status).toBe('approved');
    } finally {
      await removeDeal(page, id);
    }
  });

  test('THE COMMISSION CHANGE REQUEST WORKFLOW STILL RUNS for this role', async ({ page }) => {
    // Requirement 4: after correcting a price, the coordinator must still be able to ASK for the
    // commission to be changed. Asking is not editing, and it is this role's authorized route.
    await asDocumentation(page, async (id) => {
      await apiSend(page, 'PUT', `/api/transactions/${id}`, { price: 585000 });

      const asked = await apiSend(page, 'POST', `/api/transactions/${id}/edit-requests`, {
        reason: 'ZZ-DOCPRICE commission follows the new price',
        scope: 'commission',
        proposed: { comm_value: 2.75 },
      });
      expect(asked.status).not.toBe(403);
    });
  });
});

// =====================================================================================
test.describe('the screen shows exactly which two fields are live', () => {
  test('PRICE AND DEPOSIT ARE INPUTS, the rest of the panel is read-only text', async ({ page }) => {
    await asDocumentation(page, async (id) => {
      await page.goto(`/desk/transactions/${id}`);
      await expect(page.getByRole('button', { name: /^Back$/ })).toBeVisible({ timeout: 20_000 });
      await page.getByRole('button', { name: /^Financial$/i }).first().click();

      const modal = page.locator('.modal').first();
      await expect(modal).toBeVisible({ timeout: 15_000 });
      await expect(modal.getByTestId('fin-price')).toBeEditable();
      await expect(modal.getByTestId('fin-deposit')).toBeEditable();
      await expect(modal.getByTestId('fin-save')).toBeVisible();

      // Exactly two, so a third editable field appearing here fails rather than slipping in.
      const editable = await modal.evaluate((el) => [...el.querySelectorAll('input, select, textarea')]
        .filter((f) => !f.matches(':disabled') && !(f as HTMLInputElement).readOnly).length);
      expect(editable).toBe(2);

      // The authorized ask is still offered.
      await expect(modal.getByRole('button', { name: /Request Commission Change/i })).toBeVisible();
    });
  });

  test('SAVING FROM THE SCREEN PERSISTS BOTH FIGURES', async ({ page }) => {
    await asDocumentation(page, async (id) => {
      await page.goto(`/desk/transactions/${id}`);
      await expect(page.getByRole('button', { name: /^Back$/ })).toBeVisible({ timeout: 20_000 });
      await page.getByRole('button', { name: /^Financial$/i }).first().click();
      const modal = page.locator('.modal').first();
      await expect(modal).toBeVisible({ timeout: 15_000 });

      await modal.getByTestId('fin-price').fill('642000');
      await modal.getByTestId('fin-deposit').fill('31000');
      await modal.getByTestId('fin-save').click();
      await expect(modal.getByTestId('fin-save')).toContainText(/Saved|Save/, { timeout: 15_000 });

      const after = await readDeal(page, id);
      expect(num(after.price)).toBe(642000);
      expect(num(after.deposit)).toBe(31000);
    });
  });
});

// =====================================================================================
test.describe('other roles are unchanged', () => {
  test('AN ADMIN\'S PRICE IS STILL LOCKED IN FINANCIAL, as it was before this change', async ({ page }) => {
    /*
     * `finLock` is `!isSuperAdmin && !approvedFinReq` and was not touched. The Documentation
     * exception is additive, so an Admin's Financial panel behaves exactly as it did — which is
     * the requirement, and the thing an over-broad change would have quietly broken.
     */
    await signIn(page, 'superAdmin');
    const id = await createDeal(page);
    try {
      await signOut(page);
      await signIn(page, 'admin');
      await page.goto(`/desk/transactions/${id}?mode=edit`);
      await expect(page.getByRole('button', { name: /^Back$/ })).toBeVisible({ timeout: 20_000 });

      const button = page.getByRole('button', { name: /^Financial$/i }).first();
      test.skip(!(await button.count()), 'Financial is not offered to this seat on this deal');
      await button.click();
      const modal = page.locator('.modal').first();
      await expect(modal).toBeVisible({ timeout: 15_000 });

      await expect(modal.getByTestId('fin-price')).not.toBeEditable();
      // And no flattening class: this panel is a form for this role, not a record.
      await expect(modal).not.toHaveClass(/view-flat/);
    } finally {
      await signOut(page);
      await signIn(page, 'superAdmin');
      await removeDeal(page, id);
    }
  });

  test('AN ACCOUNTING USER STILL HAS NO EDITABLE FIELD HERE', async ({ page }) => {
    // Accounting shares `readsOnly` with Documentation and is deliberately NOT included in the
    // exception: it reads these figures and does not set them.
    await signIn(page, 'superAdmin');
    const id = await createDeal(page);
    try {
      await signOut(page);
      await signIn(page, 'accounting');
      await page.goto(`/desk/transactions/${id}`);
      await expect(page.getByRole('button', { name: /^Back$/ })).toBeVisible({ timeout: 20_000 });

      const button = page.getByRole('button', { name: /^Financial$/i }).first();
      test.skip(!(await button.count()), 'Financial is not offered to this seat on this deal');
      await button.click();
      const modal = page.locator('.modal').first();
      await expect(modal).toBeVisible({ timeout: 15_000 });

      const editable = await modal.evaluate((el) => [...el.querySelectorAll('input, select, textarea')]
        .filter((f) => !f.matches(':disabled') && !(f as HTMLInputElement).readOnly).length);
      expect(editable).toBe(0);
    } finally {
      await signOut(page);
      await signIn(page, 'superAdmin');
      await removeDeal(page, id);
    }
  });

  /*
   * A GAP FOUND WHILE WRITING THIS FILE, DELIBERATELY NOT TESTED AND NOT FIXED HERE.
   *
   * This file originally asserted that an Accounting user cannot write `price` through the API.
   * That assertion FAILED: Accounting can. The write service has field filters for exactly two
   * roles — `isAgent` (AGENT_LOCKED) and `documentation` (DOCUMENTATION_EDITABLE) — and none for
   * Accounting, so its read-only Financial panel is enforced in the browser only. `git show HEAD`
   * confirms that was already true before any of today's work; it is not a regression.
   *
   * IT IS LEFT ALONE ON PURPOSE. Closing it means giving Accounting a server-side allow-list,
   * which changes what that role can do — and the brief for this change says to preserve
   * Accounting's existing behaviour. It is reported instead, so somebody can decide.
   *
   * NO TEST ASSERTS THE CURRENT BEHAVIOUR EITHER, because a test saying "Accounting may rewrite
   * the price" would cement a defect and fail the day it is fixed. The browser-level assertion
   * above — that Accounting has no editable field on this panel — is the part worth holding.
   */
});
