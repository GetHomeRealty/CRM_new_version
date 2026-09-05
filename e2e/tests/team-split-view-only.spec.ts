import { expect, test } from '@playwright/test';
import { signIn, signOut, apiGet, apiSend, ACCOUNTS } from './helpers';

/**
 * TD-058 — a read-only transaction renders the Team Split read-only.
 *
 * THE DEFECT. In View Only the modal still accepted input: an agent could switch "Is this a Team
 * Split?" to Yes, set a Split % and watch the Total Split recalculate to 100.00% in green. There
 * was no Save button — closing threw it all away in silence, and re-opening showed "No" again with
 * no write ever attempted. Somebody could set up a commission split, believe it saved, and be
 * wrong.
 *
 * WHY THIS IS A BROWSER TEST. The fix is a disabled `<fieldset>` wrapping the form, and nothing
 * below the browser can tell you whether a control is actually inert. It is asserted here as the
 * user meets it: opened as the agent, on the agent's own deal, in View Only.
 *
 * A TRAP WORTH LEAVING WRITTEN DOWN. `select.disabled` is FALSE for a control inside a disabled
 * fieldset — the IDL property reflects the element's own attribute and not the inherited state.
 * Measuring that property alone reports this locked form as editable, which is exactly the wrong
 * answer. `:disabled` matches the real thing, and `toBeDisabled()` below is the same question asked
 * of the one control the defect was reported on.
 *
 * The deal is created for the run and deleted afterwards, so the suite leaves the database as it
 * found it.
 */

test('an agent in View Only cannot edit the Team Split, and is told why (TD-058)', async ({ page }) => {
  await signIn(page, 'superAdmin');
  const created = await apiSend(page, 'POST', '/api/transactions', {
    type: 'Residential Buying',
    property: 'ZZ-TEST Team Split View-Only Road',
    status: 'Secured Firm',
    price: 500000,
    comm_type: '%',
    comm_value: 2.5,
    offer_date: '2026-08-13',
    closing_date: '2026-09-30',
    primary_agent: ACCOUNTS.agent.name,
  });
  expect(created.status).toBe(201);
  const id = (created.body as { data: { id: number } }).data.id;

  try {
    await signOut(page);
    await signIn(page, 'agent');

    await page.goto(`/desk/transactions/${id}?mode=view`);
    await expect(page.getByText(/view only/i).first()).toBeVisible();

    await page.getByRole('button', { name: /team split/i }).first().click();
    const modal = page.locator('.modal').filter({ hasText: 'Team Split' }).first();
    await expect(modal).toBeVisible();

    // Every control in the modal, and how many of them actually accept input.
    const counts = await modal.evaluate((el) => {
      const fields = [...el.querySelectorAll('input, select, textarea')] as (HTMLInputElement | HTMLSelectElement)[];
      const editable = fields.filter((f) => !f.matches(':disabled') && !(f as HTMLInputElement).readOnly);
      return { total: fields.length, editable: editable.length };
    });
    expect(counts.total).toBeGreaterThan(0);
    expect(counts.editable).toBe(0);

    // The control the defect was reported on, asked directly.
    const isSplit = modal.locator('select').first();
    await expect(isSplit).toBeDisabled();
    await expect(isSplit).toHaveValue('No');

    // No Save — and the lock is explained rather than silent. The banner used to be hidden from
    // agents, which is the one role the defect was reported on.
    await expect(modal.getByRole('button', { name: /^save$/i })).toHaveCount(0);
    await expect(modal.getByText(/view-only|read-only/i)).toBeVisible();
  } finally {
    await signOut(page);
    await signIn(page, 'superAdmin');
    await apiSend(page, 'DELETE', `/api/transactions/${id}`);
  }
});
