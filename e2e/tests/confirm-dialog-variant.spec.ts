import { test, expect, type Page } from '@playwright/test';
import { signIn, apiSend } from './helpers';

/**
 * CRM-030: the confirmation button's colour has to mean something.
 *
 * THE DEFECT. The shared `ConfirmDialog` painted its affirmative button red whatever the action was,
 * so "Confirm Send" on a campaign looked exactly like "Delete Forever" on a lead. A warning colour
 * used for everything is not a warning colour: it teaches people that red simply means "the button
 * you press to continue", which is the state in which they stop reading the dialog at all.
 *
 * WHY DESTRUCTIVE IS THE DEFAULT. Three dozen call sites use this component and most of them really
 * are deletes. Defaulting the other way would have silently de-emphasised every existing warning in
 * the product to fix the two that were over-emphasised - a far worse trade. Non-destructive callers
 * opt in, so no existing dialog changed.
 *
 * THE ASSERTION IS ON `data-variant` AND THE COMPUTED COLOUR TOGETHER. The attribute alone could be
 * right while the styling was not wired to it; the colour alone is brittle across themes. Together
 * they say the intent is declared AND honoured.
 */

const confirmButton = (page: Page) => page.locator('.modal .actions button[data-variant]');

/** The background the browser actually paints, so the test cannot pass on intent alone. */
async function background(page: Page): Promise<string> {
  return confirmButton(page).evaluate((el) => getComputedStyle(el).backgroundColor);
}

const unique = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test.describe('the confirm button says what kind of action it is', () => {
  test('a destructive action is red', async ({ page }) => {
    await signIn(page, 'admin');
    const tag = unique('ZZ-VARIANT');
    await apiSend(page, 'POST', '/api/leads/tags', { tag });

    try {
      await page.goto('/crm/lead');
      await page.getByRole('button', { name: /^Tags/ }).first().click();
      const row = page.locator('.modal').filter({ hasText: 'Lead Tags' }).locator('li').filter({ hasText: tag });
      await expect(row).toBeVisible({ timeout: 10_000 });
      await row.getByRole('button', { name: /^Delete$/ }).click();

      await expect(confirmButton(page)).toHaveAttribute('data-variant', 'destructive');
      // rgb(220, 38, 38) is --bad. Asserted as a real paint, not as a class name.
      expect(await background(page)).toBe('rgb(220, 38, 38)');
    } finally {
      await apiSend(page, 'DELETE', `/api/leads/tags?tag=${encodeURIComponent(tag)}`).catch(() => undefined);
    }
  });

  test('the recycle bin purge stays red', async ({ page }) => {
    // The most destructive control in the module. If anything kept its warning colour, this must.
    await signIn(page, 'admin');
    const name = unique('ZZ-VARIANT-PURGE');
    const created = await apiSend(page, 'POST', '/api/leads', { name, email: `${name.toLowerCase()}@probe.test` });
    const id = (created.body as { id: number }).id;
    await apiSend(page, 'DELETE', `/api/leads/${id}`);

    try {
      await page.goto('/crm/lead');
      await page.getByRole('button', { name: /Recently Deleted/i }).click();
      await page.getByLabel('Search deleted leads').fill(name);
      await expect(page.getByRole('cell', { name, exact: true })).toBeVisible({ timeout: 10_000 });
      await page.getByRole('button', { name: /Delete Forever/i }).first().click();

      await expect(confirmButton(page)).toHaveAttribute('data-variant', 'destructive');
      expect(await background(page)).toBe('rgb(220, 38, 38)');
    } finally {
      await apiSend(page, 'DELETE', `/api/leads/deleted/${id}`).catch(() => undefined);
    }
  });

  test('sending a campaign is NOT red', async ({ page }) => {
    await signIn(page, 'admin');
    /*
     * CLEANED UP AT THE END. The first version of this test left its template behind, and the
     * campaign confirmation suite - which picks the last template in the list - then asserted
     * against THIS one's subject and failed. Litter from one spec surfacing as a failure in another
     * is the most expensive kind of test debt.
     */
    const tpl = await apiSend(page, 'POST', '/api/campaigns/templates', {
      name: unique('ZZ-VARIANT-TPL'), subject: 'ZZ variant subject', content: '<p>ZZ</p>', category: 'custom',
    });
    const tplId = (tpl.body as { id?: number }).id;

    await page.route('**/api/campaigns', (r) => (r.request().method() === 'POST' ? r.abort() : r.fallback()));
    await page.goto('/crm/campaigns');
    await page.getByRole('button', { name: /Create Campaign/i }).first().click();
    await expect(page.getByText(/recipients? match this segment/i)).toBeVisible({ timeout: 10_000 });

    await page.getByPlaceholder(/market update/i).fill(unique('ZZ-VARIANT-CAMP'));
    const template = page.locator('select').filter({ hasText: 'Choose a template to send' }).first();
    const values = await template.locator('option').evaluateAll(
      (o) => o.map((x) => (x as HTMLOptionElement).value).filter((v) => v !== ''),
    );
    await template.selectOption(values[values.length - 1]);
    const everyone = page.getByRole('checkbox');
    if (await everyone.count()) await everyone.first().check();

    await page.getByRole('button', { name: /^(Send to|Schedule for)\s+\d+/ }).click();

    // THE DEFECT: this button was the same red as Delete Forever.
    await expect(confirmButton(page)).toHaveAttribute('data-variant', 'primary');
    expect(await background(page)).not.toBe('rgb(220, 38, 38)');

    await apiSend(page, 'DELETE', `/api/campaigns/templates/${tplId}`).catch(() => undefined);
  });
});
