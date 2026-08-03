import { test, expect } from '@playwright/test';
import { signIn, apiGet } from './helpers';

/**
 * Notification Preferences.
 *
 * The behaviour worth protecting here is the honesty of the screen: a category nothing sends must
 * not present a working switch, and one that does must actually persist.
 */

/**
 * Put every switchable category back on before each test.
 *
 * These tests store real opt-outs, and an opt-out outlives the test that made it — so without
 * this the second run of the suite fails on assertions that passed the first time, which reads as
 * a broken application rather than a dirty database. Done through the UI on purpose: it is the
 * same path a user takes, so the reset cannot pass while the feature it relies on is broken.
 */
async function resetPreferences(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/crm/notifications');
  const switchable = page.locator('.crm-toggle input[type="checkbox"]:not([disabled])');
  await expect(switchable.first()).toBeVisible();

  let changed = false;
  for (let i = 0; i < await switchable.count(); i += 1) {
    if (!(await switchable.nth(i).isChecked())) { await switchable.nth(i).check(); changed = true; }
  }
  if (changed) {
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText(/saved/i)).toBeVisible({ timeout: 10_000 });
    await page.reload();
  }
}

test.beforeEach(async ({ page }) => {
  await signIn(page, 'agent');
  await resetPreferences(page);
});

const CATEGORIES = [
  'Calendar reminders', 'Listing expiry reminders', 'Lawyer detail reminders',
  'Document review updates', 'Transaction approvals', 'New inbox emails', 'Team chat mentions',
];

/** A settings row, by its label. Rows are matched rather than raw text because a badged row's
 *  heading reads "Listing expiry reminders Coming Soon" — an exact text match never hits it. */
const row = (page: import('@playwright/test').Page, label: string) =>
  page.locator('.crm-toggle').filter({ hasText: label });

test('lists every category', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Notification Preferences' })).toBeVisible();
  for (const label of CATEGORIES) {
    await expect(row(page, label)).toHaveCount(1);
  }
});

test('everything starts switched on', async ({ page }) => {
  // Absence of a stored row means enabled. Nobody's notifications may go quiet because this
  // feature shipped. `toHaveCount` first so the assertions below cannot run against a half-
  // rendered list — `count()` on its own does not wait for anything.
  const boxes = page.locator('.crm-toggle input[type="checkbox"]');
  await expect(boxes).toHaveCount(CATEGORIES.length);
  for (let i = 0; i < CATEGORIES.length; i += 1) await expect(boxes.nth(i)).toBeChecked();
});

test('categories with no push sender are disabled and badged Coming Soon', async ({ page }) => {
  // Six of the seven have no push sender. Asserting the exact number, not merely "more than
  // none": if one gains a sender the badge must come off, and this should fail until it does.
  const badged = page.locator('.crm-toggle').filter({ hasText: 'Coming Soon' });
  await expect(badged).toHaveCount(6);

  // Every badged row's control must be genuinely inoperable, not merely labelled. A control that
  // moves implies it did something.
  for (let i = 0; i < 6; i += 1) {
    await expect(badged.nth(i).locator('input[type="checkbox"]')).toBeDisabled();
  }
});

test('calendar reminders is the one category that can be changed', async ({ page }) => {
  const row = page.locator('.crm-toggle').filter({ hasText: 'Calendar reminders' });
  await expect(row.locator('input[type="checkbox"]')).toBeEnabled();
  await expect(row.getByText('Coming Soon')).toHaveCount(0);
});

test('an opt-out survives a reload', async ({ page }) => {
  const box = page.locator('.crm-toggle').filter({ hasText: 'Calendar reminders' }).locator('input');
  await box.uncheck();
  await page.getByRole('button', { name: 'Save changes' }).click();

  await expect(page.getByText(/saved/i)).toBeVisible({ timeout: 10_000 });

  await page.reload();
  await expect(page.locator('.crm-toggle').filter({ hasText: 'Calendar reminders' }).locator('input')).not.toBeChecked();

  // And the server agrees — the screen is not just remembering its own state.
  const res = await apiGet(page, '/api/account/notification-preferences');
  const cats = (res.body as { categories: { key: string; enabled: boolean }[] }).categories;
  expect(cats.find((c) => c.key === 'calendar_reminders')?.enabled).toBe(false);

  // Put it back, so the suite can be run repeatedly without hand-resetting the database.
  await page.locator('.crm-toggle').filter({ hasText: 'Calendar reminders' }).locator('input').check();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/saved/i)).toBeVisible({ timeout: 10_000 });
});

test('one person’s choices do not reach another’s', async ({ page, context }) => {
  await page.locator('.crm-toggle').filter({ hasText: 'Calendar reminders' }).locator('input').uncheck();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/saved/i)).toBeVisible({ timeout: 10_000 });

  await context.clearCookies();
  await signIn(page, 'agent2');
  const res = await apiGet(page, '/api/account/notification-preferences');
  const cats = (res.body as { categories: { key: string; enabled: boolean }[] }).categories;
  expect(cats.every((c) => c.enabled)).toBe(true);
});
