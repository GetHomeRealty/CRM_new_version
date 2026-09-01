import { test, expect, type Page } from '@playwright/test';
import { signIn } from './helpers';

/**
 * CRM-002, second half: an open figure must say when it was never measured.
 *
 * THE CONFIG HALF OF CRM-002 WAS FIXED and is not what this covers. `CAMPAIGN_PUBLIC_URL` was
 * unset, so tracking pixels pointed somewhere recipients could not reach; that was corrected on
 * 2026-08-27. What was never addressed is the tester's own note on the same defect: "the campaign
 * reports do not carry the same warning". The banner said tracking was broken and the cards, tiles
 * and CSV went on printing open counts as though they were results.
 *
 * WHY A ZERO IS THE DANGEROUS CASE. Tracking can only ever UNDERCOUNT - a recorded open really
 * happened - so the numbers are a floor rather than a fiction. But a floor of zero reads as
 * "nobody opened it", which is a verdict on the template, when it actually means "we did not
 * measure". Those two lead to opposite decisions.
 *
 * THE HEALTH RESPONSE IS STUBBED rather than driven by server configuration. The rule under test is
 * presentational - given this health verdict, does the figure carry its caveat - and stubbing is
 * what makes all three verdicts (broken, working, UNKNOWN) reachable in one run without touching
 * the environment. The third is the interesting one: a failed health check is not evidence of a
 * fault, and must not be reported as one.
 */

const HEALTH = '**/api/campaigns/tracking-health';

const stats = { total: 10, sent: 10, failed: 0, opened: 0, unsubscribed: 0, bounced: 0 };
const summary = {
  id: 990001, name: 'ZZ-TRACKING-CAVEAT', template_id: null, template_name: 'Template',
  category: null, status: 'completed', tags: [], stats, created_by: 'Tester',
  created_at: '2026-08-29T09:00:00.000Z', scheduled_for: null, sent_at: '2026-08-29T09:05:00.000Z',
};
const detail = {
  ...summary, subject: 'A subject', content: '<p>hi</p>', audience: {},
  recipients: [{
    id: 1, name: 'Someone', email: 'someone@probe.test', status: 'sent',
    opened: false, unsubscribed: false, bounced: false, bounce_type: null, error: null,
  }],
};

/** Serve one campaign and one health verdict, so the assertion is about presentation only. */
async function withHealth(page: Page, health: unknown | 'fail'): Promise<void> {
  await page.route(HEALTH, async (route) => (
    health === 'fail'
      ? route.abort()
      : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(health) })
  ));
  await page.route('**/api/campaigns', async (route) => (
    route.request().method() === 'GET'
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([summary]) })
      : route.fallback()
  ));
  await page.route('**/api/campaigns/990001', async (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(detail),
  }));
}

const BROKEN = {
  ok: false, url: null, ephemeral: false, reachable: false,
  checked_at: '2026-08-29T09:00:00.000Z', reason: 'CAMPAIGN_PUBLIC_URL is not set.',
};
const WORKING = {
  ok: true, url: 'https://crm.example.test', ephemeral: false, insecure: false,
  reachable: true, status: 200, checked_at: '2026-08-29T09:00:00.000Z', reason: 'Reachable.',
};

test.describe('open figures say when they were not measured', () => {
  test('the card marks the count, and the detail explains it', async ({ page }) => {
    await signIn(page, 'admin');
    await withHealth(page, BROKEN);
    await page.goto('/crm/campaigns');

    const card = page.getByText('ZZ-TRACKING-CAVEAT').first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/not measured/i).first()).toBeVisible();

    await page.getByRole('button', { name: /View results/i }).first().click();
    // Repeated inside the modal, which opens from a notification link without passing the banner.
    await expect(page.getByText(/Open tracking is not working/i).last()).toBeVisible();
    await expect(page.getByText(/minimum, not a result/i)).toBeVisible();
    // The TILE specifically - the card behind the modal carries the same words.
    await expect(page.getByRole('button', { name: 'Opened (not measured)' })).toBeVisible();
  });

  test('says nothing when tracking is working', async ({ page }) => {
    await signIn(page, 'admin');
    await withHealth(page, WORKING);
    await page.goto('/crm/campaigns');

    await expect(page.getByText('ZZ-TRACKING-CAVEAT').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/not measured/i)).toHaveCount(0);

    await page.getByRole('button', { name: /View results/i }).first().click();
    await expect(page.getByText(/minimum, not a result/i)).toHaveCount(0);
  });

  test('claims nothing when the health check itself could not be reached', async ({ page }) => {
    // "We could not ask" is not "it is broken". Warning here would be its own false report.
    await signIn(page, 'admin');
    await withHealth(page, 'fail');
    await page.goto('/crm/campaigns');

    await expect(page.getByText('ZZ-TRACKING-CAVEAT').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/not measured/i)).toHaveCount(0);
  });
});
