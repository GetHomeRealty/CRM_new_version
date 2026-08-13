import { test, expect, type BrowserContext } from '@playwright/test';
import { signIn, apiGet, apiSend, ACCOUNTS, type AccountKey } from './helpers';

/**
 * PRIORITY 1 — DIRECT API WRITE AUTHORIZATION, Calendar and Inbox.
 *
 * Reads were proven isolated for the Calendar (2026-08-05) and for the Inbox (service-level, this
 * session). Neither proved anything about WRITES, and a write is the failure that alters somebody
 * else's data rather than merely showing it.
 *
 * Every call here goes over HTTP through the real guards, with a real session, because that is the
 * surface an attacker has. Nothing is asserted through the UI: the point is precisely the operations
 * the UI does not offer.
 *
 * THE CONTEXT TRAP, recorded in the Calendar audit and worth repeating because it silently invalidates
 * this whole file: signing in on a new page created from the SAME `BrowserContext` replaces the
 * session cookie for the WHOLE context. Two roles must therefore be two contexts. `as(role)` below
 * makes one context per caller, and every test closes what it opens.
 */

/** One signed-in page in its OWN context, so two roles never share a cookie jar. */
async function as(browser: { newContext: () => Promise<BrowserContext> }, who: AccountKey) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, who);
  return { ctx, page };
}

/*
 * A PROBE DAY NO OTHER SPEC OWNS.
 *
 * These fixtures first used 2026-09-15, which is exactly `calendar-more.spec.ts`'s `DAY`. That file
 * clears the day before and after each test, but only for titles carrying ITS prefix — so events
 * left here survived, inflated the day, and broke its "+X more" count in the full run. Its own
 * header warns about precisely this ("thirty-five stale appointments accumulated on this date"),
 * which is what made the cause findable in one read.
 *
 * A separate month keeps the two apart whatever either one leaves behind, and the sweep below
 * catches anything a killed test could not delete itself.
 */
const PROBE_DAY = '2026-11-04';
const PROBE_DAY_2 = '2026-11-05';

/** IDs nobody owns: never-existed, out of range, and the shapes that reach a parser. */
const GUESSES = ['999999999', '0', '-1', '2147483647'];

/**
 * Delete every probe event left in the probe month, however a test ended.
 *
 * Per-test cleanup is not enough on its own: an assertion timeout kills the test where it stands and
 * the `finally` can be cut short with it. Twenty-one events survived exactly that way while this
 * file was being written, landed on `calendar-more.spec.ts`'s probe day, and broke its "+X more"
 * count in the full run. This sweep is scoped to the probe MONTH, so it can never reach another
 * spec's fixtures.
 */
test.afterAll(async ({ browser }) => {
  for (const who of ['agent', 'agent2'] as const) {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await signIn(page, who);
      const res = await apiGet(page, '/api/calendar/events?area=crm&from=2026-11-01&to=2026-11-30');
      const events = Array.isArray(res.body) ? res.body as { id: number; title: string }[] : [];
      for (const e of events) {
        if (String(e.title).startsWith('ZZ ')) {
          await apiSend(page, 'DELETE', `/api/calendar/events/${e.id}?area=crm&scope=this`).catch(() => undefined);
        }
      }
    } finally { await ctx.close(); }
  }
});

