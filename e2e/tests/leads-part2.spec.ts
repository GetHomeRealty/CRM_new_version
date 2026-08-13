import { test, expect } from '@playwright/test';
import { signIn, apiGet, apiSend } from './helpers';

/**
 * CRM › Leads — the half the first pass did not reach.
 *
 * Tags, tasks, showings, calls, email, import, export, bulk operations and transfer-ownership.
 * Written after M-1 was fixed, so validation failures are expected to be 422 here — that
 * expectation is itself the regression test for the fix.
 */

const unique = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const created: number[] = [];

async function newLead(page: import('@playwright/test').Page, over: Record<string, unknown> = {}) {
  const res = await apiSend(page, 'POST', '/api/leads', {
    name: 'Part2 Subject', email: `${unique('p2')}@example.test`, phone: '416-555-0101', ...over,
  });
  const id = (res.body as { id?: number })?.id;
  if (typeof id === 'number') created.push(id);
  return { res, id: id as number };
}

test.afterAll(async ({ browser }) => {
  if (!created.length) return;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await signIn(page, 'agent');
    for (const id of created) await apiSend(page, 'DELETE', `/api/leads/${id}`);
  } finally { await ctx.close(); }
});

test.beforeEach(async ({ page }) => { await signIn(page, 'agent'); await page.goto('/crm/lead'); });

// ------------------------------------------------------------------ M-1 regression
test.describe('validation status (M-1 regression)', () => {
  test('validation failures now return 422, matching the rest of the API', async ({ page }) => {
    const res = await apiSend(page, 'POST', '/api/leads', {});
    expect(res.status).toBe(422);
    const body = res.body as { message: string; errors: Record<string, string[]> };
    expect(body.errors.name).toBeTruthy();
    expect(body.errors.email).toBeTruthy();
    // The summary line is built by the shared helper, so it reads like every other 422.
    expect(body.message).toMatch(/more error/i);
  });
});

// ------------------------------------------------------------------ tags
test.describe('tags', () => {
  test('creates, lists and deletes a tag', async ({ page }) => {
    const name = unique('tag');
    expect((await apiSend(page, 'POST', '/api/leads/tags', { tag: name })).status).toBeLessThan(300);

    const list = await apiGet(page, '/api/leads/tags');
    expect(JSON.stringify(list.body)).toContain(name);

    expect((await apiSend(page, 'DELETE', `/api/leads/tags?tag=${encodeURIComponent(name)}`)).status).toBeLessThan(300);
  });

  /**
   * The tag picker on the lead editor, in the browser.
   *
   * The Tags field was free text with no list of what the brokerage already uses, so the only way
   * to reuse a tag was to remember it and spell it identically. That is not a cosmetic gap: tags
   * select campaign audiences by exact name, so "VIP" typed here and "vip" on the Tags screen are
   * two audiences, and a lead tagged with a near-miss quietly misses the campaign it was meant for.
   *
   * The API tests above prove tags can be created and listed. They cannot prove the EDITOR offers
   * them — which was exactly the gap: every endpoint behaved, and the screen still showed a bare
   * text box.
   */
  test('the lead editor offers the tags that already exist', async ({ page }) => {
    const name = unique('picker');
    expect((await apiSend(page, 'POST', '/api/leads/tags', { tag: name })).status).toBeLessThan(300);

    try {
      await page.goto('/crm/lead');
      await page.getByRole('button', { name: 'Edit' }).first().click();

      const modal = page.locator('.modal').filter({ has: page.getByText('Tags', { exact: true }) });
      const picker = modal.locator('select').filter({ hasText: 'Add an existing tag' });
      await expect(picker).toBeVisible({ timeout: 15_000 });

      // The tag just registered is offered, even though no lead carries it yet — the registry is
      // the point, not what happens to be in use.
      await picker.selectOption(name);

      /*
       * Picking APPENDS to the comma-separated field rather than replacing it.
       *
       * Matched on the START of the placeholder, not on "Comma-separated": the property-preferences
       * section further down has its own comma-separated field ("Finished basement, South-facing
       * yard"), so the looser match finds two inputs and this asserts against whichever comes first.
       */
      const field = modal.locator('input[placeholder^="Comma-separated, e.g. Expo-2026"]');
      await expect(field).toHaveValue(new RegExp(name));
    } finally {
      await apiSend(page, 'DELETE', `/api/leads/tags?tag=${encodeURIComponent(name)}`);
    }
  });

  test('an empty tag name is refused', async ({ page }) => {
    const res = await apiSend(page, 'POST', '/api/leads/tags', { tag: '   ' });
    expect([400, 422]).toContain(res.status);
  });

  test('applying a tag to no leads is refused', async ({ page }) => {
    const res = await apiSend(page, 'POST', '/api/leads/tag', { tag: 'x', lead_ids: [] });
    expect([400, 422]).toContain(res.status);
  });

  test('a tag cannot be applied to another agent’s lead', async ({ page, context }) => {
    await context.clearCookies();
    await signIn(page, 'agent2');
    const theirs = await apiGet(page, '/api/leads?page=1');
    const body = theirs.body as { data?: { id: number }[]; leads?: { id: number }[] };
    const victim = (body.data ?? body.leads ?? [])[0]?.id;

    await context.clearCookies();
    await signIn(page, 'agent');
    const res = await apiSend(page, 'POST', '/api/leads/tag', { tag: unique('sneak'), lead_ids: [victim] });
    // Either refused outright, or silently scoped to nothing — but never applied.
    if (res.status < 300) {
      await context.clearCookies();
      await signIn(page, 'agent2');
      const after = await apiGet(page, `/api/leads/${victim}`);
      expect(JSON.stringify(after.body)).not.toContain('sneak');
    }
  });
});

