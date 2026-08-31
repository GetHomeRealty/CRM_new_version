import { test, expect, type Page } from '@playwright/test';
import { signIn } from './helpers';

/**
 * CRM-032 (1, 3 and 4): wording that agrees with itself and with what the system did.
 *
 * THREE OF THE FOUR ARE ON THIS SCREEN, and one of them is not really a grammar slip:
 *
 *   1. "1 recipient MATCH this segment" — written only in the plural.
 *   3. A CANCELLED campaign's card read "2 sent to · 0 delivered". Nothing went to anybody; 2 was
 *      the audience it was holding when it was stood down. That states the opposite of what
 *      happened, on a card somebody might read as evidence that a mailing they stopped went out.
 *   4. "Delivered" claims a receipt this system has never had. SMTP accepts a message; it does not
 *      confirm arrival. Bounces are tracked separately, so "Sent" beside "Bounced" is honest and
 *      "Delivered" is a stronger claim than the data supports.
 *
 * THE STATE IS STUBBED because these depend on a campaign never having been sent, and on an
 * audience of exactly one — neither of which the seeded database can be relied on to provide, and
 * a test that only ran when the data happened to suit would prove nothing.
 */

const stats = { total: 1, sent: 0, failed: 0, opened: 0, unsubscribed: 0, bounced: 0 };

/** A campaign that was stood down before it went: an audience, and no `sent_at`. */
const cancelled = {
  id: 990101, name: 'ZZ-WORDING-CANCELLED', template_id: null, template_name: 'Template',
  category: null, status: 'draft', tags: [], stats, created_by: 'Tester',
  created_at: '2026-08-29T09:00:00.000Z', scheduled_for: null, sent_at: null,
};

/** One that really did go out, where "sent to" is the truth. */
const completed = {
  ...cancelled, id: 990102, name: 'ZZ-WORDING-COMPLETED', status: 'completed',
  stats: { ...stats, sent: 1 }, sent_at: '2026-08-29T09:05:00.000Z',
};

async function withCampaigns(page: Page, rows: unknown[]): Promise<void> {
  await page.route('**/api/campaigns', (r) => (r.request().method() === 'GET'
    ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) })
    : r.fallback()));
}

test.describe('the campaigns screen says what actually happened', () => {
  test('a campaign that was never sent does not claim it was', async ({ page }) => {
    await signIn(page, 'admin');
    await withCampaigns(page, [cancelled]);
    await page.goto('/crm/campaigns');

    const card = page.locator('.camp-stats').first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    // THE DEFECT: this read "1 sent to" for a mailing that reached nobody.
    await expect(card).toContainText('1 recipient');
    await expect(card).not.toContainText('sent to');
  });

  test('a sent campaign reports its audience and what actually went, separately', async ({ page }) => {
    /*
     * THIS ASSERTION WAS REVERSED ON PURPOSE, and it is worth saying why rather than quietly
     * editing it. It used to require that a SENT campaign still read "sent to", which made the
     * CRM-032 fix conditional on `sent_at`.
     *
     * CRM-038 showed that was only half right. `stats.total` is the AUDIENCE whether or not
     * anything was sent, so a half-failed mailing of a hundred read "100 sent to · 60 delivered"
     * when forty never left — the same lie as the draft case, just harder to spot. Naming the
     * audience an audience is correct in every state and needs no condition, so "sent to" is gone
     * from the card entirely and the sent figure stands under the word "sent".
     */
    await signIn(page, 'admin');
    await withCampaigns(page, [completed]);
    await page.goto('/crm/campaigns');

    const card = page.locator('.camp-stats').first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText('1 recipient');
    await expect(card).toContainText('1 sent');
    await expect(card).not.toContainText('sent to');
    await expect(card).not.toContainText('delivered');
  });

  test('a half-failed send does not claim the whole audience was mailed', async ({ page }) => {
    // The case that made the conditional fix insufficient: forty of a hundred never left.
    await signIn(page, 'admin');
    await withCampaigns(page, [{
      ...completed, id: 990103, name: 'ZZ-WORDING-PARTIAL', status: 'partial',
      stats: { total: 100, sent: 60, failed: 40, opened: 0, unsubscribed: 0, bounced: 0 },
    }]);
    await page.goto('/crm/campaigns');

    const card = page.locator('.camp-stats').first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText('100 recipients');
    await expect(card).toContainText('60 sent');
    // "100 sent to" would say every one of them was mailed.
    await expect(card).not.toContainText('100 sent to');
  });

  test('one recipient matches, rather than match', async ({ page }) => {
    await signIn(page, 'admin');
    await page.route('**/api/campaigns/preview', (r) => r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ count: 1, sample: [{ name: 'One Person', email: 'one@probe.invalid' }] }),
    }));
    await page.goto('/crm/campaigns');
    await page.getByRole('button', { name: /Create Campaign/i }).first().click();

    await expect(page.getByText(/1\s*recipient matches this segment/i)).toBeVisible({ timeout: 10_000 });
  });

  test('several recipients match, rather than matches', async ({ page }) => {
    await signIn(page, 'admin');
    await page.route('**/api/campaigns/preview', (r) => r.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ count: 3, sample: [] }),
    }));
    await page.goto('/crm/campaigns');
    await page.getByRole('button', { name: /Create Campaign/i }).first().click();

    await expect(page.getByText(/3\s*recipients match this segment/i)).toBeVisible({ timeout: 10_000 });
  });

  test('the results tile says Sent, which is what the system knows', async ({ page }) => {
    await signIn(page, 'admin');
    await withCampaigns(page, [completed]);
    await page.route(`**/api/campaigns/${completed.id}`, (r) => r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ...completed, subject: 'ZZ', content: '<p>x</p>', audience: {}, recipients: [] }),
    }));
    await page.goto('/crm/campaigns');
    await page.getByRole('button', { name: /View results/i }).first().click();

    const tiles = page.locator('.camp-tiles');
    await expect(tiles).toBeVisible({ timeout: 10_000 });
    await expect(tiles).toContainText('Sent');
    // "Delivered" would claim a receipt SMTP never gives.
    await expect(tiles).not.toContainText('Delivered');
  });
});
