import { test, expect, type Page } from '@playwright/test';
import { signIn, apiSend, API_BASE } from './helpers';

/**
 * CHOOSING THE MAILBOX A CAMPAIGN SENDS FROM, and reading back the one it used.
 *
 * WHAT THESE COVER that the server specs cannot. `campaign-sender-selection.spec.ts` proves the
 * behaviour — a chosen account is honoured, a disconnected one refuses the send, the address is
 * recorded. These prove the three things only a browser can answer:
 *
 *   WHICH ACCOUNTS APPEAR IN THE DROPDOWN, and just as importantly which do not. The allow-list is
 *   "your own accounts plus the brokerage's shared ones"; a COLLEAGUE'S personal mailbox is
 *   excluded, because offering it would make sending as another agent a feature rather than the
 *   accident it currently is.
 *
 *   THAT THE SENT-EMAIL POPUP NAMES THE SENDER. It showed Subject, Template, a recipient COUNT and
 *   a date — so "which address did these four hundred clients see?" had no answer on screen.
 *
 *   THAT THE RECIPIENT LIST CAN BE SEARCHED. Six hundred rows, and the question somebody brings
 *   here is about one of them, usually while that person is on the telephone.
 *
 * NOTHING IS EVER SENT. No test here commits a campaign; the two that touch the composer only read
 * the dropdown, and the rest open existing campaigns from the seeded book. The one write is a
 * shared mail account, created through the real admin endpoint and deleted again.
 */

/** Shared (brokerage-owned) mail accounts created by these tests, removed afterwards. */
const createdAccounts: { page: Page; id: number }[] = [];

async function createSharedAccount(page: Page, label: string): Promise<{ id: number; from_email: string }> {
  const from_email = `zz-shared-${Date.now()}@brokerage.test`;
  const res = await apiSend(page, 'POST', '/api/mail-accounts', {
    name: label, from_email, host: 'smtp.gmail.com', port: 587, encryption: 'tls', is_active: true,
  });
  expect([200, 201]).toContain(res.status);
  const id = (res.body as { data?: { id?: number } }).data?.id;
  expect(typeof id).toBe('number');
  createdAccounts.push({ page, id: id! });
  return { id: id!, from_email };
}

/*
 * SIGNED BACK IN AS SUPER ADMIN BEFORE DELETING, which is not ceremony.
 *
 * `/api/mail-accounts` is behind `AdminGuard`, and these tests sign in as the agent after creating
 * the account — so deleting through the same page sent the request as the agent, took a 403, and the
 * `.catch()` swallowed it. Two brokerage mailboxes were left in the test database by the first run
 * of this file, which would then have changed what the NEXT run's dropdown contained: a cleanup
 * failure that quietly rewrites the fixture the assertions depend on.
 */
test.afterEach(async () => {
  if (!createdAccounts.length) return;
  const page = createdAccounts[0].page;
  await signIn(page, 'superAdmin');
  while (createdAccounts.length) {
    const a = createdAccounts.pop()!;
    const res = await apiSend(page, 'DELETE', `/api/mail-accounts/${a.id}`);
    // Asserted, not hoped for. A silent failure here is how the leak happened.
    expect([200, 204]).toContain(res.status);
  }
});

const options = (page: Page) => page.evaluate(async (base) => {
  const r = await fetch(`${base}/api/campaigns/options`, { credentials: 'include', headers: { Accept: 'application/json' } });
  return r.json() as Promise<{
    sender_email: string | null;
    sender_accounts?: { id: number; name: string; from_email: string; from_name: string | null }[];
  }>;
}, API_BASE);

async function openComposer(page: Page): Promise<void> {
  await page.goto('/crm/campaigns');
  await page.getByRole('button', { name: /Create Campaign/i }).first().click();
  await expect(page.getByText(/recipients? match this segment/i)).toBeVisible({ timeout: 15_000 });
}

