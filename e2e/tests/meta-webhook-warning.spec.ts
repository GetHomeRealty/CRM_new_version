import { test, expect, type Page } from '@playwright/test';
import { signIn } from './helpers';

/**
 * CRM-007: a Meta connection that is healthy except for the part that matters must say so.
 *
 * WHAT IS NOT COVERED HERE. Why the webhook never fired is Meta-side configuration - the app
 * subscription, `META_PUBLIC_URL` being reachable from Facebook, and `pages_manage_ads` awaiting
 * App Review. No test can fix that, and the application already diagnoses it.
 *
 * WHAT IS COVERED is the reason it went unnoticed for the life of the integration. `/api/meta/
 * status` reports the CONNECTION - token valid, permissions granted, pages readable - and every one
 * of those was true while not a single lead had ever been delivered. The one endpoint that knew,
 * `/api/meta/webhook-health`, was consulted by a single component, which rendered its warning only
 * when `compact` was false - and the only mount of that component passes `compact`. The warning
 * existed, was correct, and could not be reached from anywhere in the running application.
 *
 * So the assertion is about REACHABILITY, not about the API: given a stalled webhook, does the
 * screen a person opens actually tell them. Both responses are stubbed so the healthy and stalled
 * cases are reachable without a Meta account or a live subscription.
 */

const STATUS = '**/api/meta/status';
const HEALTH = '**/api/meta/webhook-health*';

/** A connection that is green in every respect the status endpoint can see. */
const healthyStatus = {
  connected_forms: 1, token_expires_at: null, token_days_left: 40, token_expired: false,
  needs_reconnect: false, granted_scopes: [], missing_permissions: [], ad_account_id: null,
  ad_account_name: null, last_error: null, last_error_at: null, last_webhook_at: null,
  configured: true, token_storage_secure: true, redirect_uri: 'https://x.test/cb',
  oauth_strategy: 'config', has_login_config_id: true, is_connected: true,
  facebook_user_name: 'Test Account', pages_count: 4, page_name: 'A Page',
  connected_at: '2026-07-01T00:00:00.000Z', last_sync: '2026-08-29T07:12:31.000Z', leads_count: 1,
};

const STALLED = {
  total: 0, failed: 0, last_received_at: null, connected_forms: 1, events: [],
  stalled: true,
  stalled_reason: '1 form(s) are connected but no webhook delivery has ever been received. '
    + 'Check the subscription and that META_PUBLIC_URL is reachable from Meta.',
};
const FLOWING = {
  total: 12, failed: 0, last_received_at: '2026-08-29T09:00:00.000Z', connected_forms: 1,
  events: [], stalled: false, stalled_reason: null,
};

async function withMeta(page: Page, health: unknown): Promise<void> {
  await page.route(STATUS, (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(healthyStatus),
  }));
  await page.route(HEALTH, (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(health),
  }));
}

test.describe('a stalled Meta webhook is visible on the screen people open', () => {
  test('the Meta page says new leads are not being pushed', async ({ page }) => {
    await signIn(page, 'admin');
    await withMeta(page, STALLED);
    await page.goto('/crm/meta');

    // THE DEFECT: every one of these stayed green and nothing mentioned the webhook.
    await expect(page.getByText(/new leads are not being pushed/i)).toBeVisible({ timeout: 10_000 });
    // The API's own wording, shown rather than paraphrased into something vaguer.
    await expect(page.getByText(/no webhook delivery has ever been received/i)).toBeVisible();
    // And it must not read as data loss, because the sweep still collects them.
    await expect(page.getByText(/still collected by the scheduled sync/i)).toBeVisible();
  });

  test('says nothing when deliveries are arriving', async ({ page }) => {
    await signIn(page, 'admin');
    await withMeta(page, FLOWING);
    await page.goto('/crm/meta');

    await expect(page.getByText(/Connected/i).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/not being pushed/i)).toHaveCount(0);
  });

  test('the compact panel in CRM Settings shows it too', async ({ page }) => {
    // The mount that hid it. A summary may omit the event list; it may not omit the one signal
    // saying the integration is broken.
    await signIn(page, 'admin');
    await withMeta(page, STALLED);
    await page.goto('/crm/settings');

    await expect(page.getByText(/Connected, but nothing is arriving/i)).toBeVisible({ timeout: 15_000 });
  });
});
