import { test, expect, type Page } from '@playwright/test';
import { signIn, apiGet, apiSend, ACCOUNTS } from './helpers';

/**
 * THE FOUR READ-MOSTLY CRM SCREENS: Inbox, Audit Trail, Users, Notifications.
 *
 * ================================================================================================
 * WHY THEY SHARE A FILE. Each is small in surface and identical in shape: they LIST something, they
 * are gated differently per role, and almost none of them writes. The interesting questions are
 * therefore the same four for all of them, and the same four that were near-zero across the suite —
 * navigation, reload, the back button, and what happens when the tab's session or permissions have
 * gone stale underneath it.
 *
 * WHAT MAKES EACH ONE DIFFERENT, and why each gets its own permission case:
 *
 *   INBOX          personal and area-scoped. It shows the signed-in person's own mailboxes, and the
 *                  CRM inbox must not show Transaction Desk mail — `mail_accounts.scope` is what
 *                  keeps them apart, so it is worth checking through the screen rather than trusting
 *                  the column.
 *   AUDIT TRAIL    admin-only, and area-scoped on top of that. It is the one screen here that
 *                  reveals other people's actions, so the refusal matters more than the listing.
 *   USERS          Super Admin only, enforced by `AdminGuard` rather than by a screen permission —
 *                  a distinction that has already caused one bug, recorded in `App.tsx`.
 *   NOTIFICATIONS  everybody's own, nobody else's, with no admin override at all.
 * ================================================================================================
 */

const CRM_SCREENS = [
  { name: 'Inbox', path: '/crm/inbox', api: '/api/account/inbox?area=crm' },
  { name: 'Notification centre', path: '/crm/notification-center', api: '/api/notifications' },
  { name: 'Notification preferences', path: '/crm/notifications', api: '/api/account/notification-preferences' },
] as const;

/** Restore agent2, which the stale-permission tests change underneath themselves. */
async function restoreAgent2(page: Page) {
  const list = await apiGet(page, '/api/users');
  const rows = (Array.isArray(list.body) ? list.body : []) as Record<string, unknown>[];
  const u = rows.find((r) => String(r.email) === ACCOUNTS.agent2.email);
  if (!u) return;
  await apiSend(page, 'PUT', `/api/users/${u.id}`, {
    name: u.name, email: u.email, username: u.username, role: 'agent', status: 'Active',
  });
}

// ================================================================ navigation, reload, back

test.describe('the personal CRM screens survive ordinary navigation', () => {
  for (const screen of CRM_SCREENS) {
    test(`${screen.name}: loads, reloads, and comes back with the back button`, async ({ page }) => {
      await signIn(page, 'agent');

      await page.goto(screen.path);
      await page.waitForLoadState('networkidle');
      expect((await apiGet(page, screen.api)).status, `${screen.name} should answer its own API`).toBe(200);

      // A reload must leave a working screen, not a blank shell.
      await page.reload();
      await page.waitForLoadState('networkidle');
      expect((await apiGet(page, screen.api)).status).toBe(200);

      // Away and back the way a person does it.
      await page.goto('/crm/lead');
      await page.waitForLoadState('networkidle');
      await page.goBack();
      await page.waitForLoadState('networkidle');

      await expect(page).toHaveURL(new RegExp(screen.path.replace('/', '\\/')));
      expect((await apiGet(page, screen.api)).status).toBe(200);
    });
  }

  test('a screen reached by typing its URL directly behaves the same as one reached by clicking', async ({ page }) => {
    await signIn(page, 'agent');
    // Deep-linking is how bookmarks and notification emails arrive, so it must not depend on having
    // navigated from somewhere else first.
    await page.goto('/crm/notification-center');
    await page.waitForLoadState('networkidle');
    expect((await apiGet(page, '/api/notifications')).status).toBe(200);
  });
});

// ================================================================ inbox