// =====================================================================================
test.describe('the mailboxes a campaign may be sent from', () => {
  test('THE DROPDOWN OFFERS AUTOMATIC, THE SHARED MAILBOX AND THE AGENT\'S OWN', async ({ page }) => {
    /*
     * The seeded book has exactly one mail account — the agent's own — so with nothing shared there
     * is no choice to make and the picker is deliberately absent. Adding a brokerage mailbox is
     * what creates the decision, which is why this test creates one rather than assuming it.
     */
    await signIn(page, 'superAdmin');
    const shared = await createSharedAccount(page, 'ZZ Brokerage Sender');

    await signIn(page, 'agent');
    const opts = await options(page);
    const offered = opts.sender_accounts ?? [];
    expect(offered.map((a) => a.from_email)).toContain(shared.from_email);
    // Their own mailbox is offered too — an agent's campaign should be able to come from it.
    expect(offered.map((a) => a.from_email)).toContain('dana.okafor@test.local');

    await openComposer(page);
    const select = page.getByTestId('campaign-sender-select');
    await expect(select).toBeVisible();

    const labels = await select.locator('option').allTextContents();
    // Automatic is FIRST and is the default, so somebody who never touches this gets exactly the
    // behaviour the screen had before the picker existed.
    expect(labels[0]).toMatch(/^Automatic/i);
    await expect(select).toHaveValue('');
    expect(labels.join(' | ')).toContain(shared.from_email);
    expect(labels.join(' | ')).toContain('dana.okafor@test.local');
    // One option per offered account, plus Automatic. Nothing else has crept in.
    expect(labels).toHaveLength(offered.length + 1);
  });

  test('A COLLEAGUE\'S PERSONAL MAILBOX IS NOT OFFERED, though it exists and is active', async ({ page }) => {
    /*
     * THE BOUNDARY, asserted by what is missing. The seeded agent's mailbox (`dana.okafor@`) is
     * active and connected, so a list built from "every active account" would include it for
     * everybody. `senderFor` can already fall through to exactly such an account as a last resort —
     * the "sent through Veena" incident — and this is the assertion that the dropdown does not turn
     * that accident into an offered choice.
     */
    await signIn(page, 'superAdmin');
    const shared = await createSharedAccount(page, 'ZZ Brokerage Sender 2');

    const opts = await options(page);
    const offered = opts.sender_accounts ?? [];
    // The shared one IS available to the admin, because shared means shared.
    expect(offered.map((a) => a.from_email)).toContain(shared.from_email);
    // The agent's own is not.
    expect(offered.map((a) => a.from_email)).not.toContain('dana.okafor@test.local');
    expect(offered.map((a) => a.id)).not.toContain(1);
  });

  test('the server REFUSES a sender id the picker never offered', async ({ page }) => {
    /*
     * A dropdown is not an access control. This posts an id directly, the way a stale screen or a
     * hand-written request would, and nothing is created.
     *
     * IT BRINGS ITS OWN TEMPLATE, because the template check runs first and rightly so — an id the
     * caller could not have picked is refused before anything else is considered. Borrowing
     * `template_id: 1` made this assert against "Template not found" and prove nothing about the
     * sender at all.
     */
    await signIn(page, 'agent');
    await page.goto('/crm/campaigns');

    const tpl = await apiSend(page, 'POST', '/api/campaigns/templates', {
      name: `ZZ-SENDER-TPL-${Date.now()}`,
      subject: 'ZZ sender subject',
      content: '<p>ZZ body</p>',
      category: 'custom',
    });
    expect([200, 201]).toContain(tpl.status);
    const templateId = (tpl.body as { id?: number }).id;
    expect(typeof templateId).toBe('number');

    try {
      const res = await apiSend(page, 'POST', '/api/campaigns', {
        name: `ZZ-SENDER-REFUSED-${Date.now()}`,
        template_id: templateId,
        sender_account_id: 99_999_999,
        idempotency_key: `zz-refused-${Date.now()}`,
      });

      expect([400, 404]).toContain(res.status);
      expect(JSON.stringify(res.body)).toMatch(/not available to send from|disconnected|deactivated|connected email accounts/i);

      // The refusal happened BEFORE anything was created — no campaign carries that name.
      const list = await page.evaluate(async (base) => {
        const r = await fetch(`${base}/api/campaigns`, { credentials: 'include', headers: { Accept: 'application/json' } });
        return r.json() as Promise<{ name: string }[]>;
      }, API_BASE);
      expect(list.some((c) => c.name.startsWith('ZZ-SENDER-REFUSED-'))).toBe(false);
    } finally {
      await apiSend(page, 'DELETE', `/api/campaigns/templates/${templateId}`).catch(() => undefined);
    }
  });
});

