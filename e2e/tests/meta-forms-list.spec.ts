import { test, expect, type Page } from '@playwright/test';
import { signIn } from './helpers';

/**
 * The Lead Forms list: active forms first, two columns, and its own scrollbar.
 *
 * WHY THE RESPONSES ARE STUBBED. Every one of these properties is about a Page that has MANY forms
 * with MIXED statuses, and `status` is Facebook's own field — the CRM never stores it, it arrives
 * live from the Graph API on each request. So there is no seed that could produce this list, and
 * the test database has no Meta connection at all. Stubbing is not a shortcut around a real check
 * here; it is the only way to put the screen in the state the properties describe.
 *
 * WHAT IS STILL REAL. The ordering, the grid and the scroll container are all client-side, and they
 * are exactly what the stub exercises: a real browser, the real component, the real stylesheet, at
 * real viewport widths. Nothing about the assertions depends on the data being fake.
 */

const STATUS = '**/api/meta/status';
const PAGES = '**/api/meta/pages';
const FORMS = '**/api/meta/forms*';
const LEADS = '**/api/meta/leads*';
const AD_STATUS = '**/api/meta/ad-status*';
const HEALTH = '**/api/meta/webhook-health*';

const connected = {
  connected_forms: 6, token_expires_at: null, token_days_left: 40, token_expired: false,
  needs_reconnect: false, granted_scopes: [], missing_permissions: [], ad_account_id: null,
  ad_account_name: null, last_error: null, last_error_at: null,
  last_webhook_at: '2026-10-08T12:00:00.000Z',
  configured: true, token_storage_secure: true, redirect_uri: 'https://x.test/cb',
  oauth_strategy: 'config', has_login_config_id: true, is_connected: true,
  facebook_user_name: 'Test Account', pages_count: 1, page_name: 'A Page',
  connected_at: '2026-07-01T00:00:00.000Z', last_sync: '2026-10-08T12:00:00.000Z', leads_count: 9,
};

/**
 * Fourteen forms, numbered BY ARRIVAL and deliberately interleaved.
 *
 * The numbers are what make "preserve the existing order within each status group" testable. Within
 * each group the numbers must come out strictly increasing; across the two groups they must not.
 * A comparator that reordered within a group, or a sort that grouped by something else, would break
 * the sequence rather than merely producing a different-looking list.
 *
 * `active` in lower case and ` ACTIVE ` padded are in here on purpose. `status` is Facebook's
 * string, passed through untouched, so the comparison has to survive casing and whitespace that
 * nothing on our side controls. A null status is not active and belongs with the rest.
 */
const FORMS_FIXTURE = [
  { n: 1, name: '01 Paused Spring', status: 'PAUSED' },
  { n: 2, name: '02 Active Downtown', status: 'ACTIVE' },
  { n: 3, name: '03 Archived Old', status: 'ARCHIVED' },
  { n: 4, name: '04 Active Waterfront', status: 'ACTIVE' },
  { n: 5, name: '05 Status Missing', status: null },
  { n: 6, name: '06 Active Lowercase', status: 'active' },
  { n: 7, name: '07 Draft Condo', status: 'DRAFT' },
  { n: 8, name: '08 Active Suburbs', status: 'ACTIVE' },
  { n: 9, name: '09 Deleted Legacy', status: 'DELETED' },
  { n: 10, name: '10 Active Padded', status: '  ACTIVE  ' },
  { n: 11, name: '11 Paused Luxury', status: 'PAUSED' },
  { n: 12, name: '12 Active Precon', status: 'ACTIVE' },
  { n: 13, name: '13 Archived Older', status: 'ARCHIVED' },
  { n: 14, name: '14 Active Lakeside', status: 'ACTIVE' },
];

/** Actives in arrival order, then everything else in arrival order. */
const EXPECTED = [2, 4, 6, 8, 10, 12, 14, 1, 3, 5, 7, 9, 11, 13];

/**
 * Which forms are connected to the CRM — chosen to DISAGREE with which forms are active.
 *
 * Mostly inactive forms, plus one active one. If connectedness and activity lined up, "connected
 * first" and "active first" would produce the same list and the ordering test below would pass
 * against an implementation reading the wrong field.
 */
const CONNECTED = new Set([1, 3, 5, 7, 11, 2]);

const forms = FORMS_FIXTURE.map((f) => ({
  id: `form-${f.n}`, name: f.name, status: f.status, leads_count: f.n,
  crm_count: 0, created_at: '2026-07-01T00:00:00.000Z', is_connected: CONNECTED.has(f.n),
}));

const json = (body: unknown) => ({
  status: 200, contentType: 'application/json', body: JSON.stringify(body),
});

/** The same shape as `forms`, for a count the fixture does not spell out one by one. */
const manyForms = (n: number) => Array.from({ length: n }, (_, i) => ({
  id: `bulk-${i}`, name: `Bulk form ${String(i).padStart(3, '0')}`, status: 'ACTIVE',
  leads_count: i, crm_count: 0, created_at: '2026-07-01T00:00:00.000Z', is_connected: false,
}));

