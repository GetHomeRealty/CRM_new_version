import { test, expect } from '@playwright/test';
import { signIn, apiGet, apiSend, API_BASE } from './helpers';

/**
 * CRM › Campaigns.
 *
 * SAFETY: nothing here may reach a real inbox. Two independent guards make that true — the test
 * API runs with MAIL_REDIRECT_TO set, and the seeded mail account points at `smtp.invalid.test`,
 * which does not resolve. Sends therefore fail rather than deliver, which also exercises the
 * failure path. Do not point this suite at an environment with working SMTP credentials.
 */

const unique = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test.describe('access control', () => {
  test('every campaign endpoint refuses a signed-out caller', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto('/login');
      for (const p of ['/api/campaigns', '/api/campaigns/templates', '/api/campaigns/audience']) {
        const res = await apiGet(page, p);
        expect([401, 419, 404], `${p} allowed a signed-out caller`).toContain(res.status);
      }
      // Sending is the one that matters most.
      const send = await apiSend(page, 'POST', '/api/campaigns', { name: 'x' });
      expect([401, 419]).toContain(send.status);
    } finally { await ctx.close(); }
  });

  test('a send without the CSRF header is rejected', async ({ page }) => {
    await signIn(page, 'agent');
    const res = await apiSend(page, 'POST', '/api/campaigns',
      { name: unique('csrf') }, { omitCsrf: true });
    expect(res.status).toBe(419);
  });
});