// ------------------------------------------------------------------ tasks
test.describe('tasks', () => {
  test('adds, lists, updates and removes a task', async ({ page }) => {
    const { id } = await newLead(page);

    const add = await apiSend(page, 'POST', `/api/leads/${id}/tasks`, {
      title: 'Call back about 12 Elm', due_date: '2026-09-01',
    });
    expect(add.status).toBeLessThan(300);
    const taskId = (add.body as { id?: number }).id
      ?? (add.body as { task?: { id: number } }).task?.id;
    expect(taskId).toBeTruthy();

    /*
     * The feed is PAGED, so "is it somewhere in the response" is not a safe assertion — it passed
     * only while an agent had fewer than one page of tasks, and quietly became a test of the seed
     * size rather than of the endpoint. Assert the shape, then find the task where it actually is:
     * on the lead it belongs to.
     */
    const feed = await apiGet(page, '/api/leads/tasks');
    const body = feed.body as { data: { id: number }[]; meta: { per_page: number; total: number }; summary: { total: number } };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeLessThanOrEqual(body.meta.per_page);
    // The counters describe every task, not the page — that is what the dashboard heading reads.
    expect(body.summary.total).toBe(body.meta.total);
    expect(body.meta.total).toBeGreaterThan(0);

    const onTheLead = await apiGet(page, `/api/leads/${id}`);
    expect(JSON.stringify((onTheLead.body as { tasks: unknown[] }).tasks)).toContain('Call back about 12 Elm');

    expect((await apiSend(page, 'PUT', `/api/leads/${id}/tasks/${taskId}`,
      { title: 'Renamed', status: 'completed' })).status).toBeLessThan(300);
    expect((await apiSend(page, 'DELETE', `/api/leads/${id}/tasks/${taskId}`)).status).toBeLessThan(300);
  });

  test('a task on a nonexistent lead is refused', async ({ page }) => {
    const res = await apiSend(page, 'POST', '/api/leads/99999999/tasks', { title: 'ghost' });
    expect([403, 404, 422]).toContain(res.status);
  });

  test('a task with no title is refused', async ({ page }) => {
    const { id } = await newLead(page);
    const res = await apiSend(page, 'POST', `/api/leads/${id}/tasks`, { title: '' });
    expect([400, 422]).toContain(res.status);
  });
});

// ------------------------------------------------------------------ showings
test.describe('showings', () => {
  test('adds and removes a showing', async ({ page }) => {
    const { id } = await newLead(page);
    const add = await apiSend(page, 'POST', `/api/leads/${id}/showings`, {
      showing_date: '2026-09-15', time: '14:00', property: '12 Elm Street',
    });
    expect(add.status).toBeLessThan(300);

    const feed = await apiGet(page, '/api/leads/showings');
    expect(feed.status).toBe(200);

    const showingId = (add.body as { id?: number }).id;
    if (showingId) {
      expect((await apiSend(page, 'DELETE', `/api/leads/${id}/showings/${showingId}`)).status).toBeLessThan(300);
    }
  });

  test('an impossible showing date is refused', async ({ page }) => {
    const { id } = await newLead(page);
    const res = await apiSend(page, 'POST', `/api/leads/${id}/showings`, {
      showing_date: '2026-02-31', time: '14:00',
    });
    expect([400, 422]).toContain(res.status);
  });
});