async function openForms(page: Page, list: unknown[] = forms): Promise<void> {
  await page.route(STATUS, (r) => r.fulfill(json(connected)));
  await page.route(HEALTH, (r) => r.fulfill(json({
    total: 9, failed: 0, last_received_at: '2026-10-08T12:00:00.000Z',
    connected_forms: 6, events: [], stalled: false, stalled_reason: null,
  })));
  await page.route(PAGES, (r) => r.fulfill(json({
    pages: [{ id: 'page-1', name: 'A Page', is_default: true }],
  })));
  await page.route(FORMS, (r) => r.fulfill(json({ page_name: 'A Page', forms: list })));
  await page.route(LEADS, (r) => r.fulfill(json({
    stats: { total: 9, today: 0, week: 2 }, data: [], form_total: 0, page: 1, per_page: 50,
  })));
  // No ad account in the fixture, so no badges — which keeps the cards a uniform height and the
  // row measurements about the grid rather than about one card being taller than its neighbours.
  await page.route(AD_STATUS, (r) => r.fulfill(json({
    checked_at: '2026-10-08T12:00:00.000Z', blocked: null, accounts_checked: 0,
    accounts_failed: [], forms: {},
  })));

  await page.goto('/crm/meta');
  await expect(page.getByTestId('meta-forms-list')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('meta-forms-list').locator('li')).toHaveCount(list.length);
}

/** The leading number of each card, in the order the list renders them. */
const renderedOrder = (page: Page): Promise<number[]> =>
  page.getByTestId('meta-forms-list').locator('li strong')
    .allInnerTexts().then((names) => names.map((t) => Number(t.trim().slice(0, 2))));

/**
 * How many cards sit on each row, read from their geometry rather than from the CSS.
 *
 * Asserting on `grid-template-columns` would only prove the stylesheet says what it says. This
 * proves what a person actually sees, which is the thing that was wrong before.
 */
const rowSizes = (page: Page): Promise<number[]> =>
  page.getByTestId('meta-forms-list').evaluate((ul) => {
    const tops = [...ul.querySelectorAll('li')].map((li) => Math.round(li.getBoundingClientRect().top));
    const counts = new Map<number, number>();
    for (const t of tops) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
  });

