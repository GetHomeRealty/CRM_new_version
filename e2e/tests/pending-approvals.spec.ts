import { test, expect, type Page } from '@playwright/test';
import { ACCOUNTS, apiGet, apiSend, signIn } from './helpers';

/**
 * PENDING APPROVALS — the Desk dashboard tile, the list it opens, and the bell.
 *
 * THE PROPERTY UNDER TEST IS AGREEMENT between three things that are easy to let drift: the number
 * on the card, the rows in the list it links to, and who is allowed to see either. They are
 * asserted against each other on the same data wherever that is possible, rather than against
 * hand-written numbers that would pass while both halves were wrong together.
 *
 * Each test builds and removes its own deals, so the figures are relative: a shared test database
 * carries other people's rows, and asserting "the tile reads 2" would be asserting the state of
 * the whole database.
 */

const uniq = (p: string) => `${p}${Date.now().toString().slice(-7)}${Math.floor(Math.random() * 1000)}`;

type Made = { deals: number[] };

async function deal(page: Page, made: Made, property: string, agent = ACCOUNTS.agent.name): Promise<number> {
  const res = await apiSend(page, 'POST', '/api/transactions', {
    type: 'Residential Buying', property, status: 'Secured Firm', price: 500000,
    comm_type: '%', comm_value: 2.5, offer_date: '2026-08-13', closing_date: '2026-09-30',
    primary_agent: agent,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const id = (res.body as { data: { id: number } }).data.id;
  made.deals.push(id);
  return id;
}

/**
 * Raise a request the way the product does — the same endpoint the modals call.
 *
 * `scope` IS EITHER 'financial' OR OMITTED, because those are the only two this endpoint accepts:
 * `EditRequestDto` pins it to `IsIn(['financial'])` and leaves it optional. ('mandatory' exists in
 * the service but is raised from the documents module, not through here.) Omitting it is the
 * general "let me edit this locked deal" request, and the two count as different scopes — which is
 * how one deal can carry two pending requests, the case the tile has to collapse to one.
 */
async function askForEdit(page: Page, txnId: number, scope: 'financial' | null, reason = 'Needs correcting'): Promise<number> {
  const body: Record<string, unknown> = { reason };
  if (scope) body.scope = scope;
  const res = await apiSend(page, 'POST', `/api/transactions/${txnId}/edit-requests`, body);
  expect([200, 201], `request should be accepted: ${JSON.stringify(res.body)}`).toContain(res.status);
  return ((res.body as { data?: { id: number } }).data ?? res.body as { id: number }).id;
}

/**
 * One person's Notification Centre feed.
 *
 * `{ items, unread }` — NOT a paged `{ data }` list, and the field is `limit` rather than
 * `per_page`. The Centre merges four sources into one feed, so a dispatched row arrives as an item
 * whose `summary` carries the body.
 */
async function feed(page: Page): Promise<{ items: { title: string; summary: string | null; link: string; unread: boolean }[]; unread: number }> {
  const r = await apiGet(page, '/api/notifications?limit=100');
  const b = r.body as { items?: unknown[]; unread?: number };
  return { items: (b.items ?? []) as { title: string; summary: string | null; link: string; unread: boolean }[], unread: b.unread ?? 0 };
}

const cleanUp = async (page: Page, made: Made) => {
  for (const id of made.deals) await apiSend(page, 'DELETE', `/api/transactions/${id}`).catch(() => undefined);
  made.deals = [];
};

const tileCount = async (page: Page): Promise<number> => {
  const d = await apiGet(page, '/api/dashboard/desk');
  return (d.body as { approvals: { pending: number } }).approvals.pending;
};

const listTotal = async (page: Page): Promise<number> => {
  const r = await apiGet(page, '/api/transactions?approvals=pending&page=1&per_page=25&status=');
  return (r.body as { meta: { total: number } }).meta.total;
};

test.describe('the Pending Approvals tile', () => {
  test('MULTIPLE REQUESTS ON ONE DEAL COUNT AS ONE, and the list agrees', async ({ page }) => {
    await signIn(page, 'admin');          // a manager may raise requests; a Super Admin may not
    const made: Made = { deals: [] };
    try {
      const before = await tileCount(page);
      const beforeList = await listTotal(page);
      expect(before).toBe(beforeList);

      const id = await deal(page, made, uniq('ZZ-TEST Approvals One Road '));
      await askForEdit(page, id, 'financial');
      await askForEdit(page, id, null);

      // Two requests, one deal: both figures move by exactly one.
      expect(await tileCount(page)).toBe(before + 1);
      expect(await listTotal(page)).toBe(beforeList + 1);
    } finally {
      await cleanUp(page, made);
    }
  });

  test('APPROVING AND REJECTING UPDATE THE COUNT', async ({ page }) => {
    await signIn(page, 'admin');
    const made: Made = { deals: [] };
    try {
      const before = await tileCount(page);
      const id = await deal(page, made, uniq('ZZ-TEST Approvals Decide Road '));
      const first = await askForEdit(page, id, 'financial');
      const second = await askForEdit(page, id, null);
      expect(await tileCount(page)).toBe(before + 1);

      // Only a Super Admin may decide — which is the existing workflow, unchanged.
      await page.context().clearCookies();
      await signIn(page, 'superAdmin');

      const ok = await apiSend(page, 'POST', `/api/edit-requests/${first}/approve`);
      expect([200, 201]).toContain(ok.status);
      // One of two decided: the deal is still waiting, so the figure holds.
      expect(await tileCount(page)).toBe(before + 1);

      const no = await apiSend(page, 'POST', `/api/edit-requests/${second}/reject`);
      expect([200, 201]).toContain(no.status);
      // The last one decided: the deal leaves the queue.
      expect(await tileCount(page)).toBe(before);
      expect(await listTotal(page)).toBe(before);
    } finally {
      await cleanUp(page, made);
    }
  });

  test('the card shows the figure and opens the filtered list', async ({ page }) => {
    await signIn(page, 'admin');
    const made: Made = { deals: [] };
    try {
      const property = uniq('ZZ-TEST Approvals Card Road ');
      const id = await deal(page, made, property);
      await askForEdit(page, id, 'financial');

      await page.goto('/desk/dashboard');
      const card = page.locator('.stat-card').filter({ hasText: 'Pending Approvals' });
      await expect(card).toBeVisible({ timeout: 15_000 });
      await expect(card.locator('.val')).toHaveText(String(await tileCount(page)));

      await card.click();
      await expect(page).toHaveURL(/\/desk\/transactions\?approvals=pending/);
      // The deal that is waiting is in the list.
      await expect(page.getByText(property)).toBeVisible({ timeout: 15_000 });
    } finally {
      await cleanUp(page, made);
    }
  });

  test('THE FILTER SURVIVES A REFRESH, and can be cleared', async ({ page }) => {
    await signIn(page, 'admin');
    const made: Made = { deals: [] };
    try {
      const waiting = uniq('ZZ-TEST Approvals Keep Road ');
      const quiet = uniq('ZZ-TEST Approvals Quiet Road ');
      await askForEdit(page, await deal(page, made, waiting), 'financial');
      await deal(page, made, quiet);

      await page.goto('/desk/transactions?approvals=pending');
      const filter = page.getByTestId('txn-approvals-filter');
      await expect(filter).toHaveValue('pending');
      await expect(page.getByText(waiting)).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(quiet)).toHaveCount(0);

      // A refresh keeps it — the filter is in the URL precisely so this holds.
      await page.reload();
      await expect(page.getByTestId('txn-approvals-filter')).toHaveValue('pending');
      await expect(page.getByText(waiting)).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(quiet)).toHaveCount(0);

      // Clearing it returns every accessible deal, and takes the parameter out of the URL.
      await page.getByTestId('txn-approvals-filter').selectOption('');
      await expect(page).not.toHaveURL(/approvals=pending/);
      await expect(page.getByText(quiet)).toBeVisible({ timeout: 15_000 });
    } finally {
      await cleanUp(page, made);
    }
  });

  test('a deal awaiting approval is shown even though it is CLOSED', async ({ page }) => {
    /*
     * The case the status default would have hidden. This screen opens on open-and-firm deals, and
     * an edit request is usually about a deal that is closed — so arriving on the queue opens the
     * status filter up. Without that the tile would count a deal the list would not show.
     */
    await signIn(page, 'admin');
    const made: Made = { deals: [] };
    try {
      const property = uniq('ZZ-TEST Approvals Closed Road ');
      const id = await deal(page, made, property);
      await apiSend(page, 'PUT', `/api/transactions/${id}`, { statuses: ['Closed'] });
      await askForEdit(page, id, 'financial');

      await page.goto('/desk/transactions?approvals=pending');
      await expect(page.getByText(property)).toBeVisible({ timeout: 15_000 });
    } finally {
      await cleanUp(page, made);
    }
  });
});