// ------------------------------------------------------------------ notes
test.describe('notes', () => {
  test('adds, edits and deletes a note', async ({ page }) => {
    const { id } = await newLead(page);
    const add = await apiSend(page, 'POST', `/api/leads/${id}/notes`, { content: 'Spoke to client' });
    expect(add.status).toBeLessThan(300);

    const noteId = (add.body as { id?: number }).id;
    if (noteId) {
      expect((await apiSend(page, 'PUT', `/api/leads/${id}/notes/${noteId}`, { content: 'Edited' })).status).toBeLessThan(300);
      expect((await apiSend(page, 'DELETE', `/api/leads/${id}/notes/${noteId}`)).status).toBeLessThan(300);
    }
  });

  test('a note is not readable on another agent’s lead', async ({ page, context }) => {
    await context.clearCookies();
    await signIn(page, 'agent2');
    const theirs = await apiGet(page, '/api/leads?page=1');
    const body = theirs.body as { data?: { id: number }[]; leads?: { id: number }[] };
    const victim = (body.data ?? body.leads ?? [])[0]?.id;

    await context.clearCookies();
    await signIn(page, 'agent');
    const res = await apiSend(page, 'POST', `/api/leads/${victim}/notes`, { content: 'injected' });
    expect([403, 404]).toContain(res.status);
  });
});

// ------------------------------------------------------------------ calls
test.describe('call logging', () => {
  test('logs a manual call and removes it', async ({ page }) => {
    const { id } = await newLead(page);
    const add = await apiSend(page, 'POST', `/api/leads/${id}/calls`, {
      called_at: new Date().toISOString(), outcome: 'connected', notes: 'Discussed offer', duration: 120,
    });
    expect(add.status).toBeLessThan(300);

    const callId = (add.body as { id?: number }).id;
    if (callId) {
      expect((await apiSend(page, 'DELETE', `/api/leads/${id}/calls/${callId}`)).status).toBeLessThan(300);
    }
  });

  test('placing a call on another agent’s lead is refused', async ({ page, context }) => {
    await context.clearCookies();
    await signIn(page, 'agent2');
    const theirs = await apiGet(page, '/api/leads?page=1');
    const body = theirs.body as { data?: { id: number }[]; leads?: { id: number }[] };
    const victim = (body.data ?? body.leads ?? [])[0]?.id;

    await context.clearCookies();
    await signIn(page, 'agent');
    const res = await apiSend(page, 'POST', `/api/leads/${victim}/call`, {});
    expect([400, 403, 404, 422, 503]).toContain(res.status);
    expect(res.status, 'must not succeed').not.toBe(200);
  });
});

// ------------------------------------------------------------------ email
test.describe('lead email', () => {
  test('sending to another agent’s lead is refused', async ({ page, context }) => {
    await context.clearCookies();
    await signIn(page, 'agent2');
    const theirs = await apiGet(page, '/api/leads?page=1');
    const body = theirs.body as { data?: { id: number }[]; leads?: { id: number }[] };
    const victim = (body.data ?? body.leads ?? [])[0]?.id;

    await context.clearCookies();
    await signIn(page, 'agent');
    const res = await apiSend(page, 'POST', `/api/leads/${victim}/email`, {
      subject: 'Hello', body: 'Test',
    });
    expect(res.status).not.toBe(200);
    expect([400, 403, 404, 422, 500, 503]).toContain(res.status);
  });

  test('an email with no subject or body is refused', async ({ page }) => {
    const { id } = await newLead(page);
    const res = await apiSend(page, 'POST', `/api/leads/${id}/email`, {});
    expect(res.status).not.toBe(200);
  });
});