// =============================================================== CALENDAR
test.describe('Calendar — one agent cannot write to another agent\'s event', () => {
  /**
   * An event owned by `agent`, plus its id. Created through the API the UI uses, so the fixture is
   * not a reconstruction of what the application would have stored.
   */
  let probeSeq = 0;

  /*
   * `allow_overlap: true` is not laziness — without it the SECOND test in this file fails, because
   * the calendar refuses a booking that collides with an existing one ("This overlaps … at 10:00").
   * That guard is correct and has its own tests; here it would only make every fixture depend on
   * every previous test having cleaned up. Booking deliberately is what the "Book anyway" button
   * does.
   */
  async function eventOwnedByAgent(page: import('@playwright/test').Page) {
    const title = `ZZ owned ${Date.now()}-${(probeSeq += 1)}`;
    const created = await apiSend(page, 'POST', '/api/calendar/events?area=crm', {
      title, date: PROBE_DAY, time: '10:00', type: 'showing', allow_overlap: true,
    });
    expect(created.status, `create must succeed, got ${created.status} ${JSON.stringify(created.body)}`).toBeLessThan(300);
    const id = (created.body as { id?: number; event?: { id?: number } }).id
      ?? (created.body as { event?: { id?: number } }).event?.id;
    expect(id, 'the create response must carry an id').toBeTruthy();
    return id as number;
  }

  /**
   * Remove a probe event as its owner.
   *
   * Every test here leaves a row behind otherwise, and this file creates one per role per operation.
   * The Leads audit already recorded the rule the hard way: a probe has to undo what it creates,
   * including on the path where its assertion fails.
   */
  async function cleanUp(page: import('@playwright/test').Page, id: number | undefined) {
    if (!id) return;
    await apiSend(page, 'DELETE', `/api/calendar/events/${id}?area=crm`).catch(() => undefined);
  }

  for (const intruder of ['agent2', 'admin', 'superAdmin', 'crm'] as const) {
    test(`${intruder} cannot EDIT it`, async ({ browser }) => {
      const owner = await as(browser, 'agent');
      const other = await as(browser, intruder);
      let id: number | undefined;
      try {
        id = await eventOwnedByAgent(owner.page);
        const before = await apiGet(owner.page, `/api/calendar/events/${id}?area=crm`);

        const r = await apiSend(other.page, 'PUT', `/api/calendar/events/${id}?area=crm`, {
          title: 'HIJACKED', date: PROBE_DAY, time: '10:00',
        });
        expect([403, 404], `${intruder} PUT returned ${r.status}`).toContain(r.status);

        // A refusal that already wrote is not a refusal. Read it back as the OWNER.
        const after = await apiGet(owner.page, `/api/calendar/events/${id}?area=crm`);
        expect((after.body as { title?: string }).title).toBe((before.body as { title?: string }).title);
        expect((after.body as { title?: string }).title).not.toBe('HIJACKED');
      } finally { await cleanUp(owner.page, id); await other.ctx.close(); await owner.ctx.close(); }
    });

    test(`${intruder} cannot DELETE it`, async ({ browser }) => {
      const owner = await as(browser, 'agent');
      const other = await as(browser, intruder);
      let id: number | undefined;
      try {
        id = await eventOwnedByAgent(owner.page);
        const r = await apiSend(other.page, 'DELETE', `/api/calendar/events/${id}?area=crm`);
        expect([403, 404], `${intruder} DELETE returned ${r.status}`).toContain(r.status);

        // Still there, and still the owner's.
        const after = await apiGet(owner.page, `/api/calendar/events/${id}?area=crm`);
        expect(after.status, 'the owner must still be able to read their own event').toBe(200);
      } finally { await cleanUp(owner.page, id); await other.ctx.close(); await owner.ctx.close(); }
    });
  }

  test('a Super Admin is refused like everyone else — the rule the owner stated', async ({ browser }) => {
    // Restated as its own test because it is a product requirement, not an implementation detail:
    // "No one can view or change any other agent's events — not even the admin or super admin."
    const owner = await as(browser, 'agent');
    const sa = await as(browser, 'superAdmin');
    let id: number | undefined;
    try {
      id = await eventOwnedByAgent(owner.page);
      const put = await apiSend(sa.page, 'PUT', `/api/calendar/events/${id}?area=crm`, { title: 'X', date: PROBE_DAY });
      const del = await apiSend(sa.page, 'DELETE', `/api/calendar/events/${id}?area=crm`);
      expect(put.status).not.toBe(200);
      expect(del.status).not.toBe(200);
    } finally { await cleanUp(owner.page, id); await sa.ctx.close(); await owner.ctx.close(); }
  });

  test('an event cannot be created ON BEHALF OF another user', async ({ browser }) => {
    /*
     * `EventInput` has no `user_id`, so the ownership cannot be set from the body — provided the
     * global `whitelist: true` really strips it and nothing downstream reads `body.user_id`. Sending
     * it anyway is the only way to know: mass assignment is invisible until somebody tries it.
     */
    const attacker = await as(browser, 'agent2');
    const victim = await as(browser, 'agent');
    let planted: number | undefined;
    try {
      const me = (await apiGet(attacker.page, '/api/user')).body as { id: number };
      const them = (await apiGet(victim.page, '/api/user')).body as { id: number };
      expect(me.id).not.toBe(them.id);

      const title = `ZZ planted ${Date.now()}`;
      const created = await apiSend(attacker.page, 'POST', '/api/calendar/events?area=crm', {
        title, date: PROBE_DAY_2, time: '11:00', type: 'showing', allow_overlap: true,
        user_id: them.id, owner_user_id: them.id, created_by_id: them.id,
      });
      expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
      planted = (created.body as { id?: number; event?: { id?: number } }).id
        ?? (created.body as { event?: { id?: number } }).event?.id;

      // The victim must not find it; the attacker must.
      const victimList = await apiGet(victim.page, '/api/calendar/events?area=crm&from=2026-11-01&to=2026-11-30');
      expect(JSON.stringify(victimList.body)).not.toContain(title);
      const mineList = await apiGet(attacker.page, '/api/calendar/events?area=crm&from=2026-11-01&to=2026-11-30');
      expect(JSON.stringify(mineList.body)).toContain(title);
    } finally { await cleanUp(attacker.page, planted); await victim.ctx.close(); await attacker.ctx.close(); }
  });

  for (const id of GUESSES) {
    test(`a guessed event id (${id}) is refused cleanly, not with a 500`, async ({ browser }) => {
      // A 500 on a guessed id is both a bad contract and a probe oracle: it distinguishes ids that
      // reached the database from ids that did not.
      const { ctx, page } = await as(browser, 'agent2');
      try {
        const put = await apiSend(page, 'PUT', `/api/calendar/events/${id}?area=crm`, { title: 'X', date: PROBE_DAY });
        const del = await apiSend(page, 'DELETE', `/api/calendar/events/${id}?area=crm`);
        for (const r of [put, del]) {
          expect(r.status, `status ${r.status} for id ${id}`).toBeLessThan(500);
          expect(r.status).not.toBe(200);
        }
      } finally { await ctx.close(); }
    });
  }

  test('a role without calendar:edit cannot write even its OWN event', async ({ browser }) => {
    // Bypassing the UI is the whole point of this file: the screen hides the buttons, and the
    // question is whether the endpoint agrees.
    const { ctx, page } = await as(browser, 'accounting');
    try {
      const r = await apiSend(page, 'POST', '/api/calendar/events?area=crm', {
        title: 'ZZ should be refused', date: PROBE_DAY_2, time: '09:00', type: 'showing',
      });
      // Either they hold calendar:edit and it is allowed, or they do not and it is 403. What must
      // not happen is a 500, or a silent success for a role the screen tells "read only".
      expect(r.status).toBeLessThan(500);
      if (r.status < 300) {
        const perms = ((await apiGet(page, '/api/user')).body as { permissions: Record<string, string> }).permissions;
        const madeId = (r.body as { id?: number; event?: { id?: number } }).id ?? (r.body as { event?: { id?: number } }).event?.id;
        if (madeId) await apiSend(page, 'DELETE', `/api/calendar/events/${madeId}?area=crm`).catch(() => undefined);
        expect(perms.calendar, 'a create succeeded, so calendar must actually be edit').toBe('edit');
      }
    } finally { await ctx.close(); }
  });

  test('a write with no CSRF token is refused', async ({ browser }) => {
    const { ctx, page } = await as(browser, 'agent');
    try {
      const r = await apiSend(page, 'POST', '/api/calendar/events?area=crm',
        { title: 'ZZ csrf', date: PROBE_DAY_2 }, { omitCsrf: true });
      expect(r.status).toBe(419);
    } finally { await ctx.close(); }
  });
});

