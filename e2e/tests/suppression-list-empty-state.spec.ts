import { test, expect, type Page } from '@playwright/test';
import { signIn, apiGet, apiSend } from './helpers';

/**
 * CRM-045: an agent's Suppression List no longer claims nobody is suppressed.
 *
 * WHAT WAS DISPLAYED, from both seats at the same moment. One suppression entry existed. The Super
 * Admin's list showed it. The agent's screen read "0 addresses suppressed" and "Nobody is
 * suppressed. Addresses appear here when someone unsubscribes…" - directly beneath a line saying
 * "This list is shared across the brokerage and applies to every agent's sends."
 *
 * THE SCREEN WAS NOT AT FAULT AND NEITHER WAS THE SCOPE. `GET /api/campaigns/suppressions` returned
 * 200 with an empty list for the agent's session, and the scoping that produced it is deliberate -
 * a brokerage-wide list showed every agent the addresses of every colleague's clients. Enforcement
 * never depended on it: every send is filtered against the whole table whoever is sending.
 *
 * WHAT WAS AT FAULT IS THAT NOBODY TOLD THE SCREEN. It was handed a slice with nothing marking it
 * as one, so it said the only thing it could - and "Nobody is suppressed" is a claim, not an
 * absence. On the one page a brokerage would open to answer a compliance question, to somebody who
 * can send campaigns, it was false.
 */

const unique = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const planted: { page: Page; email: string }[] = [];

test.afterEach(async () => {
  while (planted.length) {
    const s = planted.pop()!;
    await apiSend(s.page, 'DELETE', `/api/campaigns/suppressions/${encodeURIComponent(s.email)}`).catch(() => undefined);
  }
});

/** An opt-out belonging to nobody the agent can see. Recorded by a role permitted to record one. */
async function suppressSomebodyElse(page: Page): Promise<string> {
  const email = `${unique('zz-other-client')}@example.test`;
  const res = await apiSend(page, 'POST', '/api/campaigns/suppressions', { email, reason: 'unsubscribed' });
  expect([200, 201]).toContain(res.status);
  planted.push({ page, email });
  return email;
}

const openSuppressions = async (page: Page) => {
  await page.goto('/crm/campaigns');
  await page.getByRole('button', { name: /Suppression/i }).first().click();
  await expect(page.getByText('Suppression List', { exact: false }).first()).toBeVisible({ timeout: 15_000 });
};

test.describe('the Suppression List says whose list it is showing', () => {
  test('an agent is told they are seeing their own leads only', async ({ page }) => {
    await signIn(page, 'agent');
    await openSuppressions(page);

    // THE DEFECT: the screen said the list was shared across the brokerage, then showed zero.
    await expect(page.getByText(/seeing the opt-outs among your own leads/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/not shown to your role/i)).toBeVisible();
  });

  test('the empty state is an absence, not a claim about the brokerage', async ({ page }) => {
    /*
     * The exact sentence the report caught. It must not say "Nobody is suppressed" to somebody who
     * is being shown a slice - and it must still say what IS true: the addresses it cannot show are
     * blocked on their sends anyway.
     */
    await signIn(page, 'agent');
    await openSuppressions(page);

    const rows = page.locator('table tbody tr');
    test.skip(await rows.count() > 0, 'this agent has suppressed leads of their own on this database');

    await expect(page.getByText(/Nobody is suppressed/i)).toHaveCount(0);
    await expect(page.getByText(/None of your leads has opted out/i)).toBeVisible();
    await expect(page.getByText(/still blocked on anything you send/i)).toBeVisible();
  });

  test('a suppression the agent cannot see does not make the screen lie', async ({ page, browser }) => {
    /*
     * The report's own reproduction, both seats at one moment: an address is suppressed, the
     * Super Admin sees it, the agent does not - and the agent's screen no longer says nobody is.
     */
    const adminCtx = await browser.newContext();
    const admin = await adminCtx.newPage();
    await signIn(admin, 'superAdmin');
    const email = await suppressSomebodyElse(admin);

    // The Super Admin can see it.
    const seen = await apiGet(admin, `/api/campaigns/suppressions?search=${encodeURIComponent(email)}`);
    expect((seen.body as { data: { email: string }[] }).data.map((r) => r.email)).toContain(email);

    await signIn(page, 'agent');
    const agentSees = await apiGet(page, `/api/campaigns/suppressions?search=${encodeURIComponent(email)}`);
    expect((agentSees.body as { data: { email: string }[] }).data).toHaveLength(0);
    // The response now admits what it is.
    expect((agentSees.body as { meta: { scoped?: boolean } }).meta.scoped).toBe(true);

    await openSuppressions(page);
    await expect(page.getByText(/Nobody is suppressed/i)).toHaveCount(0);

    await adminCtx.close();
  });

  test('a marketing role still sees the brokerage-wide wording', async ({ page }) => {
    // The scope narrowed the view for agents only. Nothing about the admin's screen changes.
    await signIn(page, 'superAdmin');
    await openSuppressions(page);

    await expect(page.getByText(/seeing the opt-outs among your own leads/i)).toHaveCount(0);
    await expect(page.getByText(/applies to every agent/i)).toBeVisible();
  });

  test('the count line says what it is counting', async ({ page }) => {
    await signIn(page, 'agent');
    await openSuppressions(page);
    await expect(page.getByText(/suppressed among your leads/i)).toBeVisible({ timeout: 10_000 });
  });
});