// ------------------------------------------------------------------ export
test.describe('export', () => {
  test('exports only the caller’s own leads', async ({ page }) => {
    const res = await apiSend(page, 'POST', '/api/leads/export', { format: 'csv' });
    expect(res.status).toBeLessThan(400);

    const text = JSON.stringify(res.body);
    // agent2's leads must not appear in agent's export — the scope rule has to hold on the way
    // out of the system as firmly as it does on screen.
    expect(text).not.toContain('Renée Beaulieu');
    expect(text).not.toContain("Fionnuala O'Shea");
  });

  test('export is refused when signed out', async ({ browser }) => {
    const ctx = await browser.newContext();
    const fresh = await ctx.newPage();
    try {
      await fresh.goto('/login');
      const res = await apiSend(fresh, 'POST', '/api/leads/export', { format: 'csv' });
      expect([401, 419]).toContain(res.status);
    } finally { await ctx.close(); }
  });
});

// ------------------------------------------------------------------ import
test.describe('import', () => {
  test('rejects an import with no rows', async ({ page }) => {
    const res = await apiSend(page, 'POST', '/api/leads/import', { rows: [] });
    expect(res.status).not.toBe(200);
  });

  test('rejects rows missing the required fields', async ({ page }) => {
    const res = await apiSend(page, 'POST', '/api/leads/import', {
      rows: [{ phone: '416-555-0000' }],
      mapping: { phone: 'phone' },
    });
    // Either refused outright, or accepted as a job that reports the row as failed — but it must
    // never silently create a nameless, email-less lead.
    if (res.status < 300) {
      const list = await apiGet(page, '/api/leads?page=1&limit=100');
      const names = JSON.stringify(list.body);
      expect(names).not.toContain('"name":""');
      expect(names).not.toContain('"name":null');
    }
  });

  test('recent imports are listed', async ({ page }) => {
    const res = await apiGet(page, '/api/leads/imports/recent');
    expect(res.status).toBe(200);
  });
});

// ------------------------------------------------------------------ bulk + transfer
test.describe('bulk operations and ownership transfer', () => {
  test('bulk delete only removes the caller’s own leads', async ({ page, context }) => {
    await context.clearCookies();
    await signIn(page, 'agent2');
    const theirs = await apiGet(page, '/api/leads?page=1');
    const body = theirs.body as { data?: { id: number }[]; leads?: { id: number }[] };
    const victim = (body.data ?? body.leads ?? [])[0]?.id;

    await context.clearCookies();
    await signIn(page, 'agent');
    const { id: mine } = await newLead(page, { name: 'Bulk Mine' });

    await apiSend(page, 'POST', '/api/leads/bulk-delete', { ids: [mine, victim] });

    // agent2's lead must survive regardless of what the call reported.
    await context.clearCookies();
    await signIn(page, 'agent2');
    expect((await apiGet(page, `/api/leads/${victim}`)).status).toBe(200);
  });

  test('an agent cannot transfer ownership', async ({ page }) => {
    // Reassigning a book is a management action; an agent doing it to themselves would be a
    // privilege escalation straight past the scope rule.
    const res = await apiSend(page, 'POST', '/api/leads/transfer-ownership', {
      from_user_id: 4, to_user_id: 3,
    });
    expect(res.status).not.toBe(200);
    expect([400, 403, 404, 422]).toContain(res.status);
  });
});

// ------------------------------------------------------------------ deleted list
test.describe('recycle bin', () => {
  test('a deleted lead can be permanently removed', async ({ page }) => {
    const { id } = await newLead(page, { name: 'Hard Delete Subject' });
    await apiSend(page, 'DELETE', `/api/leads/${id}`);

    const purge = await apiSend(page, 'DELETE', `/api/leads/deleted/${id}`);
    expect(purge.status).toBeLessThan(300);

    // Gone from both the live list and the recycle bin.
    expect((await apiGet(page, `/api/leads/${id}`)).status).toBe(404);
    const bin = await apiGet(page, '/api/leads/deleted');
    expect(JSON.stringify(bin.body)).not.toContain('Hard Delete Subject');
  });

  test('another agent’s deleted lead cannot be purged', async ({ page, context }) => {
    await context.clearCookies();
    await signIn(page, 'agent2');
    const { id } = await newLead(page, { name: 'Agent2 Bin Subject' });
    await apiSend(page, 'DELETE', `/api/leads/${id}`);

    await context.clearCookies();
    await signIn(page, 'agent');
    const res = await apiSend(page, 'DELETE', `/api/leads/deleted/${id}`);
    expect([403, 404]).toContain(res.status);
  });
});