test.describe('who may see it', () => {
  test('AN AGENT IS NOT SHOWN ANOTHER AGENT\'S PENDING APPROVALS', async ({ page }) => {
    await signIn(page, 'admin');
    const made: Made = { deals: [] };
    try {
      // A deal belonging to agent2, with a request on it.
      const property = uniq('ZZ-TEST Approvals Scoped Road ');
      const id = await deal(page, made, property, ACCOUNTS.agent2.name);
      await askForEdit(page, id, 'financial');

      await page.context().clearCookies();
      await signIn(page, 'agent');          // Dana, who is not on that deal

      // Neither the tile nor the list may mention it, and the two must still agree.
      const tile = await tileCount(page);
      expect(tile).toBe(await listTotal(page));

      await page.goto('/desk/transactions?approvals=pending');
      await expect(page.getByText(property)).toHaveCount(0);
    } finally {
      await page.context().clearCookies();
      await signIn(page, 'admin');
      await cleanUp(page, made);
    }
  });
});

test.describe('notifying the reviewers', () => {
  test('A SUPER ADMIN IS TOLD, ONCE, AND THE LINK OPENS THE DEAL', async ({ page }) => {
    await signIn(page, 'admin');
    const made: Made = { deals: [] };
    try {
      const property = uniq('ZZ-TEST Approvals Notify Road ');
      const id = await deal(page, made, property);
      await askForEdit(page, id, 'financial', 'The price is wrong');

      await page.context().clearCookies();
      await signIn(page, 'superAdmin');

      const mine = async () => (await feed(page)).items.filter((n) => (n.summary ?? '').includes(property));

      await expect.poll(async () => (await mine()).length, { timeout: 15_000 }).toBe(1);
      const n = (await mine())[0];
      expect(n.title).toBe('Approval requested');
      expect(n.summary).toContain('financial');
      expect(n.summary).toContain('The price is wrong');
      expect(n.link).toBe(`/desk/transactions/${id}?section=approvals`);
      // Unread, so it reaches the bell's badge — which must also have counted it.
      expect(n.unread).toBe(true);
      expect((await feed(page)).unread).toBeGreaterThan(0);
    } finally {
      await page.context().clearCookies();
      await signIn(page, 'admin');
      await cleanUp(page, made);
    }
  });

  test('A RETRY DOES NOT RING THE BELL TWICE, and reading a page rings it not at all', async ({ page }) => {
    await signIn(page, 'admin');
    const made: Made = { deals: [] };
    try {
      const property = uniq('ZZ-TEST Approvals Dupe Road ');
      const id = await deal(page, made, property);
      await askForEdit(page, id, 'financial');

      // The retry: the same submission again. The workflow refuses a second pending request for
      // the same deal and scope, so nothing further can be raised.
      const again = await apiSend(page, 'POST', `/api/transactions/${id}/edit-requests`, { reason: 'x', scope: 'financial' });
      expect(again.status).toBeGreaterThanOrEqual(400);

      // And simply reading the deal raises nothing.
      await page.goto(`/desk/transactions/${id}`);
      await page.reload();

      await page.context().clearCookies();
      await signIn(page, 'superAdmin');
      const rows = (await feed(page)).items;
      expect(rows.filter((n) => (n.summary ?? '').includes(property))).toHaveLength(1);
    } finally {
      await page.context().clearCookies();
      await signIn(page, 'admin');
      await cleanUp(page, made);
    }
  });

  test('AN AGENT IS NOT NOTIFIED — they cannot review it', async ({ page }) => {
    await signIn(page, 'admin');
    const made: Made = { deals: [] };
    try {
      const property = uniq('ZZ-TEST Approvals NoAgent Road ');
      await askForEdit(page, await deal(page, made, property), 'financial');

      await page.context().clearCookies();
      await signIn(page, 'agent');
      const rows = (await feed(page)).items;
      expect(rows.filter((n) => (n.summary ?? '').includes(property))).toHaveLength(0);
    } finally {
      await page.context().clearCookies();
      await signIn(page, 'admin');
      await cleanUp(page, made);
    }
  });

  test('READING THE NOTIFICATION DOES NOT APPROVE ANYTHING', async ({ page }) => {
    await signIn(page, 'admin');
    const made: Made = { deals: [] };
    try {
      const property = uniq('ZZ-TEST Approvals ReadOnly Road ');
      const id = await deal(page, made, property);
      const reqId = await askForEdit(page, id, 'financial');
      const beforeTile = await tileCount(page);

      await page.context().clearCookies();
      await signIn(page, 'superAdmin');
      await apiSend(page, 'POST', '/api/notifications/read-all').catch(() => undefined);

      // The request is untouched, and the deal is still in the queue.
      const d = await apiGet(page, `/api/transactions/${id}`);
      const reqs = ((d.body as { data?: { edit_requests?: { id: number; status: string }[] } }).data?.edit_requests) ?? [];
      expect(reqs.find((r) => r.id === reqId)?.status).toBe('pending');

      await page.context().clearCookies();
      await signIn(page, 'admin');
      expect(await tileCount(page)).toBe(beforeTile);
    } finally {
      await page.context().clearCookies();
      await signIn(page, 'admin');
      await cleanUp(page, made);
    }
  });
});

