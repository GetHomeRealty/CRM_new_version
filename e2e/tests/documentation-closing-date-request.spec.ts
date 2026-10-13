import { test, expect, type Page } from '@playwright/test';
import { signIn, signOut, apiGet, apiSend, ACCOUNTS } from './helpers';

/**
 * DOCUMENTATION REQUESTS A NEW CLOSING DATE; A SUPER ADMIN APPROVES IT.
 *
 * Basic Info stays read-only for this role. The one addition is a pencil beside Closing Date that
 * opens a request dialog (scope 'closing_date'). Nothing changes until a Super Admin approves, and
 * approval applies the date. A direct write of the date by this role is still dropped.
 */

async function createDeal(page: Page): Promise<number> {
  const created = await apiSend(page, 'POST', '/api/transactions', {
    type: 'Residential Buying',
    property: 'ZZ-DOCDATE Closing Road',
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
const day = (v: unknown) => String(v ?? '').slice(0, 10);

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

test('A DIRECT WRITE OF THE CLOSING DATE BY THIS ROLE IS STILL DROPPED', async ({ page }) => {
  await asDocumentation(page, async (id) => {
    await apiSend(page, 'PUT', `/api/transactions/${id}`, { closing_date: '2027-01-15' });
    expect(day((await readDeal(page, id)).closing_date)).toBe('2026-11-28');
  });
});

test('THE PENCIL SENDS A REQUEST; NOTHING MOVES UNTIL A SUPER ADMIN APPROVES', async ({ page }) => {
  await asDocumentation(page, async (id) => {
    await page.goto(`/desk/transactions/${id}`);
    await expect(page.getByRole('button', { name: /^Back$/ })).toBeVisible({ timeout: 20_000 });

    await page.getByTestId('closing-date-edit').click();
    const dialog = page.getByTestId('closing-date-request-dialog');
    // On screen, over the page — not merely present somewhere in the document.
    await expect(dialog).toBeInViewport();
    await dialog.getByTestId('closing-date-new').fill('2027-01-15');
    await dialog.getByTestId('closing-date-reason').fill('ZZ-DOCDATE builder extended closing');
    await dialog.getByTestId('closing-date-submit').click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // Pending: the pencil is disabled and the deal still has the old date.
    await expect(page.getByTestId('closing-date-edit')).toBeDisabled({ timeout: 15_000 });
    const pending = await readDeal(page, id);
    expect(day(pending.closing_date)).toBe('2026-11-28');
    const req = ((pending.edit_requests ?? []) as { id: number; status: string; scope: string | null }[])
      .find((r) => r.scope === 'closing_date' && r.status === 'pending');
    expect(req).toBeTruthy();

    await signOut(page);
    await signIn(page, 'superAdmin');
    const approved = await apiSend(page, 'POST', `/api/edit-requests/${req!.id}/approve`, {});
    expect(approved.status).toBeLessThan(300);
    expect(day((await readDeal(page, id)).closing_date)).toBe('2027-01-15');
  });
});

test('THE REST OF BASIC INFO IS STILL READ-ONLY for this role', async ({ page }) => {
  await asDocumentation(page, async (id) => {
    await page.goto(`/desk/transactions/${id}`);
    await expect(page.getByRole('button', { name: /^Back$/ })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('closing-date-edit')).toBeVisible();
    // The date input itself is not unlocked by the pencil — the request goes through the dialog.
    const closing = page.locator('.field', { hasText: 'Closing Date' }).first().locator('input[type="date"]');
    await expect(closing).toBeDisabled();
  });
});

test('OTHER ROLES SEE NO CLOSING DATE PENCIL', async ({ page }) => {
  await signIn(page, 'superAdmin');
  const id = await createDeal(page);
  try {
    await page.goto(`/desk/transactions/${id}`);
    await expect(page.getByRole('button', { name: /^Back$/ })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('closing-date-edit')).toHaveCount(0);
  } finally {
    await apiSend(page, 'DELETE', `/api/transactions/${id}`).catch(() => undefined);
  }
});
