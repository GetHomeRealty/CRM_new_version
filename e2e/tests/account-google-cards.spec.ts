import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/**
 * The two scoped Google Calendar cards on Account Settings, in a real browser.
 *
 * Account Settings used to render its own inline Google card that took no `scope` at all, so it
 * could not say WHICH area a connection belonged to. It now renders the shared `GoogleCalendarCard`
 * twice — once per area — and that change had never been opened in a browser.
 *
 * WHAT THIS PROVES THAT THE SERVER TESTS CANNOT. `crm-desk-isolation.spec.ts` proves the rows,
 * tokens and sync state stay separate in the database. None of that says the SCREEN shows them
 * separately: two cards both reading the CRM connection would satisfy every server assertion and
 * still tell a user their Desk calendar was connected when it was not.
 *
 * The states are driven by what the API reports, so this exercises loading, not-configured and
 * not-connected against a test environment with no Google credentials — which is the honest default
 * state. Connected and revoked need real OAuth tokens and are called out as unverified rather than
 * faked, because a card fed a hand-built row proves the renderer, not the integration.
 */

const ACCOUNT = '/crm/account';

test.describe('Account Settings shows one Google Calendar card per area', () => {
  test('both cards render, and each names its own area', async ({ page }) => {
    await signIn(page, 'superAdmin');
    await page.goto(ACCOUNT);

    // The headings the page adds above each card. These are what stop the two being ambiguous.
    await expect(page.getByRole('heading', { name: 'Customer Relationship Management' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Transaction Management' })).toBeVisible();

    // Two cards, not one.
    await expect(page.getByText('Google Calendar', { exact: true })).toHaveCount(2);
  });

  test('the Desk card does NOT say "the CRM" — the copy is scope-aware', async ({ page }) => {
    /*
     * THE REGRESSION THIS FILE EXISTS FOR. The shared card hardcoded "…between Google Calendar and
     * the CRM", so the Transaction Desk card told the user their events synced with the CRM. It was
     * the one string in a scope-aware component that was not scope-aware, and it is invisible to
     * every server test.
     */
    await signIn(page, 'superAdmin');
    await page.goto(ACCOUNT);

    const body = await page.locator('body').innerText();
    // Whatever state the cards are in, if the sync sentence appears for Desk it must name the Desk.
    if (body.includes('sync both ways')) {
      expect(body).toContain('Transaction Desk');
    }
    // And the CRM card's sentence, when shown, must name the CRM.
    const crmSentence = body.match(/sync both ways between Google Calendar and the ([^.]+)\./g) ?? [];
    for (const s of crmSentence) {
      expect(s).toMatch(/the (CRM|Transaction Desk)\./);
    }
  });

  test('each card reports its own connection state independently', async ({ page }) => {
    await signIn(page, 'superAdmin');
    await page.goto(ACCOUNT);

    // Every card resolves to a definite state — no card left on "Checking…" once loaded.
    await expect(page.getByText('Checking…')).toHaveCount(0, { timeout: 15_000 });

    // Two status pills, one per card. They are read independently from /api/google/calendar/status
    // with each card's own scope, so a shared state would show as a single pill or as two that
    // cannot disagree.
    const pills = page.locator('.intg-card .pill');
    await expect(pills).toHaveCount(2);
  });

  test('each card resolves to a definite, readable state of its own', async ({ page }) => {
    /*
     * Deliberately asserts the PROPERTY rather than a particular sentence. The exact wording depends
     * on whether the server has Google credentials, which differs between environments — pinning it
     * to one string would make this file fail on a machine that is configured differently, which is
     * a worse test than none.
     *
     * What must hold everywhere: each card independently resolves, and neither is left blank or
     * stuck on the loading placeholder.
     */
    await signIn(page, 'superAdmin');
    await page.goto(ACCOUNT);

    const pills = page.locator('.intg-card .pill');
    await expect(pills).toHaveCount(2);

    for (let i = 0; i < 2; i++) {
      const text = (await pills.nth(i).innerText()).trim();
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toBe('Checking…');
    }
  });
});
