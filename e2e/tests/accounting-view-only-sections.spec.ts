import { test, expect, type Page } from '@playwright/test';
import { signIn, signOut, apiGet, apiSend, ACCOUNTS } from './helpers';

/**
 * ACCOUNTING: BASIC INFO, FINANCIAL AND DOCUMENTS ARE VIEW-ONLY (brokerage request, 2026-10-13).
 *
 * Both halves: the screen offers nothing to change, and the server drops Basic Info and Financial
 * keys from this role's saves (ACCOUNTING_LOCKED) and refuses every document write
 * (AccountingReadOnlyGuard). The rest of the role's work on a deal is untouched — a field it owns
 * still saves in the same request.
 */

async function createDeal(page: Page): Promise<number> {
  const created = await apiSend(page, 'POST', '/api/transactions', {
    type: 'Residential Buying',
    property: 'ZZ-ACCTVIEW Ledger Road',
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

const readDeal = async (page: Page, id: number): Promise<Record<string, unknown>> => {
  const r = await apiGet(page, `/api/transactions/${id}`);
  expect(r.status).toBe(200);
  const b = r.body as { data?: Record<string, unknown> };
  return b.data ?? (r.body as Record<string, unknown>);
};
const num = (v: unknown) => Number(v ?? 0);
const day = (v: unknown) => String(v ?? '').slice(0, 10);

async function asAccounting(page: Page, fn: (id: number) => Promise<void>) {
  await signIn(page, 'superAdmin');
  const id = await createDeal(page);
  try {
    await signOut(page);
    await signIn(page, 'accounting');
    await fn(id);
  } finally {
    await signOut(page);
    await signIn(page, 'superAdmin');
    await apiSend(page, 'DELETE', `/api/transactions/${id}`).catch(() => undefined);
  }
}

test.describe('the server', () => {
  test('DROPS BASIC INFO AND FINANCIAL FROM AN ACCOUNTING SAVE, and keeps what this role owns', async ({ page }) => {
    await asAccounting(page, async (id) => {
      const res = await apiSend(page, 'PUT', `/api/transactions/${id}`, {
        // Basic Info
        property: 'ZZ-ACCTVIEW SHOULD NOT CHANGE', type: 'Residential Selling',
        price: 610000, deposit: 41000, closing_date: '2027-01-15',
        // Financial
        comm_pct: 9.9, comm_amt: 99999, comm_adjust_enabled: true, comm_adjust_before: 1234,
        // Owned by this role — must still land.
        comm_paid_status: 'Yes',
      });
      expect(res.status).toBeLessThan(300);

      const after = await readDeal(page, id);
      expect(after.property).toBe('ZZ-ACCTVIEW Ledger Road');
      expect(after.type).toBe('Residential Buying');
      expect(num(after.price)).toBe(500000);
      expect(num(after.deposit)).toBe(20000);
      expect(day(after.closing_date)).toBe('2026-11-28');
      expect(num(after.comm_pct)).toBe(2.5);
      expect(after.comm_adjust_enabled).toBeFalsy();
      expect(after.comm_paid_status).toBe('Yes');
    });
  });

  test('REFUSES EVERY DOCUMENT WRITE, and still serves the list', async ({ page }) => {
    await asAccounting(page, async (id) => {
      const list = await apiGet(page, `/api/transactions/${id}/documents`);
      expect(list.status).toBe(200);
      const write = await apiSend(page, 'PUT', `/api/transactions/${id}/documents`, { documents: [] });
      expect(write.status).toBe(403);
      const remind = await apiSend(page, 'POST', `/api/transactions/${id}/documents/send-reminders`, {});
      expect(remind.status).toBe(403);
    });
  });

  test('OTHER ROLES ARE UNCHANGED — an Admin still edits Basic Info', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const id = await createDeal(page);
    try {
      await apiSend(page, 'PUT', `/api/transactions/${id}`, { property: 'ZZ-ACCTVIEW Admin Edit' });
      expect((await readDeal(page, id)).property).toBe('ZZ-ACCTVIEW Admin Edit');
      const docs = await apiSend(page, 'POST', `/api/transactions/${id}/documents/send-reminders`, {});
      expect(docs.status).not.toBe(403);
    } finally {
      await apiSend(page, 'DELETE', `/api/transactions/${id}`).catch(() => undefined);
    }
  });
});

test.describe('the screen, in Edit mode', () => {
  test('BASIC INFO IS READ-ONLY for Accounting', async ({ page }) => {
    await asAccounting(page, async (id) => {
      await page.goto(`/desk/transactions/${id}?mode=edit`);
      await expect(page.getByRole('button', { name: /^Back$/ })).toBeVisible({ timeout: 20_000 });
      const field = (label: string) => page.locator('.field', { has: page.locator('label', { hasText: new RegExp(`^${label}`) }) }).first();
      await expect(field('Property Address').locator('input')).toBeDisabled();
      await expect(field('Type').locator('select')).toBeDisabled();
      await expect(field('Closing Date').locator('input')).toBeDisabled();
      await expect(field('Offer Date').locator('input')).toBeDisabled();
      // The Documentation-only closing-date request is not offered here.
      await expect(page.getByTestId('closing-date-edit')).toHaveCount(0);
    });
  });

  test('DOCUMENTS ARE VIEW-ONLY for Accounting — no Save, and the banner says so', async ({ page }) => {
    await asAccounting(page, async (id) => {
      await page.goto(`/desk/transactions/${id}?mode=edit`);
      await expect(page.getByRole('button', { name: /^Back$/ })).toBeVisible({ timeout: 20_000 });
      await page.getByRole('button', { name: /^Documents$/ }).first().click();
      const modal = page.locator('.modal', { hasText: 'Track receipt' }).first();
      await expect(modal).toBeVisible({ timeout: 15_000 });
      await expect(modal.getByTestId('docs-readonly-banner')).toContainText('viewed and downloaded, not changed');
      await expect(modal.getByRole('button', { name: /^Save$/ })).toHaveCount(0);
    });
  });
});
