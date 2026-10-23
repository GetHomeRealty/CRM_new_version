import { test, expect, type Page } from '@playwright/test';
import { signIn, signOut, apiGet, apiSend, ACCOUNTS } from './helpers';

/**
 * DOCUMENTATION AND BASIC INFO, SINCE 2026-10-19 (brokerage request).
 *
 * Agent Name and Property Address are this role's to edit directly, like Type and Status. Total
 * Price and Deposit stay locked, with a pencil beside each — the Basic Info twin of the Closing Date
 * pencil — that files a `commission`-scope request a Super Admin approves. Nothing moves until then.
 */

const PROPERTY = 'ZZ-DOCBASIC 335 Lease Road';

async function createDeal(page: Page): Promise<number> {
  const created = await apiSend(page, 'POST', '/api/transactions', {
    type: 'Residential Lease',
    property: PROPERTY,
    status: 'Secured Firm',
    price: 2900,
    deposit: 5800,
    comm_type: '%',
    comm_value: 50,
    comm_pct: 50,
    offer_date: '2026-08-30',
    closing_date: '2026-10-01',
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
    await apiSend(page, 'DELETE', `/api/transactions/${id}`).catch(() => undefined);
  }
}

const openEdit = async (page: Page, id: number) => {
  await page.goto(`/desk/transactions/${id}?mode=edit`);
  await expect(page.getByRole('button', { name: /^Back$/ })).toBeVisible({ timeout: 20_000 });
};
const fieldInput = (page: Page, label: string) =>
  page.locator('.field', { hasText: label }).first().locator('input').first();

test('A DIRECT WRITE OF AGENT AND ADDRESS BY THIS ROLE IS KEPT; PRICE AND DEPOSIT ARE STILL DROPPED', async ({ page }) => {
  await asDocumentation(page, async (id) => {
    const { version } = await readDeal(page, id) as { version?: number };
    await apiSend(page, 'PUT', `/api/transactions/${id}`, {
      property: `${PROPERTY} Unit 2`, agent: ACCOUNTS.superAdmin.name, price: 9999, deposit: 1, version,
    });
    const after = await readDeal(page, id);
    expect(after.property).toBe(`${PROPERTY} Unit 2`);
    expect(after.agent).toBe(ACCOUNTS.superAdmin.name);
    expect(Number(after.price)).toBe(2900);
    expect(Number(after.deposit)).toBe(5800);
  });
});

test('ON SCREEN: AGENT AND ADDRESS ARE EDITABLE, PRICE AND DEPOSIT ARE LOCKED WITH A PENCIL', async ({ page }) => {
  await asDocumentation(page, async (id) => {
    await openEdit(page, id);
    await expect(page.locator('.field', { hasText: 'Agent Name' }).first().locator('select')).toBeEnabled();
    await expect(fieldInput(page, 'Property Address')).toBeEnabled();
    await expect(fieldInput(page, 'Total lease price')).toBeDisabled();
    await expect(fieldInput(page, 'Deposit')).toBeDisabled();
    await expect(page.getByTestId('price-edit')).toBeVisible();
    await expect(page.getByTestId('deposit-edit')).toBeVisible();

    // Typing the address auto-saves it.
    await fieldInput(page, 'Property Address').fill(`${PROPERTY} Typed`);
    await expect.poll(async () => (await readDeal(page, id)).property, { timeout: 15_000 }).toBe(`${PROPERTY} Typed`);
  });
});

test('THE PENCIL SENDS A REQUEST; NOTHING MOVES UNTIL A SUPER ADMIN APPROVES', async ({ page }) => {
  await asDocumentation(page, async (id) => {
    await openEdit(page, id);
    await page.getByTestId('deposit-edit').click();
    const dialog = page.getByTestId('price-deposit-request-dialog');
    await expect(dialog).toBeInViewport();
    await dialog.getByTestId('price-request-new').fill('2950');
    await dialog.getByTestId('deposit-request-new').fill('5900');
    await dialog.getByTestId('price-deposit-reason').fill('ZZ-DOCBASIC amended lease');
    await dialog.getByTestId('price-deposit-submit').click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // Pending: both pencils are disabled and the deal still has the old figures.
    await expect(page.getByTestId('price-edit')).toBeDisabled({ timeout: 15_000 });
    await expect(page.getByTestId('deposit-edit')).toBeDisabled();
    const pending = await readDeal(page, id);
    expect(Number(pending.price)).toBe(2900);
    expect(Number(pending.deposit)).toBe(5800);
    const req = ((pending.edit_requests ?? []) as { id: number; status: string; scope: string | null; proposed?: Record<string, unknown> }[])
      .find((r) => r.scope === 'commission' && r.status === 'pending');
    expect(req).toBeTruthy();
    expect(req!.proposed).toEqual({ price: 2950, deposit: 5900 });

    await signOut(page);
    await signIn(page, 'superAdmin');
    const approved = await apiSend(page, 'POST', `/api/edit-requests/${req!.id}/approve`, {});
    expect(approved.status).toBeLessThan(300);
    const after = await readDeal(page, id);
    expect(Number(after.price)).toBe(2950);
    expect(Number(after.deposit)).toBe(5900);
  });
});

test('OTHER ROLES SEE NO PRICE OR DEPOSIT PENCIL', async ({ page }) => {
  await signIn(page, 'superAdmin');
  const id = await createDeal(page);
  try {
    await openEdit(page, id);
    await expect(page.getByTestId('price-edit')).toHaveCount(0);
    await expect(page.getByTestId('deposit-edit')).toHaveCount(0);
  } finally {
    await apiSend(page, 'DELETE', `/api/transactions/${id}`).catch(() => undefined);
  }
});
