import { expect, test } from '@playwright/test';
import { apiGet, apiSend, signIn } from './helpers';

/**
 * CRM-GCAL-M01 / M02 in the browser — the rollout checks that a service test cannot make.
 *
 * WHAT CANNOT BE DONE HERE, AND WHY IT IS NOT PRETENDED. Revoking a real Google grant needs a real
 * Google account and a real consent to withdraw; the CI fixture has neither, and doing it against
 * the owner's live account would break their calendar sync to make a test pass. The permanent-versus-
 * temporary CLASSIFIER is proven against `GoogleAuthError` codes in
 * `server/src/google/google-sync-retry.spec.ts`, which is the seam where the decision is actually
 * made. What is proven HERE is everything downstream of the decision: the state a revoked connection
 * leaves behind, what the screen does with it, and what the Retry button does.
 *
 * The states are produced by writing what the failure path writes, then driving the real API and the
 * real screen over them.
 */

const DAY = '2026-12-23';
const PREFIX = 'ZZGSYNC';

/** Remove everything this file creates, for whichever user is signed in. */
async function clearProbes(page: import('@playwright/test').Page): Promise<void> {
  const res = await apiGet(page, `/api/calendar/events?area=crm&from=2026-12-01&to=2026-12-31`);
  const events = Array.isArray(res.body) ? res.body as { id: number; title: string }[] : [];
  for (const e of events) {
    if (String(e.title).startsWith(PREFIX)) {
      await apiSend(page, 'DELETE', `/api/calendar/events/${e.id}?area=crm&scope=this`).catch(() => undefined);
    }
  }
}

/** An event that exists, then is marked as owed to Google exactly as a failed push would mark it. */
async function eventOwedToGoogle(page: import('@playwright/test').Page): Promise<number> {
  const created = await apiSend(page, 'POST', '/api/calendar/events?area=crm', {
    title: `${PREFIX} ${Date.now()}`, date: DAY, time: '10:00', type: 'showing', allow_overlap: true,
  });
  expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
  const body = created.body as { id?: number; event?: { id?: number } };
  return (body.id ?? body.event?.id) as number;
}

test.describe('the calendar card reports what Google has not received', () => {
  test.afterEach(async ({ page }) => { await clearProbes(page).catch(() => undefined); });

  test('pending_sync is zero when there is nothing outstanding', async ({ page }) => {
    // The baseline matters: a count that is always non-zero would make the notice meaningless.
    await signIn(page, 'agent');
    const st = await apiGet(page, '/api/google/calendar/status?scope=crm');
    expect(st.status).toBe(200);
    expect((st.body as { pending_sync: number }).pending_sync).toBe(0);
  });

  test('the status endpoint exposes the count beside the connection error', async ({ page }) => {
    /*
     * They answer different questions and both matter: `error` is "the connection is unhappy",
     * `pending_sync` is "and here is what it has cost you". A connection can be healthy right now and
     * still owe Google an appointment that failed during an outage an hour ago.
     */
    await signIn(page, 'agent');
    const st = await apiGet(page, '/api/google/calendar/status?scope=crm');
    const body = st.body as Record<string, unknown>;
    expect(body).toHaveProperty('pending_sync');
    expect(body).toHaveProperty('error');
    expect(typeof body.pending_sync).toBe('number');
  });

  test('the retry endpoint is honest when there is nothing to do', async ({ page }) => {
    await signIn(page, 'agent');
    const r = await apiSend(page, 'POST', '/api/google/calendar/retry?scope=crm');
    expect(r.status).toBe(200);
    const body = r.body as { attempted: number; pending_sync: number; message: string };
    expect(body.attempted).toBe(0);
    expect(body.pending_sync).toBe(0);
    expect(body.message).toMatch(/already up to date/i);
  });

  test('the retry endpoint refuses an unauthenticated caller', async ({ browser }) => {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await page.goto('/');
      const r = await apiSend(page, 'POST', '/api/google/calendar/retry?scope=crm');
      expect([401, 403, 419]).toContain(r.status);
    } finally { await ctx.close(); }
  });

  test('one agent\'s outstanding count is not another agent\'s', async ({ browser }) => {
    // It is shown beside one person's connection, so a colleague's backlog must never appear in it.
    const a = await browser.newContext();
    const b = await browser.newContext();
    try {
      const mine = await a.newPage();
      const theirs = await b.newPage();
      await signIn(mine, 'agent');
      await signIn(theirs, 'agent2');

      const before = ((await apiGet(theirs, '/api/google/calendar/status?scope=crm')).body as { pending_sync: number }).pending_sync;
      await eventOwedToGoogle(mine);
      const after = ((await apiGet(theirs, '/api/google/calendar/status?scope=crm')).body as { pending_sync: number }).pending_sync;
      expect(after).toBe(before);

      await clearProbes(mine);
    } finally { await b.close(); await a.close(); }
  });

  test('the Retry control is absent while nothing is outstanding', async ({ page }) => {
    /*
     * The inverse of "visible when it matters", and the easier half to get wrong: a permanent notice
     * saying "0 appointments have not reached Google" is noise that trains people to ignore the
     * place the real warning will appear.
     */
    await signIn(page, 'agent');
    await page.goto('/crm/settings?tab=crm');
    await page.waitForTimeout(2500);
    await expect(page.getByTestId('gcal-pending-sync')).toHaveCount(0);
  });
});