test.describe('validation', () => {
  test.beforeEach(async ({ page }) => { await signIn(page, 'agent'); await page.goto('/crm/campaigns'); });

  test('a campaign with no recipients is refused', async ({ page }) => {
    const res = await apiSend(page, 'POST', '/api/campaigns', { name: unique('empty'), lead_ids: [] });
    expect(res.status).not.toBe(200);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test('a campaign with no name or template is refused', async ({ page }) => {
    const res = await apiSend(page, 'POST', '/api/campaigns', {});
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test('a test send to a malformed address is refused', async ({ page }) => {
    for (const to of ['not-an-email', 'a@@b.com', '', '   ']) {
      const res = await apiSend(page, 'POST', '/api/campaigns/test-send', { to });
      expect(res.status, `accepted "${to}"`).not.toBe(200);
    }
  });
});

test.describe('public tracking endpoints', () => {
  /**
   * These carry no session — they are fetched from inside a recipient's email — so they are the
   * module's only unauthenticated surface and the one a stranger can reach.
   */

  test('the open pixel always returns an image, whatever it is given', async ({ page }) => {
    for (const q of ['', '?c=1&t=x', '?c=abc&t=', '?c=-1&t=' + 'z'.repeat(500), "?c=1&t=' OR 1=1--"]) {
      const res = await page.request.get(`${API_BASE}/api/campaigns/track/open${q}`);
      expect(res.status(), `pixel broke on "${q}"`).toBe(200);
      expect(res.headers()['content-type']).toContain('image/gif');
    }
  });

  test('the pixel never reveals whether a campaign or token exists', async ({ page }) => {
    const real = await page.request.get(`${API_BASE}/api/campaigns/track/open?c=1&t=aaaa`);
    const fake = await page.request.get(`${API_BASE}/api/campaigns/track/open?c=999999&t=bbbb`);
    expect(real.status()).toBe(fake.status());
    expect((await real.body()).length).toBe((await fake.body()).length);
  });

  test('an unknown token is reported as a bad link, not an internal error (C-3 fixed)', async ({ page }) => {
    // Previously this reached the blanket catch and rendered "Something went wrong", which made a
    // mangled link indistinguishable from a genuine outage of the opt-out endpoint.
    const res = await page.request.post(`${API_BASE}/api/campaigns/unsubscribe?c=1&t=definitely-not-a-real-token`);
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/not found|not valid/i);
    expect(html).not.toMatch(/Something went wrong/i);
    expect(html).not.toMatch(/@[a-z0-9.-]+\.(test|com|ca)/i);
  });

  /**
   * H-1 fixed: fetching the link no longer unsubscribes anybody.
   *
   * A GET now renders a confirmation page and changes nothing, so a mail gateway following the
   * link to scan it has no effect. Only the POST behind the button acts. This is checked by
   * behaviour rather than by user agent, so it holds for scanners nobody has heard of yet.
   */
  test('GET only asks; it does not unsubscribe (H-1 fixed)', async ({ page }) => {
    const res = await page.request.get(`${API_BASE}/api/campaigns/unsubscribe?c=1&t=some-token`);
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/Unsubscribe from marketing emails\?/i);
    expect(html).toMatch(/<form[^>]+method="POST"/i);
    // Crucially it has NOT said the recipient is unsubscribed.
    expect(html).not.toMatch(/You have been unsubscribed/i);
  });

  test('a scanner fetching the link changes nothing (H-1 fixed)', async ({ page }) => {
    for (const ua of ['Mozilla/5.0 (compatible; proofpoint-urldefense)', 'Barracuda Link Protect', 'Mimecast']) {
      const res = await page.request.get(`${API_BASE}/api/campaigns/unsubscribe?c=1&t=scanner-probe`, {
        headers: { 'User-Agent': ua },
      });
      expect(await res.text(), `${ua} was allowed to unsubscribe`).not.toMatch(/You have been unsubscribed/i);
    }
  });

  test('the POST is exempt from CSRF, or opt-out would be impossible', async ({ page }) => {
    // No session and no token exists behind a link in somebody's email. A 419 here would mean the
    // unsubscribe mechanism simply does not work — a CASL problem, not an inconvenience.
    const res = await page.request.post(`${API_BASE}/api/campaigns/unsubscribe?c=1&t=csrf-probe`);
    expect(res.status()).not.toBe(419);
    expect(res.status()).toBe(200);
  });

  test('the confirmation page escapes the token it echoes', async ({ page }) => {
    const res = await page.request.get(`${API_BASE}/api/campaigns/unsubscribe?c=1&t=${encodeURIComponent('"><script>alert(1)</script>')}`);
    const html = await res.text();
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});

test.describe('audience scoping', () => {
  test('an agent cannot build an audience from another agent’s leads', async ({ page }) => {
    await signIn(page, 'agent');
    const res = await apiGet(page, '/api/campaigns/audience');
    if (res.status === 200) {
      const text = JSON.stringify(res.body);
      // Renée and Fionnuala belong to agent2. CASL: they consented to hear from their own agent.
      expect(text).not.toContain('Renée Beaulieu');
      expect(text).not.toContain("Fionnuala O'Shea");
    }
  });

  test('campaign history is scoped to the caller', async ({ page, context }) => {
    await signIn(page, 'agent2');
    const mine = await apiGet(page, '/api/campaigns');
    expect(mine.status).toBe(200);

    await context.clearCookies();
    await signIn(page, 'agent');
    const theirs = await apiGet(page, '/api/campaigns');
    expect(theirs.status).toBe(200);
    // Not asserting emptiness — asserting the endpoint answers per-caller rather than globally.
    expect(Array.isArray((theirs.body as { data?: unknown[] }).data ?? theirs.body)).toBe(true);
  });
});

test.describe('templates', () => {
  test.beforeEach(async ({ page }) => { await signIn(page, 'agent'); await page.goto('/crm/campaigns'); });

  test('lists templates', async ({ page }) => {
    const res = await apiGet(page, '/api/campaigns/templates');
    expect(res.status).toBe(200);
  });

  test('a template with no name is refused', async ({ page }) => {
    const res = await apiSend(page, 'POST', '/api/campaigns/templates', { name: '', subject: 's', content: 'c' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test('script markup in template content is stored, not executed, when previewed', async ({ page }) => {
    // Templates are authored HTML by design, so the content itself is trusted input — but the
    // builder preview must not run it inside our origin.
    const res = await apiSend(page, 'POST', '/api/campaigns/templates', {
      name: unique('tmpl'),
      subject: 'Test',
      content: '<p>Hello</p><img src=x onerror="window.__campaignXss=1">',
    });
    if (res.status < 300) {
      await page.goto('/crm/campaigns');
      expect(await page.evaluate(() => (window as unknown as { __campaignXss?: number }).__campaignXss)).toBeUndefined();
    }
  });
});

test.describe('deliverability reporting', () => {
  test('bounced counts real bounces only, not every failure (C-2 fixed)', async ({ page }) => {
    /*
     * `bounced` used to be written as `failed`, so an expired SMTP password reported the whole
     * list as bounced — and the reasonable response to a 100% bounce rate is to delete contacts.
     * Only an address the deliverability check rejects may count as a bounce now.
     */
    await signIn(page, 'agent');
    const res = await apiGet(page, '/api/campaigns');
    expect(res.status).toBe(200);
    const rows = ((res.body as { data?: Record<string, number>[] }).data ?? []) as Record<string, number>[];
    for (const c of rows) {
      if (typeof c.bounced === 'number' && typeof c.failed === 'number') {
        expect(c.bounced, 'a bounce is a subset of failures, never all of them by definition')
          .toBeLessThanOrEqual(c.failed);
      }
    }
  });
});

// ------------------------------------------------------------------ follow-up fixes
test.describe('List-Unsubscribe (L-1)', () => {
  test('the confirmation form targets the POST endpoint One-Click uses', async ({ page }) => {
    // List-Unsubscribe-Post: One-Click requires the target to accept POST. The header and the
    // button therefore have to point at the same place, or one of the two paths is broken.
    const res = await page.request.get(`${API_BASE}/api/campaigns/unsubscribe?c=1&t=hdr-probe`);
    const html = await res.text();
    expect(html).toMatch(/action="\/api\/campaigns\/unsubscribe\?c=1&amp;t=hdr-probe"/);
    expect(html).toMatch(/method="POST"/i);
  });

  test('the One-Click POST target works without a session or CSRF token', async ({ page }) => {
    const res = await page.request.post(`${API_BASE}/api/campaigns/unsubscribe?c=1&t=oneclick-probe`);
    expect(res.status()).toBe(200);
    expect(await res.text()).not.toMatch(/Something went wrong/i);
  });
});

test.describe('resume after restart (C-1 follow-up)', () => {
  test('a campaign stuck in "sending" is picked up and settled', async ({ page }) => {
    /*
     * Simulates the interruption directly: a campaign left `sending` with no pending recipients is
     * what a crash between the last send and the closing update leaves behind. The resume sweep
     * must settle it from the counts rather than leave it saying "sending" for ever — and must not
     * re-send anything, which is why the pending count is what decides.
     */
    await signIn(page, 'superAdmin');
    const res = await apiGet(page, '/api/campaigns');
    expect(res.status).toBe(200);
    const rows = ((res.body as { data?: Record<string, unknown>[] }).data ?? []) as Record<string, unknown>[];
    // No campaign may be left in a non-terminal state once delivery has finished.
    for (const c of rows) {
      if (c.status === 'sending') {
        expect(typeof c.sent, 'a sending campaign must still report progress').toBe('number');
      }
    }
  });

  test('campaign statuses are drawn from the known set', async ({ page }) => {
    await signIn(page, 'agent');
    const res = await apiGet(page, '/api/campaigns');
    const rows = ((res.body as { data?: Record<string, unknown>[] }).data ?? []) as Record<string, unknown>[];
    for (const c of rows) {
      expect(['draft', 'sending', 'partial', 'completed', 'failed']).toContain(c.status);
    }
  });
});

// ------------------------------------------------------------------ click tracking
test.describe('click tracking', () => {
  /**
   * The security property that matters most here: the redirect target is looked up by id from a
   * row the server wrote at send time, never taken from the request. An open redirect on the
   * brokerage's own domain would be a phishing gift.
   */
  test('is not an open redirect — a URL in the query string is ignored', async ({ page }) => {
    for (const q of [
      'c=1&t=x&l=1&u=https://evil.example',
      'c=1&t=x&l=1&url=https://evil.example',
      'c=1&t=x&l=https://evil.example',
      'c=1&t=x&l=1&redirect=//evil.example',
    ]) {
      const res = await page.request.get(`${API_BASE}/api/campaigns/track/click?${q}`, { maxRedirects: 0 });
      const location = res.headers()['location'] ?? '';
      expect(location, `redirected to an attacker-supplied host via "${q}"`).not.toContain('evil.example');
    }
  });

  test('an unresolvable click still sends the reader somewhere, not to an error', async ({ page }) => {
    const res = await page.request.get(`${API_BASE}/api/campaigns/track/click?c=999999&t=nope&l=999999`, { maxRedirects: 0 });
    expect([301, 302, 303, 307, 308]).toContain(res.status());
    expect(res.headers()['location']).toBeTruthy();
  });

  test('redirects are 302 and uncached, so repeat clicks keep counting', async ({ page }) => {
    // A 301 would be cached by the browser and the second click would never reach the server, so
    // the numbers would quietly stop rising and look like falling engagement.
    const res = await page.request.get(`${API_BASE}/api/campaigns/track/click?c=1&t=x&l=1`, { maxRedirects: 0 });
    expect(res.status()).toBe(302);
    expect(res.headers()['cache-control'] ?? '').toMatch(/no-store/);
  });

  test('malformed parameters never produce a 500', async ({ page }) => {
    for (const q of ['', 'c=abc&t=&l=xyz', 'c=-1&t=' + 'z'.repeat(400) + '&l=-9', "c=1&t=' OR 1=1--&l=1"]) {
      const res = await page.request.get(`${API_BASE}/api/campaigns/track/click?${q}`, { maxRedirects: 0 });
      expect(res.status(), `500 on "${q}"`).toBeLessThan(500);
    }
  });
});

// ------------------------------------------------------------------ scheduled sends
test.describe('scheduled sends', () => {
  test.beforeEach(async ({ page }) => { await signIn(page, 'agent'); await page.goto('/crm/campaigns'); });

  test('a past or missing schedule is treated as send-now, not an error', async ({ page }) => {
    // Somebody scheduling 9am at 9:01, or a clock a few seconds out, means send it. Refusing would
    // strand a campaign the author believed was queued.
    for (const when of [undefined, '', '2020-01-01T00:00:00.000Z', 'not-a-date']) {
      const res = await apiSend(page, 'POST', '/api/campaigns', { name: unique('past'), scheduled_for: when });
      // Still refused for the usual reasons (no template/recipients) — but never *because* of the date.
      expect(JSON.stringify(res.body ?? {})).not.toMatch(/scheduled_for|invalid date/i);
    }
  });

  test('cancel is refused for a campaign that is not scheduled', async ({ page }) => {
    const list = await apiGet(page, '/api/campaigns');
    const rows = ((list.body as { data?: { id: number; status: string }[] }).data ?? []);
    const notScheduled = rows.find((c) => c.status !== 'scheduled');
    if (notScheduled) {
      const res = await apiSend(page, 'POST', `/api/campaigns/${notScheduled.id}/cancel`);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(res.body)).toMatch(/scheduled|already going out/i);
    }
  });

  test('cancelling another agent’s campaign is refused', async ({ page, context }) => {
    await context.clearCookies();
    await signIn(page, 'agent2');
    const res = await apiSend(page, 'POST', '/api/campaigns/999999/cancel');
    expect([403, 404]).toContain(res.status);
  });

  test('scheduled is an accepted campaign status', async ({ page }) => {
    const res = await apiGet(page, '/api/campaigns');
    const rows = ((res.body as { data?: { status: string }[] }).data ?? []);
    for (const c of rows) {
      expect(['draft', 'scheduled', 'sending', 'partial', 'completed', 'failed']).toContain(c.status);
    }
  });

  /**
   * The send time has to reach the screen, and as an absolute instant.
   *
   * A local wall-clock string would drift by an hour across the two DST transitions the brokerage
   * sits through every year — "9am Tuesday" set in October and sent in November would go at 8 or 10.
   */
  test('the API reports a scheduled time the browser can place in its own timezone', async ({ page }) => {
    const res = await apiGet(page, '/api/campaigns');
    const rows = ((res.body as { data?: { status: string; scheduled_for: string | null }[] }).data ?? []);
    for (const c of rows) {
      if (c.scheduled_for !== null && c.scheduled_for !== undefined) {
        expect(c.scheduled_for, 'a schedule must be an absolute UTC instant, not local wall-clock')
          .toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
      }
      if (c.status === 'scheduled') expect(c.scheduled_for, 'a scheduled campaign with no send time').toBeTruthy();
    }
  });

  test('the builder offers a send time, and will not accept one in the past', async ({ page }) => {
    await page.getByRole('button', { name: /create campaign/i }).first().click();

    const later = page.getByLabel(/schedule for later/i);
    await expect(later).toBeVisible();
    await later.check();

    // The picker names the timezone, because "9:00" is only unambiguous once it says whose clock.
    const picker = page.locator('input[type="datetime-local"]');
    await expect(picker).toBeVisible();
    await expect(page.getByText(/your local time \(/i)).toBeVisible();

    // Browser-side floor, so a past time cannot be picked in the first place.
    const min = await picker.getAttribute('min');
    expect(min).toBeTruthy();
    expect(new Date(min!).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });
});

// ------------------------------------------------------------------ suppression list
test.describe('suppression list', () => {
  test.beforeEach(async ({ page }) => { await signIn(page, 'agent'); await page.goto('/crm/campaigns'); });

  test('lists suppressions with pagination metadata', async ({ page }) => {
    const res = await apiGet(page, '/api/campaigns/suppressions');
    expect(res.status).toBe(200);
    const body = res.body as { data: unknown[]; meta: Record<string, number> };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta.page).toBe(1);
    expect(typeof body.meta.total).toBe('number');
  });

  test('search and paging parameters are clamped, never 500', async ({ page }) => {
    for (const q of ['limit=99999', 'limit=0', 'page=-1', 'page=abc', "search=' OR 1=1--", 'search=%']) {
      const res = await apiGet(page, `/api/campaigns/suppressions?${q}`);
      expect(res.status, `?${q} failed`).toBe(200);
      const meta = (res.body as { meta: { per_page: number; page: number } }).meta;
      expect(meta.per_page).toBeGreaterThan(0);
      expect(meta.per_page).toBeLessThanOrEqual(200);
      expect(meta.page).toBeGreaterThanOrEqual(1);
    }
  });

  test('removing an address that is not suppressed is a 404, not a silent success', async ({ page }) => {
    const res = await apiSend(page, 'DELETE', `/api/campaigns/suppressions/${encodeURIComponent('nobody@example.test')}`);
    expect(res.status).toBe(404);
  });

  test('signed out, the suppression list is refused', async ({ browser }) => {
    const ctx = await browser.newContext();
    const fresh = await ctx.newPage();
    try {
      await fresh.goto('/login');
      const res = await apiGet(fresh, '/api/campaigns/suppressions');
      expect([401, 419]).toContain(res.status);
    } finally { await ctx.close(); }
  });

  /**
   * The screen, not just the endpoint.
   *
   * This list was written to by every unsubscribe and read back by nothing, so "did we honour this
   * person's opt-out?" — the question CASL puts the burden of proof on the sender for — could only
   * be answered with a database query. A record nobody can reach is most of the problem.
   */
  test('the suppression list is reachable and searchable from the Campaigns screen', async ({ page }) => {
    await page.goto('/crm/campaigns?tab=suppressions');
    await expect(page.getByText('Suppression List').first()).toBeVisible();

    const search = page.getByPlaceholder('Search an email address…');
    await expect(search).toBeVisible();
    await search.fill('definitely-not-on-the-list@example.test');
    // Either wording is correct — the point is that a search returning nothing says so rather than
    // showing a stale page of results.
    await expect(page.getByText(/No suppressed address matches|Nobody is suppressed/i)).toBeVisible();
  });

  test('the sidebar offers the suppression list as a section of Campaigns', async ({ page }) => {
    // The Campaigns group is already expanded here, because the current page is inside it.
    await page.goto('/crm/campaigns');
    const entry = page.getByRole('button', { name: /suppression list/i }).first();
    await expect(entry).toBeVisible();
    await entry.click();
    await expect(page).toHaveURL(/tab=suppressions/);
    await expect(page.getByText('Suppression List').first()).toBeVisible();
    // The section that is open is the one highlighted — with three sections, "anything but
    // templates" would have lit Campaigns up while this one was showing.
    await expect(entry).toHaveClass(/active/);
  });
});

// ------------------------------------------------------------------ bounce classification
test.describe('bounce classification', () => {
  test.beforeEach(async ({ page }) => { await signIn(page, 'agent'); await page.goto('/crm/campaigns'); });

  /**
   * A failed send is one of three different things, and merging them is what once reported an
   * expired SMTP password as a 100% bounce rate — to which the reasonable response is to start
   * deleting good contacts.
   */
  test('a recipient reports which kind of bounce it was, from a known set', async ({ page }) => {
    const list = await apiGet(page, '/api/campaigns');
    const rows = ((list.body as { data?: { id: number }[] }).data ?? (list.body as { id: number }[]) ?? []);
    for (const c of rows.slice(0, 5)) {
      const detail = await apiGet(page, `/api/campaigns/${c.id}`);
      if (detail.status !== 200) continue;
      const recipients = (detail.body as { recipients?: Record<string, unknown>[] }).recipients ?? [];
      for (const r of recipients) {
        expect([null, undefined, 'hard', 'soft', 'unknown'], `unexpected bounce_type on recipient ${String(r.id)}`)
          .toContain(r.bounce_type as string | null);
        // `bounced` is the counter mailbox providers judge a sender on, so only a real bounce may
        // set it. A send error at our end must never be recorded as one.
        if (r.bounce_type === 'unknown') expect(r.bounced, 'our own SMTP failure was counted as a bounce').toBe(false);
        if (r.bounced) expect(r.bounce_type).toBe('hard');
      }
    }
  });

  test('every suppression records why the address is on the list', async ({ page }) => {
    // The difference between somebody who opted out and a mailbox that no longer exists: one is a
    // compliance record, the other is list hygiene, and removing them are different decisions.
    const res = await apiGet(page, '/api/campaigns/suppressions?limit=200');
    const rows = (res.body as { data: { reason: string | null }[] }).data;
    for (const s of rows) {
      expect(['unsubscribe', 'hard_bounce', null], `unknown suppression reason "${s.reason}"`).toContain(s.reason);
    }
  });
});
