import { test, expect, type Page } from '@playwright/test';
import { signIn, apiGet, apiSend, ACCOUNTS } from './helpers';

/**
 * A BROWSER TAB IS NOT A SOURCE OF TRUTH, AND THE SERVER MUST NEVER TREAT IT AS ONE.
 *
 * ================================================================================================
 * THE SHAPE OF THE RISK. Every permission decision the client makes was made when the page loaded.
 * A tab open since this morning is showing this morning's rights: its sidebar, its buttons and its
 * `can(...)` checks all reflect a role the person may no longer have. That is unavoidable and fine —
 * PROVIDED the server re-decides on every request.
 *
 * The failure being hunted is the opposite: an API that trusts what the client sends because the
 * client "wouldn't have sent it unless it was allowed". That reasoning is wrong in exactly the cases
 * that matter — a demoted user, a deactivated account, a replayed request, a second tab.
 *
 * So each test here deliberately desynchronises the browser from the server and then acts:
 *
 *   the role changes underneath an open tab        -> the old tab's writes must be refused
 *   the account is deactivated underneath a tab    -> everything must be refused, at once
 *   two tabs edit one record                       -> what the second save does is recorded
 *   a stale tab holds a record another tab deleted -> saving it must not resurrect it
 * ================================================================================================
 *
 * WHY ROLE CHANGES ARE MADE THROUGH THE API rather than the Users screen: the point is the SERVER's
 * behaviour after the change, and driving the admin UI would add a second thing that can fail
 * without telling us anything about the property under test.
 */

const unique = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const created: number[] = [];

/** Restore agent2 to its seeded role whatever a test did, so the suite is re-runnable. */
async function restoreAgent2(page: Page) {
  const list = await apiGet(page, '/api/users');
  const rows = (Array.isArray(list.body) ? list.body : []) as Record<string, unknown>[];
  const u = rows.find((r) => String(r.email) === ACCOUNTS.agent2.email);
  if (!u) return;
  await apiSend(page, 'PUT', `/api/users/${u.id}`, {
    name: u.name, email: u.email, username: u.username, role: 'agent', status: 'Active',
  });
}

test.afterAll(async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await signIn(page, 'superAdmin');
    await restoreAgent2(page);
    for (const id of created) await apiSend(page, 'DELETE', `/api/leads/${id}`);
  } finally { await ctx.close(); }
});

async function userIdOf(page: Page, email: string): Promise<{ id: number; row: Record<string, unknown> }> {
  const list = await apiGet(page, '/api/users');
  const rows = (Array.isArray(list.body) ? list.body : []) as Record<string, unknown>[];
  const row = rows.find((r) => String(r.email) === email)!;
  return { id: row.id as number, row };
}

test.describe('a tab whose permissions have changed underneath it', () => {
  /**
   * DEMOTION. `agent` holds `lead: edit`; `accounting` holds `lead: view`. The tab was loaded as an
   * agent and still shows every editing control — the server must refuse anyway.
   */
  test('a demoted user’s open tab can no longer write, however editable the page still looks', async ({ browser }) => {
    const adminCtx = await browser.newContext();
    const userCtx = await browser.newContext();
    const admin = await adminCtx.newPage();
    const stale = await userCtx.newPage();

    try {
      await signIn(admin, 'superAdmin');
      await signIn(stale, 'agent2');

      // The tab loads with full agent rights and proves it by writing once.
      const name = unique('BeforeDemotion');
      const ok = await apiSend(stale, 'POST', '/api/leads', {
        name, email: `${unique('before')}@example.test`, phone: '4165550000',
      });
      expect(ok.status, 'an agent should be able to create before the demotion').toBe(201);
      created.push((ok.body as { id: number }).id);

      // The role changes. The tab is never reloaded.
      const { id, row } = await userIdOf(admin, ACCOUNTS.agent2.email);
      const demote = await apiSend(admin, 'PUT', `/api/users/${id}`, {
        name: row.name, email: row.email, username: row.username, role: 'accounting', status: 'Active',
      });
      expect(demote.status).toBe(200);

      // Same tab, same session, no reload — and now refused.
      const after = await apiSend(stale, 'POST', '/api/leads', {
        name: unique('AfterDemotion'), email: `${unique('after')}@example.test`, phone: '4165550000',
      });
      expect(after.status, 'the server must re-decide, not trust the tab').toBe(403);

      // Reading is still allowed, because `accounting` keeps `lead: view` — the demotion must be
      // precise rather than a blanket lockout.
      const read = await apiGet(stale, '/api/leads?per_page=5');
      expect(read.status).toBe(200);
    } finally {
      await signIn(admin, 'superAdmin');
      await restoreAgent2(admin);
      await adminCtx.close();
      await userCtx.close();
    }
  });

  test('a deactivated account’s open tab is refused immediately, not at next sign-in', async ({ browser }) => {
    const adminCtx = await browser.newContext();
    const userCtx = await browser.newContext();
    const admin = await adminCtx.newPage();
    const stale = await userCtx.newPage();

    try {
      await signIn(admin, 'superAdmin');
      await signIn(stale, 'agent2');
      expect((await apiGet(stale, '/api/leads?per_page=5')).status).toBe(200);

      const { id, row } = await userIdOf(admin, ACCOUNTS.agent2.email);
      await apiSend(admin, 'PUT', `/api/users/${id}`, {
        name: row.name, email: row.email, username: row.username, role: 'agent', status: 'Inactive',
      });

      // No reload, no new request from the user's side other than the next ordinary one.
      const after = await apiGet(stale, '/api/leads?per_page=5');
      expect([401, 403]).toContain(after.status);
    } finally {
      await signIn(admin, 'superAdmin');
      await restoreAgent2(admin);
      await adminCtx.close();
      await userCtx.close();
    }
  });
});

