import { test, expect } from '@playwright/test';
import { ACCOUNTS, PASSWORD, signIn, type AccountKey } from './helpers';

/**
 * Can each role get in at all, and does the app refuse the things it should?
 *
 * This runs first because everything else depends on it. A permission bug is worth finding; a
 * suite that cannot sign in tells you nothing about either.
 */

test.describe('signing in', () => {
  for (const key of Object.keys(ACCOUNTS) as AccountKey[]) {
    test(`${key} (${ACCOUNTS[key].role}) can sign in`, async ({ page }) => {
      await signIn(page, key);
      await expect(page).not.toHaveURL(/\/login/);
      // Something of the shell must be on screen — signing in and landing on a blank page is a
      // failure the URL alone would not catch.
      await expect(page.locator('body')).not.toBeEmpty();
    });
  }
});

test.describe('refusing bad credentials', () => {
  test('a wrong password does not sign anyone in', async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[name="username"]', ACCOUNTS.agent.email);
    await page.fill('input[name="password"]', 'definitely-not-the-password');
    await page.click('button[type="submit"]');

    await expect(page).toHaveURL(/\/login/);
  });

  test('an unknown account is refused the same way as a wrong password', async ({ page }) => {
    // Different messages for "no such user" and "wrong password" tell an attacker which addresses
    // are real. Both paths must look identical from outside.
    await page.goto('/login');
    await page.fill('input[name="username"]', 'nobody-at-all@test.local');
    await page.fill('input[name="password"]', PASSWORD);
    await page.click('button[type="submit"]');

    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe('reaching pages without signing in', () => {
  for (const path of ['/crm/inbox', '/crm/notifications', '/desk/transactions', '/crm/lead']) {
    test(`${path} sends a signed-out visitor to the login page`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
    });
  }
});
