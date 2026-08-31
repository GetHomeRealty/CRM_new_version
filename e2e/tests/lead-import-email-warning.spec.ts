import { test, expect, type Page } from '@playwright/test';
import { signIn } from './helpers';

/**
 * CRM-024: the import window has to say it will email everybody in the file.
 *
 * THE MOST CONSEQUENTIAL THING IN THE ROUND, and not because anything is broken - because it works
 * silently, at a scale set by whoever picks the file, on real members of the public who have
 * consented to nothing. Import five hundred rows and the brokerage sends five hundred welcome
 * emails. The window described the file format; the report gave nine figures and never mentioned
 * email; and the sweep runs on a delay, so the operator was usually gone before the first send.
 *
 * WHY THE PREFLIGHT IS STUBBED HERE. Whether a welcome really leaves depends on four server-side
 * conditions, and this brokerage's seeded data may satisfy none of them - a test that only ran when
 * they happened to line up would be the vacuous kind that passed while checking nothing. The
 * agreement between the preflight and the actual send is asserted server-side in
 * `import-email-preflight.spec.ts`; what is asserted HERE is that the window acts on the answer.
 *
 * NOTHING IS IMPORTED. Every case stops at the button's state or blocks the request.
 */

const importModal = (page: Page) => page.locator('.modal').filter({ hasText: /Import Leads/i });
const importButton = (page: Page) => importModal(page).getByRole('button', { name: /^Import$/ });

const CSV = [
  'name,email',
  'ZZ One,zz-one@probe.invalid',
  'ZZ Two,zz-two@probe.invalid',
].join('\n');

async function openImport(page: Page, willEmail: boolean): Promise<void> {
  await page.route('**/api/leads/import/preflight', (r) => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ will_email: willEmail, reason: willEmail ? null : 'the welcome email is switched off' }),
  }));
  await page.goto('/crm/lead');
  await page.getByRole('button', { name: /Import/i }).first().click();
  await expect(importModal(page)).toBeVisible({ timeout: 10_000 });
}

/** Put a file in, the way a person does. */
async function attach(page: Page): Promise<void> {
  await importModal(page).locator('input[type="file"]').setInputFiles({
    name: 'zz-import.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV, 'utf8'),
  });
}

test.describe('importing warns that it emails everybody in the file', () => {
  test('says so, and will not import until it is acknowledged', async ({ page }) => {
    await signIn(page, 'admin');
    await openImport(page, true);
    await attach(page);

    await expect(importModal(page).getByText(/Everybody in this file will be emailed/i)).toBeVisible();
    // The count from the file, so the scale is stated rather than left to the imagination.
    await expect(importModal(page).getByText(/about 2 messages from this file/i)).toBeVisible();
    // THE DEFECT: this button was live with nothing said at all.
    await expect(importButton(page)).toBeDisabled();
  });

  test('acknowledging enables it, and un-acknowledging disables it again', async ({ page }) => {
    await signIn(page, 'admin');
    await openImport(page, true);
    await attach(page);

    const box = importModal(page).getByRole('checkbox');
    await box.check();
    await expect(importButton(page)).toBeEnabled();
    await box.uncheck();
    await expect(importButton(page)).toBeDisabled();
  });

  test('pressing Import anyway starts nothing', async ({ page }) => {
    const started: string[] = [];
    await page.route('**/api/leads/import', (r) => {
      if (r.request().method() === 'POST') { started.push(r.request().url()); return r.abort(); }
      return r.fallback();
    });

    await signIn(page, 'admin');
    await openImport(page, true);
    await attach(page);
    await importButton(page).click({ force: true, timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(800);

    expect(started).toEqual([]);
  });

  test('stays out of the way when nothing will be emailed', async ({ page }) => {
    /*
     * The case that keeps the warning worth reading. A brokerage with the welcome switched off, no
     * mailbox connected or the template disabled sends nothing on import, and a warning shown
     * anyway would be trained away within a week.
     */
    await signIn(page, 'admin');
    await openImport(page, false);
    await attach(page);

    await expect(importModal(page).getByText(/Everybody in this file will be emailed/i)).toHaveCount(0);
    await expect(importButton(page)).toBeEnabled();
  });
});
