import { test, expect } from '@playwright/test';
import { signIn, apiGet, ACCOUNTS } from './helpers';

/**
 * ACCOUNTING GETS THE USERS MODULE AS A SUPER ADMIN HAS IT (2026-10-21): in the sidebar, the page
 * opens, the whole list loads. Documentation, which was not given it, still does not see it.
 */

test('Accounting sees Users in the sidebar and the full list loads', async ({ page }) => {
  await signIn(page, 'accounting');
  await page.goto('/desk/dashboard');
  const nav = page.getByRole('link', { name: /^Users$/ });
  await expect(nav.first()).toBeVisible({ timeout: 20_000 });
  await nav.first().click();
  await expect(page).toHaveURL(/\/desk\/users/);
  await expect(page.getByText('No access')).toHaveCount(0);
  // The whole table, not a Team Lead's slice: another role's account is in it.
  await expect(page.getByText(ACCOUNTS.docs.name).first()).toBeVisible({ timeout: 20_000 });
  const api = await apiGet(page, '/api/users');
  expect(api.status).toBe(200);
});

test('Documentation still does not get Users', async ({ page }) => {
  await signIn(page, 'docs');
  await page.goto('/desk/dashboard');
  await expect(page.getByRole('link', { name: /^Transactions$/ }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('link', { name: /^Users$/ })).toHaveCount(0);
  expect((await apiGet(page, '/api/users')).status).toBe(403);
});
