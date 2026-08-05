import { test, expect } from '@playwright/test';
import { ACCOUNTS, PASSWORD } from './helpers';

/**
 * Sign-in matches the account case-insensitively.
 *
 * `users` carries functional unique indexes on `lower(email)` and `lower(username)`, and the Users
 * service compares both case-insensitively — so the application already treats two spellings as one
 * account. Sign-in was an exact match, which meant an address stored with a capital letter could not
 * be typed in lower case: the person got "the provided credentials are incorrect", and because that
 * is the wrong-password path it counted toward the lockout, so retrying locked them out of their
 * own account.
 *
 * Driven through the real form rather than the API, so the CSRF exchange and the session cookie are
 * exercised the way a person actually signs in.
 */
const SPELLINGS = [
  ACCOUNTS.agent.email,
  ACCOUNTS.agent.email.toUpperCase(),
  'Agent@Test.Local',
];

for (const spelling of SPELLINGS) {
  test(`signs in as "${spelling}"`, async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[name="username"]', spelling);
    await page.fill('input[name="password"]', PASSWORD);
    await page.click('button[type="submit"]');

    await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
  });
}

test('a genuinely wrong password is still refused', async ({ page }) => {
  // The counterpart, so the test above cannot pass by letting everything through.
  await page.goto('/login');
  await page.fill('input[name="username"]', ACCOUNTS.agent2.email);
  await page.fill('input[name="password"]', 'definitely-not-the-password');
  await page.click('button[type="submit"]');

  await expect(page).toHaveURL(/\/login/);
});