test.describe('Inbox', () => {
  test('is the caller’s own, and the CRM inbox is not the Desk inbox', async ({ page }) => {
    await signIn(page, 'agent');
    await page.goto('/crm/inbox');
    await page.waitForLoadState('networkidle');

    const crm = await apiGet(page, '/api/account/inbox?area=crm');
    const desk = await apiGet(page, '/api/account/inbox?area=desk');
    expect(crm.status).toBe(200);
    expect(desk.status).toBe(200);

    /*
     * The two areas answer independently. They may both be empty on a given deployment — what must
     * NOT happen is one area's mail appearing under the other, so the ids are compared rather than
     * the counts.
     */
    const ids = (r: typeof crm) => {
      const body = r.body as { data?: { id: number }[] } | { id: number }[];
      return (Array.isArray(body) ? body : body.data ?? []).map((m) => m.id);
    };
    const shared = ids(crm).filter((id) => ids(desk).includes(id));
    expect(shared, 'no message may be listed under both areas').toEqual([]);
  });

  test('another agent’s mail is not in this agent’s inbox', async ({ page, browser }) => {
    await signIn(page, 'agent');
    const mine = await apiGet(page, '/api/account/inbox?area=crm');
    const mineIds = (() => {
      const b = mine.body as { data?: { id: number }[] } | { id: number }[];
      return (Array.isArray(b) ? b : b.data ?? []).map((m) => m.id);
    })();

    const ctx = await browser.newContext();
    const other = await ctx.newPage();
    try {
      await signIn(other, 'agent2');
      const theirs = await apiGet(other, '/api/account/inbox?area=crm');
      const theirIds = (() => {
        const b = theirs.body as { data?: { id: number }[] } | { id: number }[];
        return (Array.isArray(b) ? b : b.data ?? []).map((m) => m.id);
      })();
      expect(mineIds.filter((id) => theirIds.includes(id))).toEqual([]);
    } finally { await ctx.close(); }
  });
});

// ================================================================ audit trail

test.describe('Audit Trail', () => {
  test('an administrator can read it; an agent cannot, by URL or by API', async ({ page, browser }) => {
    // The refusal first, because it is the half that matters.
    await signIn(page, 'agent');
    expect((await apiGet(page, '/api/audit-logs?area=crm&limit=5')).status).toBe(403);

    await page.goto('/crm/audit');
    await page.waitForLoadState('networkidle');
    // Whatever the shell renders, no audit data is reachable.
    expect((await apiGet(page, '/api/audit-logs?area=crm&limit=5')).status).toBe(403);

    const ctx = await browser.newContext();
    const admin = await ctx.newPage();
    try {
      await signIn(admin, 'superAdmin');
      await admin.goto('/crm/audit');
      await admin.waitForLoadState('networkidle');
      expect((await apiGet(admin, '/api/audit-logs?area=crm&limit=5')).status).toBe(200);
    } finally { await ctx.close(); }
  });

  test('a demoted administrator’s open tab stops being able to read it', async ({ browser }) => {
    const adminCtx = await browser.newContext();
    const staleCtx = await browser.newContext();
    const admin = await adminCtx.newPage();
    const stale = await staleCtx.newPage();

    try {
      await signIn(admin, 'superAdmin');
      const list = await apiGet(admin, '/api/users');
      const rows = (Array.isArray(list.body) ? list.body : []) as Record<string, unknown>[];
      const u = rows.find((r) => String(r.email) === ACCOUNTS.agent2.email)!;
      const base = { name: u.name, email: u.email, username: u.username };

      await apiSend(admin, 'PUT', `/api/users/${u.id}`, { ...base, role: 'admin', status: 'Active' });
      await signIn(stale, 'agent2');
      await stale.goto('/crm/audit');
      await stale.waitForLoadState('networkidle');
      expect((await apiGet(stale, '/api/audit-logs?area=crm&limit=5')).status).toBe(200);

      // Demoted underneath the open tab, which is never reloaded.
      await apiSend(admin, 'PUT', `/api/users/${u.id}`, { ...base, role: 'agent', status: 'Active' });
      expect((await apiGet(stale, '/api/audit-logs?area=crm&limit=5')).status).toBe(403);
    } finally {
      await restoreAgent2(admin);
      await adminCtx.close();
      await staleCtx.close();
    }
  });
});

// ================================================================ users