// =====================================================================================
test.describe('the sent-email popup says who it came from and who it went to', () => {
  /** Open the first campaign in the history grid through its "View email" button. */
  async function openSentEmail(page: Page): Promise<void> {
    await page.goto('/crm/campaigns');
    const button = page.getByRole('button', { name: /^View email$/ }).first();
    await expect(button).toBeVisible({ timeout: 15_000 });
    await button.click();
    await expect(page.getByText(/^Email sent —/)).toBeVisible({ timeout: 15_000 });
  }

  test('NAMES THE SENDING ADDRESS, and says so plainly when it was never recorded', async ({ page }) => {
    /*
     * Every seeded campaign pre-dates the column, so the honest answer for them is "Not recorded" —
     * the sender was resolved at send time and discarded, and a plausible-looking guess would be
     * worse than none. The row existing at all is the change: there was nowhere to show it before.
     */
    await signIn(page, 'agent');
    await openSentEmail(page);

    const from = page.getByTestId('sent-email-from');
    await expect(from).toBeVisible();
    await expect(from).toContainText(/From/);
    await expect(from).toContainText(/Not recorded|@/);
  });

  test('LISTS EVERY RECIPIENT with name, address and status, instead of only a count', async ({ page }) => {
    await signIn(page, 'agent');
    await openSentEmail(page);

    const list = page.getByTestId('recipient-list');
    await expect(list).toBeVisible();
    const rows = list.locator('.camp-row');
    const n = await rows.count();
    expect(n).toBeGreaterThan(0);

    // The three fields the requirement names, on the first row.
    const first = rows.first();
    await expect(first.locator('strong').first()).not.toBeEmpty();
    await expect(first).toContainText(/@/);
    await expect(first.locator('.pill')).not.toHaveCount(0);
  });

  test('SHOWS THE FAILED COUNT, which the screen never displayed although the API sent it', async ({ page }) => {
    // `stats.failed` has been in the response and in the client's own types all along, and was
    // rendered nowhere — so a campaign where delivery failed looked no different from a clean one.
    await signIn(page, 'agent');
    await openSentEmail(page);

    for (const key of ['all', 'sent', 'failed', 'bounced', 'unsubscribed']) {
      await expect(page.getByTestId(`camp-tile-${key}`)).toBeVisible();
    }
    await expect(page.getByTestId('camp-tile-failed')).toContainText(/Failed/);
  });

  test('SEARCHES THE LIST BY NAME OR ADDRESS, and says when nothing matches', async ({ page }) => {
    await signIn(page, 'agent');
    await openSentEmail(page);

    const list = page.getByTestId('recipient-list');
    const rows = list.locator('.camp-row');
    const before = await rows.count();
    expect(before).toBeGreaterThan(1);

    // Search for one real address taken from the list itself, so this cannot pass against a
    // hard-coded fixture that no longer exists.
    const target = (await rows.first().locator('.muted').first().textContent())?.trim() ?? '';
    expect(target).toContain('@');

    const search = page.getByTestId('recipient-search');
    await expect(search).toBeVisible();
    await search.fill(target);
    await expect(rows).toHaveCount(1);
    await expect(list).toContainText(target);

    // And the empty state is about the search, not about the campaign having no recipients.
    await search.fill('zz-nobody-by-this-name-exists');
    await expect(page.getByTestId('recipient-empty')).toContainText(/No recipient here matches/i);

    // Clearing it restores every row, so the filter is a view and not a deletion.
    await search.fill('');
    await expect(rows).toHaveCount(before);
  });

  test('the results modal shows the same list, from the same component', async ({ page }) => {
    // Two entry points, one implementation — the second copy would be the one that stopped
    // matching when a sixth delivery state arrived.
    await signIn(page, 'agent');
    await page.goto('/crm/campaigns');
    await page.getByRole('button', { name: /^View results$/ }).first().click();

    await expect(page.getByTestId('recipient-search')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('camp-tile-failed')).toBeVisible();
    await expect(page.getByTestId('results-from')).toContainText(/From/);
  });
});
