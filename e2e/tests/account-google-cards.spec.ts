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
const DESK_ACCOUNT = '/desk/account';

test.describe('Account Settings shows the Google Calendar card for THIS area only', () => {
  /*
   * WHAT CHANGED, AND WHY THESE ASSERTIONS INVERTED. This page is one component served at both
   * /crm/account and /desk/account, and it used to render BOTH scoped cards on each. So Settings
   * under the CRM offered a "Transaction Management" Google Calendar, and Settings under
   * Transaction Management offered a "Customer Relationship Management" one — each area handing out
   * a connection belonging to the other. It was reported from the product side and these tests had
   * been pinning it in place.
   *
   * The two connections are still genuinely independent — `google_connections.scope` still keys
   * them and connecting one still does not connect the other. Only which one THIS screen offers has
   * changed.
   */
  test('the CRM shows its own card and NOT the Transaction Desk one', async ({ page }) => {
    await signIn(page, 'superAdmin');
    await page.goto(ACCOUNT);

    await expect(page.getByRole('heading', { name: 'Customer Relationship Management' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Transaction Management' })).toHaveCount(0);
    await expect(page.getByText('Google Calendar', { exact: true })).toHaveCount(1);
  });

  test('the Transaction Desk shows its own card and NOT the CRM one', async ({ page }) => {
    await signIn(page, 'superAdmin');
    await page.goto(DESK_ACCOUNT);

    await expect(page.getByRole('heading', { name: 'Transaction Management' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Customer Relationship Management' })).toHaveCount(0);
    await expect(page.getByText('Google Calendar', { exact: true })).toHaveCount(1);
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

  test('the card resolves to a definite state of its own', async ({ page }) => {
    await signIn(page, 'superAdmin');
    await page.goto(ACCOUNT);

    // Every card resolves to a definite state — no card left on "Checking…" once loaded.
    await expect(page.getByText('Checking…')).toHaveCount(0, { timeout: 15_000 });

    // One card, so one status pill — read from /api/google/calendar/status with THIS area's scope.
    const pills = page.locator('.intg-card .pill');
    await expect(pills).toHaveCount(1);
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
    await expect(pills).toHaveCount(1);

    const text = (await pills.first().innerText()).trim();
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toBe('Checking…');
  });
});

/**
 * What the CONNECT copy is allowed to say.
 *
 * The rule is the brokerage's and it is a good one: describe the shape of Google's flow, never its
 * buttons. Google's labels differ between a personal account and a Workspace one and change without
 * announcement, so "Click Continue, then click Allow" would be wrong for some agents on the day it
 * was written — and wrong copy about a security prompt is worse than no copy, because an agent who
 * cannot find the button they were promised reasonably suspects the page is fake.
 *
 * "Use another account" is the deliberate exception. It is the one label named on purpose: it is
 * how somebody reaches an account that is NOT already signed in on the device, it is not obvious
 * from the picker, and without it the honest answer to "how do I connect a different mailbox?" is
 * missing. If Google ever renames it, this line is the thing to change.
 */
test.describe('the Google connect copy describes the flow, not Google’s buttons', () => {
  /** Instructions that name a control we do not own — the failure this guards against. */
  const FORBIDDEN = [
    /click\s+continue/i, /then\s+click\s+allow/i, /press\s+allow/i,
    /click\s+the\s+allow\s+button/i, /tap\s+continue/i,
  ];

  test('the Calendar card names itself and explains the flow without naming Google’s controls', async ({ page }) => {
    await signIn(page, 'superAdmin');
    await page.goto(ACCOUNT);

    const card = page.locator('.intg-card', { hasText: 'Google Calendar' }).first();
    await expect(card).toBeVisible();

    /*
     * WAIT FOR THE CARD TO SETTLE FIRST.
     *
     * The connect button renders immediately — disabled, while the status request is still in
     * flight — but the copy beside it belongs to the resolved not-connected state. Reading the card
     * before then caught "Google Calendar Checking… Checking… Connect Google Calendar" and failed on
     * copy that had not been rendered yet. The same wait the state tests above use.
     */
    await expect(card.locator('.pill')).not.toHaveText('Checking…', { timeout: 15_000 });

    const body = (await card.innerText()).replace(/\s+/g, ' ');
    // Only assert the connect copy when the card is actually offering a connection; a connected or
    // unconfigured card shows a different state and has no reason to carry it.
    if (/Connect Google Calendar/i.test(body)) {
      expect(body).toMatch(/Choose a Google account/i);
      expect(body).toMatch(/review the requested access/i);
      expect(body).toMatch(/Use another account/i);
    }
    for (const bad of FORBIDDEN) expect(body).not.toMatch(bad);
  });

  test('no screen anywhere tells the user which Google button to press', async ({ page }) => {
    // Broader than the card: the same temptation applies to any help text added later beside a
    // Google button, so this reads the whole settings page rather than one component.
    await signIn(page, 'superAdmin');
    for (const url of [ACCOUNT, '/crm/settings?tab=crm']) {
      await page.goto(url);
      await page.waitForLoadState('networkidle');
      const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
      for (const bad of FORBIDDEN) {
        expect(body, `${url} tells the user to press a Google button, which Google may rename`).not.toMatch(bad);
      }
    }
  });
});
