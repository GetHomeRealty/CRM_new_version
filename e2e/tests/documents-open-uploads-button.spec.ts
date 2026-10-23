import { test, expect } from '@playwright/test';
import { signIn, signOut, apiSend, ACCOUNTS } from './helpers';

/**
 * MULTI-FILE AND PER-CLIENT DOCUMENTS SHOW AN UPLOAD BUTTON (2026-10-19, brokerage request).
 *
 * Their uploads live inside the row, behind the small arrow by the title, and the Upload column only
 * said "Multiple files" / "Per-client uploads" — so a Documentation user read those rows as having
 * no upload at all. The Upload column is now a button that opens the row.
 */

test('a Documentation user opens Deposit Receipt, Client Photo ID and FINTRAC from the Upload column', async ({ page }) => {
  await signIn(page, 'superAdmin');
  const created = await apiSend(page, 'POST', '/api/transactions', {
    type: 'Residential Lease',
    property: 'ZZ-DOCUPLOAD 335 Button Road',
    status: 'Secured Firm',
    price: 2900,
    deposit: 5800,
    comm_type: '%',
    comm_value: 50,
    offer_date: '2026-08-30',
    closing_date: '2026-10-01',
    primary_agent: ACCOUNTS.agent.name,
    clients: [{ name: 'ZZ Client One', type: 'Tenant' }],
  });
  expect(created.status).toBe(201);
  const id = (created.body as { data: { id: number } }).data.id;

  try {
    await signOut(page);
    await signIn(page, 'docs');
    await page.goto(`/desk/transactions/${id}?mode=view`);
    await page.getByRole('button', { name: /^Documents$/ }).first().click();

    const row = (title: RegExp) => page.locator('.doc-row').filter({ hasText: title }).first();

    // Deposit Receipt — several files: the button opens the row on "+ Add File".
    const deposit = row(/Deposit Receipt/);
    await expect(deposit).toBeVisible({ timeout: 15_000 });
    await deposit.getByTestId('doc-open-uploads').click();
    await expect(deposit.getByText('+ Add File')).toBeVisible();
    await expect(deposit.getByTestId('doc-open-uploads')).toHaveText(/Hide/);

    // Client Photo ID — one upload per client.
    const photo = row(/Client Photo ID/i);
    await expect(photo.getByTestId('doc-open-uploads')).toHaveText(/Upload per client/);
    await photo.getByTestId('doc-open-uploads').click();
    await expect(photo.getByText(/by Client/)).toBeVisible();

    // FINTRAC — a Form 630 per client, not a file, and the button says so.
    const fintrac = row(/Fintrac/i);
    await expect(fintrac.getByTestId('doc-open-uploads')).toHaveText(/Form 630 per client/);
  } finally {
    await signOut(page);
    await signIn(page, 'superAdmin');
    await apiSend(page, 'DELETE', `/api/transactions/${id}`).catch(() => undefined);
  }
});
