import { test, expect, type Page } from '@playwright/test';
import { signIn, apiSend, apiGet } from './helpers';

/**
 * CRM-033: reopening a lead must not invent a stage.
 *
 * THE DEFECT. The row handler read `lead.lead_status === 'closed' ? 'hot' : 'closed'` — a
 * hard-coded literal. So a Cold lead closed and reopened came back HOT: it promoted itself to the
 * top of the list an agent works first, silently, pushing a genuinely hot lead below it. Stage is
 * what a brokerage plans its week from, and a wrong stage is worse than an absent one because it
 * gets acted upon.
 *
 * IT WAS ALSO UNRECOVERABLE when the audit filed it, because a lead field edit left no trace. That
 * is no longer true — per-field before/after is recorded (CRM-006) — which is what makes offering
 * the real previous stage possible rather than needing a new column.
 *
 * TWO CASES, AND BOTH MATTER. A lead closed since that recording began has a knowable previous
 * stage and it is offered. A lead closed BEFORE it does not, and the screen asks instead of
 * guessing — which is the honest answer, and the one the old code refused to give.
 */

const unique = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const created: { page: Page; id: number }[] = [];

test.afterEach(async () => {
  while (created.length) {
    const l = created.pop()!;
    await apiSend(l.page, 'DELETE', `/api/leads/${l.id}`).catch(() => undefined);
  }
});

async function makeLead(page: Page, status: string): Promise<{ id: number; name: string }> {
  // NOT "ZZ-REOPEN": buttons carry the lead name in their accessible label ("View <name>"), so a
  // name containing "reopen" makes /Reopen/i match several controls in the same row.
  const name = unique('ZZ-STAGE');
  const res = await apiSend(page, 'POST', '/api/leads', {
    name, email: `${name.toLowerCase()}@probe.invalid`, phone: '4165550000', lead_status: status,
  });
  expect([200, 201]).toContain(res.status);
  const id = (res.body as { id: number }).id;
  created.push({ page, id });
  return { id, name };
}

const rowFor = (page: Page, name: string) => page.locator('tr').filter({ hasText: name });

async function openList(page: Page, name: string): Promise<void> {
  await page.goto(`/crm/lead?search=${encodeURIComponent(name)}`);
  await expect(rowFor(page, name).first()).toBeVisible({ timeout: 10_000 });
}

test.describe('reopening a lead restores the stage it had', () => {
  test('the previous stage is remembered and offered', async ({ page }) => {
    await signIn(page, 'admin');
    const lead = await makeLead(page, 'cold');

    // Close it through the same endpoint the row button uses, so the history is written the same way.
    await apiSend(page, 'PUT', `/api/leads/${lead.id}`, { lead_status: 'closed' });

    const prev = await apiGet(page, `/api/leads/${lead.id}/previous-status`);
    expect(prev.status).toBe(200);
    // THE DEFECT: nothing remembered this, and reopening hard-coded 'hot'.
    expect((prev.body as { status: string | null }).status).toBe('cold');
  });

  test('reopening asks, and restores what was remembered', async ({ page }) => {
    await signIn(page, 'admin');
    const lead = await makeLead(page, 'cold');
    await apiSend(page, 'PUT', `/api/leads/${lead.id}`, { lead_status: 'closed' });

    await openList(page, lead.name);
    await rowFor(page, lead.name).first().getByRole('button', { name: /Reopen/i }).click();

    const dialog = page.locator('.modal').filter({ hasText: `Reopen ${lead.name}?` });
    await expect(dialog).toContainText('It was cold when it was closed');
    await expect(dialog.getByLabel('Reopen at stage')).toHaveValue('cold');

    await dialog.getByRole('button', { name: /Reopen lead/i }).click();

    await expect.poll(async () => {
      const after = await apiGet(page, `/api/leads/${lead.id}`);
      return (after.body as { lead_status: string }).lead_status;
    }, { timeout: 10_000 }).toBe('cold');
  });

  test('a different stage can be chosen', async ({ page }) => {
    // The remembered stage is an offer, not a decision — the lead may genuinely have warmed up.
    await signIn(page, 'admin');
    const lead = await makeLead(page, 'cold');
    await apiSend(page, 'PUT', `/api/leads/${lead.id}`, { lead_status: 'closed' });

    await openList(page, lead.name);
    await rowFor(page, lead.name).first().getByRole('button', { name: /Reopen/i }).click();

    const dialog = page.locator('.modal').filter({ hasText: `Reopen ${lead.name}?` });
    await dialog.getByLabel('Reopen at stage').selectOption('warm');
    await dialog.getByRole('button', { name: /Reopen lead/i }).click();

    await expect.poll(async () => {
      const after = await apiGet(page, `/api/leads/${lead.id}`);
      return (after.body as { lead_status: string }).lead_status;
    }, { timeout: 10_000 }).toBe('warm');
  });

  test('cancelling leaves the lead closed', async ({ page }) => {
    await signIn(page, 'admin');
    const lead = await makeLead(page, 'cold');
    await apiSend(page, 'PUT', `/api/leads/${lead.id}`, { lead_status: 'closed' });

    await openList(page, lead.name);
    await rowFor(page, lead.name).first().getByRole('button', { name: /Reopen/i }).click();
    await page.locator('.modal').filter({ hasText: `Reopen ${lead.name}?` })
      .getByRole('button', { name: /^Cancel$/ }).click();

    const after = await apiGet(page, `/api/leads/${lead.id}`);
    expect((after.body as { lead_status: string }).lead_status).toBe('closed');
  });

  test('closing is still one click and still works', async ({ page }) => {
    // Closing is reversible and loses nothing, so it was left alone.
    await signIn(page, 'admin');
    const lead = await makeLead(page, 'warm');

    await openList(page, lead.name);
    await rowFor(page, lead.name).first().getByRole('button', { name: /^Close$/ }).click();

    await expect.poll(async () => {
      const after = await apiGet(page, `/api/leads/${lead.id}`);
      return (after.body as { lead_status: string }).lead_status;
    }, { timeout: 10_000 }).toBe('closed');
  });
});
