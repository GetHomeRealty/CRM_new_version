import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { signIn, apiGet } from './helpers';

/**
 * Disconnecting Google Calendar, in a real browser, end to end.
 *
 * THE DEFECT. `disconnect` revoked the token and deleted the connection row and did nothing about
 * the events pulled from that calendar. They kept `deleted_at IS NULL`, so the calendar kept
 * showing them — for ever, with nothing left that could ever sync them again. The server tests in
 * `server/src/google/calendar-disconnect.spec.ts` prove the rows. They cannot prove the SCREEN:
 * a calendar that renders from a stale client-side copy would satisfy every one of them and still
 * show the agent their Google appointments after they had disconnected.
 *
 * WHY THIS FAKES A CONNECTION WHEN `account-google-cards.spec.ts` REFUSES TO. That file tests the
 * card — whether the renderer describes a connection correctly — and a hand-built row would prove
 * the renderer against a state OAuth never produces. Here the subject is the path from the
 * disconnect endpoint through the calendar query to the screen, none of which the OAuth handshake
 * touches. The fixture leaves the tokens NULL, so `disconnect` skips the revoke and nothing in this
 * suite calls out to Google.
 *
 * The fixture seeds into 2026-11, away from the month `calendar-more.spec.ts` uses, and is torn
 * down afterwards even when a test fails.
 */

const MONTH = '2026-11';
const CRM_CALENDAR = `/crm/calendar?month=${MONTH}`;
const DESK_CALENDAR = `/desk/calendar?month=${MONTH}`;
const ACCOUNT = '/crm/account';

const SERVER = join(__dirname, '..', '..', 'server');
const fixture = (mode: '--setup' | '--teardown') =>
  execFileSync('node', ['scripts/e2e-google-fixture.cjs', mode], {
    cwd: SERVER,
    env: { ...process.env, TEST_DATABASE_URL: process.env.TEST_DATABASE_URL },
    encoding: 'utf8',
  });

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => { fixture('--setup'); });
test.afterAll(() => { fixture('--teardown'); });

/**
 * A title renders more than once on this screen — once as a chip in the month grid and again in the
 * day's detail panel — so every assertion below counts matches rather than expecting exactly one.
 * `.first()` on the visible cases, and a count of 0 on the absent ones.
 */
const shown = (page: import('@playwright/test').Page, title: string) => page.getByText(title).first();

/** What the calendar API returns for one area — the same call the screen makes. */
async function titles(page: import('@playwright/test').Page, area: 'crm' | 'desk'): Promise<string[]> {
  const res = await apiGet(page, `/api/calendar/events?area=${area}&from=${MONTH}-01&to=${MONTH}-30`);
  const body = res.body as { data?: unknown[] } | unknown[];
  const rows = (Array.isArray(body) ? body : body.data ?? []) as { title: string }[];
  return rows.map((r) => r.title).sort();
}

test.describe('a connected Google calendar', () => {
  test('shows its synced events on the CRM calendar', async ({ page }) => {
    await signIn(page, 'agent');
    await page.goto(CRM_CALENDAR);

    await expect(shown(page, 'E2E Google CRM event 1')).toBeVisible();
    await expect(shown(page, 'E2E Google CRM event 2')).toBeVisible();
    // The agent's own appointment sits alongside them.
    await expect(shown(page, 'E2E Native appointment')).toBeVisible();
  });
});

test.describe('disconnecting the CRM calendar', () => {
  test('removes its Google events from the screen, and keeps everything else', async ({ page }) => {
    await signIn(page, 'agent');

    // Both areas are connected and both have events, before anything is disconnected.
    expect(await titles(page, 'crm')).toEqual([
      'E2E Google CRM event 1', 'E2E Google CRM event 2', 'E2E Native appointment',
    ]);
    expect(await titles(page, 'desk')).toEqual(['E2E Google DESK event 1', 'E2E Google DESK event 2']);

    // Disconnect through the UI, on the card that says CRM — not by calling the API.
    await page.goto(ACCOUNT);
    const crmCard = page.locator('.intg-card', { hasText: 'Google Calendar' }).first();
    await expect(crmCard).toBeVisible();
    await crmCard.getByRole('button', { name: 'Disconnect' }).click();
    await expect(page.getByText('Disconnected.')).toBeVisible();

    /*
     * NAVIGATE, DO NOT RELOAD. The whole point of the requirement is that the agent should not have
     * to refresh the browser or sign in again. `page.goto` inside a SPA is a client-side route
     * change: CalendarPage mounts and refetches. A `page.reload()` here would prove nothing,
     * because a full reload would hide the defect this test exists for.
     */
    await page.goto(CRM_CALENDAR);

    await expect(page.getByText('E2E Google CRM event 1')).toHaveCount(0);
    await expect(page.getByText('E2E Google CRM event 2')).toHaveCount(0);
    // The agent's own appointment is untouched — it carries a Google id, so a naive cleanup would
    // have taken it too.
    await expect(shown(page, 'E2E Native appointment')).toBeVisible();
  });

  test('leaves the Transaction Desk calendar exactly as it was', async ({ page }) => {
    await signIn(page, 'agent');
    await page.goto(DESK_CALENDAR);

    await expect(shown(page, 'E2E Google DESK event 1')).toBeVisible();
    await expect(shown(page, 'E2E Google DESK event 2')).toBeVisible();
    expect(await titles(page, 'desk')).toEqual(['E2E Google DESK event 1', 'E2E Google DESK event 2']);
  });

  test('they stay hidden after a full reload and a fresh sign-in', async ({ page }) => {
    // The state is on the row, not in a request-scoped filter or a client cache, so neither a
    // reload nor a new session brings them back.
    await signIn(page, 'agent');
    await page.goto(CRM_CALENDAR);
    await page.reload();
    await expect(page.getByText('E2E Google CRM event 1')).toHaveCount(0);

    expect(await titles(page, 'crm')).toEqual(['E2E Native appointment']);
  });

  test('the API itself no longer returns them, whatever the screen does', async ({ page }) => {
    await signIn(page, 'agent');
    expect(await titles(page, 'crm')).toEqual(['E2E Native appointment']);
    expect(await titles(page, 'desk')).toEqual(['E2E Google DESK event 1', 'E2E Google DESK event 2']);
  });
});