// ------------------------------------------------------------------ B-1: recycle bin pagination
test.describe('recycle bin pagination', () => {
  test('returns pagination metadata alongside the rows', async ({ page }) => {
    const res = await apiGet(page, '/api/leads/deleted');
    expect(res.status).toBe(200);
    const body = res.body as { count: number; data: unknown[]; meta?: Record<string, number> };

    // `meta` is the fix: without it the caller cannot tell a full page from a truncated one.
    expect(body.meta).toBeTruthy();
    expect(body.meta!.page).toBe(1);
    expect(body.meta!.total).toBe(body.count);
    expect(body.meta!.last_page).toBeGreaterThanOrEqual(1);
    // `count` is retained so the existing client keeps working.
    expect(typeof body.count).toBe('number');
  });

  test('honours page and limit, and pages do not overlap', async ({ page }) => {
    // Three deletions is enough to page over with limit=1 and prove the boundaries.
    const ids: number[] = [];
    for (const n of [1, 2, 3]) {
      const { id } = await newLead(page, { name: `Bin Page ${n}` });
      await apiSend(page, 'DELETE', `/api/leads/${id}`);
      ids.push(id);
    }

    const p1 = await apiGet(page, '/api/leads/deleted?page=1&limit=1');
    const p2 = await apiGet(page, '/api/leads/deleted?page=2&limit=1');
    const first = (p1.body as { data: { id: number }[] }).data;
    const second = (p2.body as { data: { id: number }[] }).data;

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0].id).not.toBe(second[0].id);

    const meta = (p1.body as { meta: { per_page: number; last_page: number; total: number } }).meta;
    expect(meta.per_page).toBe(1);
    expect(meta.total).toBeGreaterThanOrEqual(3);
    expect(meta.last_page).toBe(meta.total);

    for (const id of ids) await apiSend(page, 'POST', `/api/leads/deleted/${id}/restore`);
  });

  test('a page beyond the end returns empty rather than erroring', async ({ page }) => {
    const res = await apiGet(page, '/api/leads/deleted?page=9999&limit=10');
    expect(res.status).toBe(200);
    expect((res.body as { data: unknown[] }).data).toHaveLength(0);
  });

  test('limit is clamped and nonsense values fall back to the default', async ({ page }) => {
    for (const q of ['limit=99999', 'limit=0', 'limit=-5', 'limit=abc', 'page=-1', 'page=abc']) {
      const res = await apiGet(page, `/api/leads/deleted?${q}`);
      expect(res.status, `?${q} errored`).toBe(200);
      const meta = (res.body as { meta: { per_page: number; page: number } }).meta;
      expect(meta.per_page).toBeGreaterThan(0);
      expect(meta.per_page).toBeLessThanOrEqual(200);   // MAX_PER_PAGE
      expect(meta.page).toBeGreaterThanOrEqual(1);
    }
  });

  test('still only shows the caller’s own deleted leads', async ({ page, context }) => {
    await context.clearCookies();
    await signIn(page, 'agent2');
    const { id } = await newLead(page, { name: 'Agent2 Deleted Private' });
    await apiSend(page, 'DELETE', `/api/leads/${id}`);

    await context.clearCookies();
    await signIn(page, 'agent');
    const res = await apiGet(page, '/api/leads/deleted?limit=200');
    expect(JSON.stringify(res.body)).not.toContain('Agent2 Deleted Private');
  });
});

// ------------------------------------------------------------------ audit health
test.describe('audit trail health', () => {
  test('failed audit writes are reported on the health endpoint', async ({ page }) => {
    // Audit writes never fail a user action, so nothing else in the system would report a broken
    // compliance trail. This is the surface the monitor reads.
    const res = await apiGet(page, '/api/health/workers');
    expect(res.status).toBe(200);
    const audit = (res.body as { audit?: Record<string, unknown> }).audit;
    expect(audit).toBeTruthy();
    expect(audit!).toHaveProperty('failures');
    expect(audit!).toHaveProperty('last_failed_at');
    expect(audit!).toHaveProperty('last_error');
    // Healthy right now: any non-zero value here means the trail has gaps.
    expect(audit!.failures).toBe(0);
  });
});