/* ===================================================================================================
 * LOADING, ERROR, AND A FAILED QUIET REFRESH.
 *
 * The shared hazard is the same one in three costumes: a tile whose value is a number renders 0 for
 * "nothing is waiting" AND for "we do not know". Those mean opposite things to a reviewer — one is
 * an empty queue, the other is an unread one — so none of these states may put a 0 on screen.
 *
 * The dashboard's existing loading and error handling is what is being checked, not new code: the
 * tile sits inside it and inherits it. These assert that it genuinely does.
 * =================================================================================================== */

const DESK_DASHBOARD = '**/api/dashboard/desk';
const approvalsCard = (page: Page) => page.locator('.stat-card').filter({ hasText: 'Pending Approvals' });

test.describe('the dashboard while it cannot answer', () => {
  test('A SLOW RESPONSE SHOWS THE LOADING STATE, not a Pending Approvals count of 0', async ({ page }) => {
    await signIn(page, 'admin');

    let release = (): void => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route(DESK_DASHBOARD, async (route) => { await held; await route.continue(); });

    await page.goto('/desk/dashboard');

    // The existing spinner, and NOTHING claiming to know the figure.
    await expect(page.getByText('Loading dashboard…')).toBeVisible({ timeout: 10_000 });
    await expect(approvalsCard(page)).toHaveCount(0);

    release();
    // And once it arrives, the card appears with a real value.
    await expect(approvalsCard(page)).toBeVisible({ timeout: 15_000 });
    await expect(approvalsCard(page).locator('.val')).toHaveText(/^\d+$/);
  });

  test('AN API ERROR SHOWS THE ERROR STATE, not zero pending approvals', async ({ page }) => {
    await signIn(page, 'admin');
    await page.route(DESK_DASHBOARD, (route) => route.fulfill({
      status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Server error' }),
    }));

    await page.goto('/desk/dashboard');

    // The existing "Nothing to show" card, and no tiles at all — so no 0 to misread.
    await expect(page.getByText('The dashboard could not be loaded. Try Refresh.')).toBeVisible({ timeout: 15_000 });
    await expect(approvalsCard(page)).toHaveCount(0);
    await expect(page.locator('.stat-card')).toHaveCount(0);
  });

  test('A FAILED QUIET REFRESH KEEPS THE LAST GOOD COUNT', async ({ page }) => {
    /*
     * The refresh is a background read nobody asked for — on the notification stream, or on
     * returning to the tab. If it fails, the right answer is to leave the last known figures up:
     * replacing them with 0, or with the error card, would destroy information over a hiccup.
     */
    await signIn(page, 'admin');
    const made: Made = { deals: [] };
    try {
      const id = await deal(page, made, uniq('ZZ-TEST Approvals Quiet Fail Road '));
      await askForEdit(page, id, 'financial');

      await page.goto('/desk/dashboard');
      await expect(approvalsCard(page)).toBeVisible({ timeout: 15_000 });
      const before = await approvalsCard(page).locator('.val').textContent();
      expect(Number(before)).toBeGreaterThan(0);   // a real figure, so losing it would be visible

      /*
       * Now break the endpoint and provoke the quiet refresh. The handler checks
       * `visibilityState`, which is already 'visible', so dispatching the event is enough.
       *
       * THE HIT COUNTER IS NOT DECORATION. Without it this test passes just as happily if the
       * refresh never fires at all — the figure would be unchanged for the wrong reason, and the
       * test would be asserting nothing.
       */
      let hits = 0;
      await page.route(DESK_DASHBOARD, (route) => {
        hits += 1;
        return route.fulfill({
          status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Server error' }),
        });
      });
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await expect.poll(() => hits, { timeout: 10_000 }).toBeGreaterThan(0);

      // Unchanged: same number, still a card, no error state, and no toast for something the
      // person did not ask for.
      await page.waitForTimeout(1200);
      await expect(approvalsCard(page).locator('.val')).toHaveText(String(before));
      await expect(page.getByText('The dashboard could not be loaded. Try Refresh.')).toHaveCount(0);
      await expect(page.getByText(/Could not load the dashboard/)).toHaveCount(0);
    } finally {
      await page.unroute(DESK_DASHBOARD);
      await cleanUp(page, made);
    }
  });
});