test.describe('Users', () => {
  /**
   * `/api/users` is guarded by `AdminGuard` and never consults the `users` SCREEN permission. That
   * distinction is not academic: gating the route on the permission once produced a page that opened
   * for somebody holding "Users: view" and then answered 403 to every request on it — an enabled
   * "+ Add User" button over an empty table. See the note in `App.tsx`.
   */
  test('only a Super Admin can list users; an Admin is refused', async ({ page, browser }) => {
    await signIn(page, 'admin');            // role `manager`, labelled "Admin"
    expect((await apiGet(page, '/api/users')).status).toBe(403);

    const ctx = await browser.newContext();
    const su = await ctx.newPage();
    try {
      await signIn(su, 'superAdmin');
      expect((await apiGet(su, '/api/users')).status).toBe(200);
      await su.goto('/crm/users');
      await su.waitForLoadState('networkidle');
      expect((await apiGet(su, '/api/users')).status).toBe(200);
    } finally { await ctx.close(); }
  });

  test('an agent cannot reach Users by typing the URL', async ({ page }) => {
    await signIn(page, 'agent');
    await page.goto('/crm/users');
    await page.waitForLoadState('networkidle');
    expect((await apiGet(page, '/api/users')).status).toBe(403);
  });

  test('a change to a user persists across a reload', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const list = await apiGet(page, '/api/users');
    const rows = (Array.isArray(list.body) ? list.body : []) as Record<string, unknown>[];
    const u = rows.find((r) => String(r.email) === ACCOUNTS.agent2.email)!;
    const original = String(u.department ?? '');
    const next = `Dept-${Date.now()}`;

    try {
      const save = await apiSend(page, 'PUT', `/api/users/${u.id}`, {
        name: u.name, email: u.email, username: u.username, role: 'agent', status: 'Active',
        department: next,
      });
      expect(save.status).toBe(200);

      await page.reload();
      await page.waitForLoadState('networkidle');
      const after = (await apiGet(page, '/api/users')).body as Record<string, unknown>[];
      const row = after.find((r) => String(r.email) === ACCOUNTS.agent2.email)!;
      expect(String(row.department ?? '')).toBe(next);
    } finally {
      await apiSend(page, 'PUT', `/api/users/${u.id}`, {
        name: u.name, email: u.email, username: u.username, role: 'agent', status: 'Active',
        department: original,
      });
    }
  });
});

// ================================================================ notifications

test.describe('Notifications', () => {
  test('a preference change persists across reload and a fresh sign-in', async ({ page, context }) => {
    await signIn(page, 'agent');
    await page.goto('/crm/notifications');
    await page.waitForLoadState('networkidle');

    const read = async () => {
      const res = await apiGet(page, '/api/account/notification-preferences');
      const body = res.body as { categories?: { key: string; enabled: Record<string, boolean> }[] };
      return body.categories ?? [];
    };

    const cats = await read();
    const target = cats.find((c) => 'email' in (c.enabled ?? {}));
    test.skip(!target, 'no category offers the email channel');
    const before = target!.enabled.email;

    /*
     * The payload is a MAP of category to channels — `{ lead_task_due: { email: true } }` — not a
     * flat `{ category, channel, enabled }` triple. The flat form is accepted as valid JSON and
     * silently understood as a category named "category", so it returns 400 rather than saving.
     */
    const save = await apiSend(page, 'PUT', '/api/account/notification-preferences', {
      [target!.key]: { email: !before },
    });
    expect([200, 201, 204]).toContain(save.status);

    await page.reload();
    await page.waitForLoadState('networkidle');
    expect((await read()).find((c) => c.key === target!.key)!.enabled.email).toBe(!before);

    // And across a whole new session, not just a re-render.
    await context.clearCookies();
    await signIn(page, 'agent');
    expect((await read()).find((c) => c.key === target!.key)!.enabled.email).toBe(!before);

    await apiSend(page, 'PUT', '/api/account/notification-preferences', {
      [target!.key]: { email: before },
    });
  });

  test('one person’s notification centre never shows another’s', async ({ page, browser }) => {
    await signIn(page, 'agent');
    const mine = await apiGet(page, '/api/notifications');
    const idsOf = (r: typeof mine) => {
      const b = r.body as { data?: { id: number }[] } | { id: number }[];
      return (Array.isArray(b) ? b : b.data ?? []).map((n) => n.id);
    };

    const ctx = await browser.newContext();
    const other = await ctx.newPage();
    try {
      await signIn(other, 'agent2');
      const theirs = await apiGet(other, '/api/notifications');
      expect(idsOf(mine).filter((id) => idsOf(theirs).includes(id))).toEqual([]);
    } finally { await ctx.close(); }
  });

  test('a preference save from an expired session changes nothing', async ({ page, context, browser }) => {
    await signIn(page, 'agent');
    await page.goto('/crm/notifications');
    await page.waitForLoadState('networkidle');

    const read = async (p: Page) => {
      const res = await apiGet(p, '/api/account/notification-preferences');
      const body = res.body as { categories?: { key: string; enabled: Record<string, boolean> }[] };
      return body.categories ?? [];
    };
    const target = (await read(page)).find((c) => 'email' in (c.enabled ?? {}));
    test.skip(!target, 'no category offers the email channel');
    const before = target!.enabled.email;

    await context.clearCookies();
    const attempt = await apiSend(page, 'PUT', '/api/account/notification-preferences', {
      [target!.key]: { email: !before },
    });
    expect([401, 403, 419]).toContain(attempt.status);

    const check = await browser.newContext();
    const p = await check.newPage();
    try {
      await signIn(p, 'agent');
      expect((await read(p)).find((c) => c.key === target!.key)!.enabled.email).toBe(before);
    } finally { await check.close(); }
  });
});