test.describe('two tabs on one record', () => {
  test('the second save wins, and the stale tab sees the truth after a reload', async ({ browser }) => {
    const ctx = await browser.newContext();
    const tabA = await ctx.newPage();
    const tabB = await ctx.newPage();

    try {
      await signIn(tabA, 'superAdmin');
      const name = unique('TwoTabs');
      const res = await apiSend(tabA, 'POST', '/api/leads', {
        name, email: `${unique('twotabs')}@example.test`, phone: '4165550000',
      });
      const id = (res.body as { id: number }).id;
      created.push(id);

      // Both tabs load the record.
      await tabA.goto(`/crm/lead/${id}`);
      await tabB.goto(`/crm/lead/${id}`);
      await tabA.waitForLoadState('networkidle');
      await tabB.waitForLoadState('networkidle');

      // B saves, then A saves stale data on top.
      await apiSend(tabB, 'PUT', `/api/leads/${id}`, { name: `${name} FROM-B`, location: 'B-town' });
      const aSave = await apiSend(tabA, 'PUT', `/api/leads/${id}`, { name: `${name} FROM-A` });

      /*
       * LAST WRITE WINS, and it is recorded here rather than judged. There is no version column and
       * no conflict prompt, so A's save is accepted and overwrites the name. What must NOT happen is
       * a silent partial write — B's `location` was not in A's payload and must survive, because the
       * update applies only the fields it was given.
       */
      expect(aSave.status).toBe(200);
      const after = await apiGet(tabA, `/api/leads/${id}`);
      const saved = after.body as { name: string; location: string | null };
      expect(saved.name).toContain('FROM-A');
      expect(saved.location, 'a field the later save never mentioned must not be wiped').toBe('B-town');

      // And the stale tab tells the truth once reloaded.
      await tabB.reload();
      await tabB.waitForLoadState('networkidle');
      await expect(tabB.getByText('FROM-A', { exact: false }).first()).toBeVisible();
    } finally {
      await ctx.close();
    }
  });

  /**
   * A stale tab holding a record another tab has since deleted. Saving it must not bring it back —
   * a soft-deleted lead that reappears because somebody had it open is a real way for a deletion to
   * quietly fail.
   */
  test('saving from a tab whose record was deleted elsewhere does not resurrect it', async ({ browser }) => {
    const ctx = await browser.newContext();
    const tabA = await ctx.newPage();
    const tabB = await ctx.newPage();

    try {
      await signIn(tabA, 'agent');
      const name = unique('Doomed');
      const res = await apiSend(tabA, 'POST', '/api/leads', {
        name, email: `${unique('doomed')}@example.test`, phone: '4165550000',
      });
      const id = (res.body as { id: number }).id;
      created.push(id);

      await tabA.goto(`/crm/lead/${id}`);
      await tabA.waitForLoadState('networkidle');

      /*
       * The second tab has to LOAD the app before it can act as one. It shares the context's cookies,
       * so it is already signed in — but `apiSend` issues a same-origin fetch from the page, and a
       * tab still sitting on about:blank has no origin to send it from.
       */
      await tabB.goto('/crm/lead');
      await tabB.waitForLoadState('networkidle');

      // Deleted in the other tab.
      const del = await apiSend(tabB, 'DELETE', `/api/leads/${id}`);
      expect(del.status, 'the delete itself must succeed for this test to mean anything').toBe(200);

      // The stale tab saves.
      const save = await apiSend(tabA, 'PUT', `/api/leads/${id}`, { name: `${name} REVIVED` });
      expect(save.status, 'a deleted lead must not accept an edit').toBe(404);

      // Still deleted, and still not in the list.
      const list = await apiGet(tabA, `/api/leads?search=${encodeURIComponent(name)}`);
      const rows = (list.body as { data?: unknown[] }).data ?? [];
      expect(rows).toHaveLength(0);
    } finally {
      await ctx.close();
    }
  });
});