test.describe('the Lead Forms list', () => {
  test('PUTS ACTIVE FORMS FIRST, keeping arrival order inside each group', async ({ page }) => {
    await signIn(page, 'admin');
    await openForms(page);

    expect(await renderedOrder(page)).toEqual(EXPECTED);
  });

  test('orders by the form status, not by whether it is connected to the CRM', async ({ page }) => {
    /*
     * The fixture connects every even-numbered form, so "connected first" and "active first" are
     * different answers. Without this, an implementation that read `is_connected` would pass the
     * test above by coincidence on a fixture where the two happened to agree.
     */
    await signIn(page, 'admin');
    await openForms(page);

    const ns = FORMS_FIXTURE.map((f) => f.n);
    const connectedFirst = [...ns.filter((n) => CONNECTED.has(n)), ...ns.filter((n) => !CONNECTED.has(n))];
    expect(connectedFirst).not.toEqual(EXPECTED);   // the fixture really does distinguish them

    expect(await renderedOrder(page)).toEqual(EXPECTED);
  });

  test('the search filter keeps the active-first order', async ({ page }) => {
    await signIn(page, 'admin');
    await openForms(page);

    await page.getByTestId('meta-form-search').fill('a');   // matches every name
    await expect(page.getByTestId('meta-form-count')).toHaveText('Showing 14 of 14 forms');
    expect(await renderedOrder(page)).toEqual(EXPECTED);

    /*
     * A narrower search that still spans both groups. The property is that filtering and ordering
     * compose: what survives the search comes out in the same relative order it would have had in
     * the full list. Expressed as EXPECTED restricted to the matches, so the expectation is derived
     * rather than a second hand-written sequence that could drift from the fixture.
     */
    await page.getByTestId('meta-form-search').fill('d');   // Downtown, Archived, Deleted, Padded…
    const matched = new Set(
      FORMS_FIXTURE.filter((f) => f.name.toLowerCase().includes('d')).map((f) => f.n),
    );
    expect(matched.size).toBeGreaterThan(2);
    // Both groups are represented, or this would not be testing the ordering at all.
    expect([...matched].some((n) => EXPECTED.indexOf(n) < 7)).toBe(true);
    expect([...matched].some((n) => EXPECTED.indexOf(n) >= 7)).toBe(true);

    expect(await renderedOrder(page)).toEqual(EXPECTED.filter((n) => matched.has(n)));
  });

  test('SCROLLS INSIDE ITSELF, leaving the heading and search in place', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, 'admin');
    await openForms(page);

    const list = page.getByTestId('meta-forms-list');
    const box = await list.evaluate((ul) => ({
      scrollHeight: ul.scrollHeight, clientHeight: ul.clientHeight,
      overflowY: getComputedStyle(ul).overflowY,
    }));

    // Fourteen forms genuinely overflow the limit — otherwise the rest proves nothing.
    expect(box.overflowY).toBe('auto');
    expect(box.scrollHeight).toBeGreaterThan(box.clientHeight + 1);
    expect(box.clientHeight).toBeLessThanOrEqual(430);

    /*
     * Bring the list itself into view first. The Lead Forms card sits below the connection card,
     * so on a 900px-tall window part of it starts under the fold — that is ordinary page layout
     * and not what this test is about. What it is about is what happens AFTER it is on screen.
     */
    await list.scrollIntoViewIfNeeded();
    const pageScrollBefore = await page.evaluate(() => window.scrollY);

    await list.evaluate((ul) => { ul.scrollTop = ul.scrollHeight; });

    // THE LIST MOVED AND THE DOCUMENT DID NOT. That is the whole point: reaching the last form no
    // longer means scrolling the page past every form before it.
    expect(await list.evaluate((ul) => ul.scrollTop)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(pageScrollBefore);

    // The last form is now reachable, and the controls above the list never left the screen.
    await expect(list.locator('li').last()).toBeInViewport();
    await expect(page.getByTestId('meta-form-search')).toBeInViewport();
    await expect(page.getByTestId('meta-form-count')).toBeInViewport();
  });

  test('THE CARD STOPS GROWING WITH THE FORM COUNT', async ({ page }) => {
    /*
     * The clearest statement of the defect. A Page with sixty forms produced a card sixty forms
     * tall, and the leads table underneath it was effectively unreachable. With the list capped,
     * the document is the same height at fourteen forms as at sixty — the extra forms live inside
     * the list's own scroll, not in the page.
     *
     * Measured against another OVERFLOWING count rather than against a short list: the cap only
     * claims to bound the height once it is reached, so comparing with four forms would correctly
     * show a difference and prove nothing.
     */
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, 'admin');
    await openForms(page);

    const docHeight = () => page.evaluate(() => document.documentElement.scrollHeight);
    const atFourteen = await docHeight();

    // A later handler takes precedence, so this replaces the fixture for the reload.
    await page.route(FORMS, (r) => r.fulfill(json({ page_name: 'A Page', forms: manyForms(60) })));
    await page.reload();
    await expect(page.getByTestId('meta-forms-list').locator('li')).toHaveCount(60);

    expect(await docHeight()).toBe(atFourteen);
  });

  test('is two across on a desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, 'admin');
    await openForms(page);

    expect(await rowSizes(page)).toEqual([2, 2, 2, 2, 2, 2, 2]);
  });

  test('is two across on a tablet', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await signIn(page, 'admin');
    await openForms(page);

    expect(await rowSizes(page)).toEqual([2, 2, 2, 2, 2, 2, 2]);
  });

  test('is one across on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, 'admin');
    await openForms(page);

    expect(await rowSizes(page)).toEqual(Array(14).fill(1));
  });

  test('the two columns are EQUAL, and no card overflows its column', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, 'admin');
    await openForms(page);

    const geom = await page.getByTestId('meta-forms-list').evaluate((ul) => {
      const li = [...ul.querySelectorAll('li')];
      return {
        widths: [...new Set(li.map((e) => Math.round(e.getBoundingClientRect().width)))],
        clipped: li.some((e) => e.scrollWidth > e.clientWidth + 1),
        inside: li.every((e) => e.getBoundingClientRect().right <= ul.getBoundingClientRect().right + 1),
      };
    });

    expect(geom.widths).toHaveLength(1);   // `1fr 1fr`, so one width for all of them
    expect(geom.clipped).toBe(false);      // no name cut off by the narrower column
    expect(geom.inside).toBe(true);        // nothing sitting under the scrollbar
  });

  test('selecting a form still works, including one that the reordering moved', async ({ page }) => {
    await signIn(page, 'admin');
    await openForms(page);

    // Form 14 renders seventh now rather than last; selection must follow the form, not the slot.
    const card = page.getByRole('button', { name: /14 Active Lakeside/ });
    await card.click();
    await expect(card).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(/form=form-14/);

    // Pressing it again clears the filter, as it did before.
    await card.click();
    await expect(card).toHaveAttribute('aria-pressed', 'false');
  });

  test('a selected form survives a reload, and the order is unchanged', async ({ page }) => {
    await signIn(page, 'admin');
    await openForms(page);

    await page.getByRole('button', { name: /04 Active Waterfront/ }).click();
    await expect(page).toHaveURL(/form=form-4/);

    await page.reload();
    await expect(page.getByTestId('meta-forms-list')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /04 Active Waterfront/ }))
      .toHaveAttribute('aria-pressed', 'true');
    expect(await renderedOrder(page)).toEqual(EXPECTED);
  });
});