// ================================================================== INBOX
test.describe('Inbox — one user cannot act on another user\'s mail', () => {
  /** The caller's own messages, if any. Returns [] rather than failing when the mailbox is empty. */
  async function myMessageIds(page: import('@playwright/test').Page): Promise<number[]> {
    const r = await apiGet(page, '/api/account/inbox?area=crm');
    const data = (r.body as { data?: { id: number }[] })?.data ?? [];
    return data.map((m) => m.id);
  }

  test('marking someone else\'s message read is refused, and it stays unread', async ({ browser }) => {
    const owner = await as(browser, 'agent');
    const other = await as(browser, 'agent2');
    try {
      const ids = await myMessageIds(owner.page);
      test.skip(ids.length === 0, 'the seeded agent mailbox is empty — nothing to attempt a cross-write against');

      const id = ids[0];
      const before = await apiGet(owner.page, `/api/account/inbox/${id}?area=crm`);
      const r = await apiSend(other.page, 'PUT', `/api/account/inbox/${id}/seen?area=crm`, { seen: true });
      expect([403, 404]).toContain(r.status);

      const after = await apiGet(owner.page, `/api/account/inbox/${id}?area=crm`);
      expect((after.body as { subject?: string }).subject).toBe((before.body as { subject?: string }).subject);
    } finally { await other.ctx.close(); await owner.ctx.close(); }
  });

  for (const id of GUESSES) {
    test(`a guessed message id (${id}) is refused cleanly, not with a 500`, async ({ browser }) => {
      const { ctx, page } = await as(browser, 'agent2');
      try {
        const get = await apiGet(page, `/api/account/inbox/${id}?area=crm`);
        const put = await apiSend(page, 'PUT', `/api/account/inbox/${id}/seen?area=crm`, { seen: true });
        for (const r of [get, put]) {
          expect(r.status, `status ${r.status} for id ${id}`).toBeLessThan(500);
          expect(r.status).not.toBe(200);
        }
      } finally { await ctx.close(); }
    });
  }

  /*
   * THE CROSS-USER SYNC TEST LIVES IN `server/src/inbox/inbox-sync-authorization.spec.ts`, NOT HERE.
   *
   * It was written here first and SKIPPED: it sourced a victim account from `GET /api/mail-accounts`,
   * which lists only brokerage accounts (`user_id: null`) and returns `[]` in this fixture. A skip in
   * an authorization suite is indistinguishable from a pass in the summary line, so it moved to the
   * controller level where the account can simply be created — and it found two real defects there:
   * the refusal disclosed the other user's connected email address, and a cross-user sync answered
   * 500 rather than 404. Both are fixed and pinned by that file.
   *
   * What stays here is the part only the browser can add: that a guessed account id is refused over
   * real HTTP, through the real guards.
   */

  for (const id of GUESSES) {
    test(`a sync on a guessed account id (${id}) is refused cleanly`, async ({ browser }) => {
      const { ctx, page } = await as(browser, 'agent2');
      try {
        const r = await apiSend(page, 'POST', `/api/account/inbox/sync/${id}?area=crm`);
        expect(r.status, `status ${r.status} for account ${id}`).toBeLessThan(500);
        expect(r.status).not.toBe(200);
      } finally { await ctx.close(); }
    });
  }

  test('an inbox write with no CSRF token is refused', async ({ browser }) => {
    const { ctx, page } = await as(browser, 'agent');
    try {
      const r = await apiSend(page, 'PUT', '/api/account/inbox/1/seen?area=crm', { seen: true }, { omitCsrf: true });
      expect(r.status).toBe(419);
    } finally { await ctx.close(); }
  });

  test('the unauthenticated perimeter holds for every write here', async ({ browser }) => {
    // No session at all — the case that needs no guessing and no account.
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await page.goto('/');
      for (const [method, path] of [
        ['POST', '/api/calendar/events?area=crm'],
        ['PUT', '/api/calendar/events/1?area=crm'],
        ['DELETE', '/api/calendar/events/1?area=crm'],
        ['PUT', '/api/account/inbox/1/seen?area=crm'],
        ['POST', '/api/account/inbox/sync/1?area=crm'],
      ] as const) {
        const r = await apiSend(page, method, path, { title: 'x', date: PROBE_DAY_2, seen: true });
        expect([401, 403, 419], `${method} ${path} answered ${r.status}`).toContain(r.status);
      }
    } finally { await ctx.close(); }
  });
});

test.describe('what the fixture itself must guarantee, or the file above proves nothing', () => {
  test('agent and agent2 are genuinely different accounts', async ({ browser }) => {
    // If these ever resolved to the same user, every cross-user assertion above would pass for the
    // wrong reason. Cheap to check, and it is the assumption everything else rests on.
    const a = await as(browser, 'agent');
    const b = await as(browser, 'agent2');
    try {
      const ida = ((await apiGet(a.page, '/api/user')).body as { id: number; email: string });
      const idb = ((await apiGet(b.page, '/api/user')).body as { id: number; email: string });
      expect(ida.id).not.toBe(idb.id);
      expect(ida.email).toBe(ACCOUNTS.agent.email);
      expect(idb.email).toBe(ACCOUNTS.agent2.email);
    } finally { await b.ctx.close(); await a.ctx.close(); }
  });
});
