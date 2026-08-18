import { test, expect, type Page } from '@playwright/test';
import { signIn, apiGet, apiSend, ACCOUNTS } from './helpers';

/**
 * THE CRM CALENDAR AS A PERSON USES IT: events, todos, and everything around them.
 *
 * ================================================================================================
 * WHAT IS ALREADY COVERED ELSEWHERE, so this file does not repeat it: `calendar-more.spec.ts` and
 * `recurrence-end-to-end.spec.ts` cover what the calendar DOES — recurrence expansion, reminders,
 * the Google sync surface. What no calendar spec touches is the behaviour around those actions:
 * across the whole suite the calendar screens have no reload, no back button, no stale-session and
 * no stale-permission coverage at all.
 *
 * TWO LOCAL BEHAVIOURS MAKE THIS SCREEN DIFFERENT FROM THE OTHERS:
 *
 *   IT IS AREA-SCOPED. The same screen exists under CRM and under Transaction Desk, and the server
 *   filters by `?area=`. A CRM event must not appear on the Desk calendar, and `AreaGuard` must
 *   refuse an area the caller may not open — so "navigation" here means something stronger than
 *   "the page loads".
 *
 *   TODOS ARE PRIVATE TO ONE PERSON, including from administrators. That is unusual in this
 *   application — most records are visible to somebody senior — so it is worth proving rather than
 *   assuming, from two directions: another agent, and a Super Admin.
 * ================================================================================================
 */

const unique = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const createdEvents: number[] = [];
const createdTodos: number[] = [];

test.afterAll(async ({ browser }) => {
  if (!createdEvents.length && !createdTodos.length) return;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await signIn(page, 'agent');
    for (const id of createdEvents) await apiSend(page, 'DELETE', `/api/calendar/events/${id}?area=crm`);
    for (const id of createdTodos) await apiSend(page, 'DELETE', `/api/calendar/todos/${id}?area=crm`);
  } finally { await ctx.close(); }
});

/** A date a few days out, so nothing collides with today's seeded fixtures. */
function soon(days = 5): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

async function events(page: Page, area = 'crm') {
  const res = await apiGet(page, `/api/calendar/events?area=${area}`);
  const body = res.body as { data?: unknown[] } | unknown[];
  return (Array.isArray(body) ? body : body.data ?? []) as { id: number; title: string }[];
}

async function todos(page: Page, area = 'crm') {
  const res = await apiGet(page, `/api/calendar/todos?area=${area}`);
  const body = res.body as { data?: unknown[] } | unknown[];
  return (Array.isArray(body) ? body : body.data ?? []) as { id: number; title: string; status: string }[];
}

/**
 * A distinct time for each event this file creates.
 *
 * THE CALENDAR REFUSES A DOUBLE BOOKING ON THE FIRST ATTEMPT — "This overlaps … at 10:30 (1 hour
 * assumed). Change the time, or save again with 'Book anyway' to keep both." The helper originally
 * hard-coded 10:30, so every event after the first tripped that guard and the modal stayed open,
 * which looked like a broken save and was the feature working. Each event now gets its own slot, and
 * the guard itself is tested deliberately below rather than by accident.
 */
let slot = 8;
const nextTime = (): string => `${String(slot++).padStart(2, '0')}:05`;

/** Create an event through the real form and return its id. */
async function addEvent(page: Page, title: string): Promise<number> {
  await page.goto('/crm/calendar');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: '+ Add Event' }).click();

  const modal = page.locator('.modal').first();
  await expect(modal).toBeVisible();
  await modal.locator('#event-title').fill(title);
  await modal.locator('#event-date').fill(soon());
  await modal.locator('#event-time').fill(nextTime());
  await modal.getByRole('button', { name: /Save Event/ }).click();
  await expect(modal).toBeHidden({ timeout: 20_000 });

  const mine = (await events(page)).filter((e) => e.title === title);
  expect(mine, 'the event should exist after saving').toHaveLength(1);
  createdEvents.push(mine[0].id);
  return mine[0].id;
}

// ================================================================ events

test.describe('creating and keeping an event', () => {
  test('an event saves, survives a reload, and is still there after signing out and in', async ({ page, context }) => {
    test.setTimeout(120_000);
    await signIn(page, 'agent');
    const title = unique('Viewing');
    await addEvent(page, title);

    await page.reload();
    await page.waitForLoadState('networkidle');
    expect((await events(page)).some((e) => e.title === title)).toBe(true);

    await context.clearCookies();
    await signIn(page, 'agent');
    expect((await events(page)).some((e) => e.title === title)).toBe(true);
  });

  test('the editor refuses an event with no title and stays open', async ({ page }) => {
    await signIn(page, 'agent');
    await page.goto('/crm/calendar');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: '+ Add Event' }).click();

    const modal = page.locator('.modal').first();
    await modal.locator('#event-date').fill(soon());
    await modal.locator('#event-time').fill(nextTime());
    await modal.getByRole('button', { name: /Save Event/ }).click();

    // Still open — a form that closes on a rejected save loses the typing.
    await expect(modal).toBeVisible();
  });

  test('Cancel creates nothing', async ({ page }) => {
    await signIn(page, 'agent');
    await page.goto('/crm/calendar');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: '+ Add Event' }).click();

    const modal = page.locator('.modal').first();
    const title = unique('Abandoned');
    await modal.locator('#event-title').fill(title);
    await modal.locator('#event-date').fill(soon());
    await modal.locator('#event-time').fill(nextTime());
    await modal.getByRole('button', { name: 'Cancel' }).click();

    await expect(modal).toBeHidden();
    expect((await events(page)).some((e) => e.title === title)).toBe(false);
  });

  test('a reload mid-edit discards the draft', async ({ page }) => {
    await signIn(page, 'agent');
    await page.goto('/crm/calendar');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: '+ Add Event' }).click();

    const title = unique('DraftLost');
    await page.locator('.modal').first().locator('#event-title').fill(title);
    await page.reload();
    await page.waitForLoadState('networkidle');

    await expect(page.locator('.modal')).toHaveCount(0);
    expect((await events(page)).some((e) => e.title === title)).toBe(false);
  });

  /**
   * THE DOUBLE-BOOKING GUARD, which is local behaviour worth pinning: the first save of an
   * overlapping event is REFUSED with an explanation, and the same press repeated confirms it. That
   * shape — refuse once, accept on repeat — is unusual enough that a future change could easily
   * turn it into either "always refuse" or "never warn" without anybody noticing.
   */
  test('an overlapping event is refused first and booked on a second press', async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, 'agent');
    const first = unique('Original');
    await addEvent(page, first);
    const clash = (await events(page)).find((e) => e.title === first)!;
    expect(clash).toBeTruthy();

    // A second event at the same moment as the one just created.
    await page.goto('/crm/calendar');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: '+ Add Event' }).click();
    const modal = page.locator('.modal').first();
    const second = unique('Overlapping');
    await modal.locator('#event-title').fill(second);
    await modal.locator('#event-date').fill(soon());
    await modal.locator('#event-time').fill(`${String(slot - 1).padStart(2, '0')}:05`);
    await modal.getByRole('button', { name: /Save Event/ }).click();

    // Refused, with a reason, and the modal stays open holding the typing.
    await expect(modal).toBeVisible();
    await expect(page.getByText(/overlaps/i)).toBeVisible();
    expect((await events(page)).some((e) => e.title === second)).toBe(false);

    /*
     * "Book anyway" is its own button, offered only after the refusal — not a second press of Save.
     * Matching both names at once is a strict-mode violation because both are on screen at that
     * point, and it also misdescribes the interaction: the confirmation is a distinct choice.
     */
    await modal.getByRole('button', { name: 'Book anyway' }).click();
    await expect(modal).toBeHidden({ timeout: 20_000 });
    const both = (await events(page)).filter((e) => e.title === second);
    both.forEach((e) => createdEvents.push(e.id));
    expect(both).toHaveLength(1);
  });

  test('double-clicking Save creates one event, not two', async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, 'agent');
    await page.goto('/crm/calendar');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: '+ Add Event' }).click();

    const modal = page.locator('.modal').first();
    const title = unique('DoubleSave');
    await modal.locator('#event-title').fill(title);
    await modal.locator('#event-date').fill(soon());
    await modal.locator('#event-time').fill(nextTime());
    await modal.getByRole('button', { name: /Save Event/ }).dblclick({ delay: 0 });
    await expect(modal).toBeHidden({ timeout: 20_000 });

    const mine = (await events(page)).filter((e) => e.title === title);
    mine.forEach((e) => createdEvents.push(e.id));
    expect(mine, 'a second click must not produce a second event').toHaveLength(1);
  });
});

// ================================================================ navigation

test.describe('navigation and the back button', () => {
  test('leaving the calendar and coming back leaves a working screen', async ({ page }) => {
    await signIn(page, 'agent');
    await page.goto('/crm/calendar');
    await page.waitForLoadState('networkidle');

    await page.goto('/crm/lead');
    await page.waitForLoadState('networkidle');
    await page.goBack();
    await page.waitForLoadState('networkidle');

    await expect(page).toHaveURL(/\/crm\/calendar/);
    await expect(page.getByRole('button', { name: '+ Add Event' })).toBeVisible();
  });

  /**
   * THE AREA BOUNDARY, which is what makes this screen's navigation more than cosmetic. The same
   * component serves both areas and the server filters by `?area=` — so an event created in the CRM
   * must not be listed by the Transaction Desk's calendar.
   */
  test('a CRM event does not appear on the Transaction Desk calendar', async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, 'agent');
    const title = unique('CrmOnly');
    await addEvent(page, title);

    expect((await events(page, 'crm')).some((e) => e.title === title)).toBe(true);
    expect((await events(page, 'desk')).some((e) => e.title === title)).toBe(false);
  });
});

// ================================================================ todos

test.describe('todos are one person’s own', () => {
  async function addTodo(page: Page, title: string): Promise<number> {
    const res = await apiSend(page, 'POST', '/api/calendar/todos?area=crm', {
      title, priority: 'medium', status: 'pending',
    });
    expect([200, 201]).toContain(res.status);
    const id = (res.body as { id?: number; data?: { id: number } }).id
      ?? (res.body as { data?: { id: number } }).data?.id;
    expect(id, 'the todo should come back with an id').toBeTruthy();
    createdTodos.push(id as number);
    return id as number;
  }

  test('a todo persists across a reload and a fresh sign-in', async ({ page, context }) => {
    await signIn(page, 'agent');
    await page.goto('/crm/calendar');
    await page.waitForLoadState('networkidle');

    const title = unique('CallBack');
    await addTodo(page, title);

    await page.reload();
    await page.waitForLoadState('networkidle');
    expect((await todos(page)).some((t) => t.title === title)).toBe(true);

    await context.clearCookies();
    await signIn(page, 'agent');
    expect((await todos(page)).some((t) => t.title === title)).toBe(true);
  });

  /**
   * PRIVATE EVEN FROM A SUPER ADMIN. Unusual in this application, and stated in the service as
   * deliberate — "a todo is a personal reminder, so everyone sees only their own, including
   * admins". Checked from both directions, because a rule that holds for a colleague and not for an
   * administrator is the version that would actually ship by accident.
   */
  test('another agent and a Super Admin both cannot see it', async ({ page, browser }) => {
    await signIn(page, 'agent');
    await page.goto('/crm/calendar');
    await page.waitForLoadState('networkidle');
    const title = unique('PrivateTodo');
    await addTodo(page, title);

    for (const who of ['agent2', 'superAdmin'] as const) {
      const ctx = await browser.newContext();
      const other = await ctx.newPage();
      try {
        await signIn(other, who);
        await other.goto('/crm/calendar');
        await other.waitForLoadState('networkidle');
        expect(
          (await todos(other)).some((t) => t.title === title),
          `${who} must not see another person's todo`,
        ).toBe(false);
      } finally { await ctx.close(); }
    }
  });

  test('completing a todo persists, and the change survives a reload', async ({ page }) => {
    await signIn(page, 'agent');
    await page.goto('/crm/calendar');
    await page.waitForLoadState('networkidle');

    const title = unique('ToComplete');
    const id = await addTodo(page, title);

    const done = await apiSend(page, 'PUT', `/api/calendar/todos/${id}?area=crm`, {
      title, status: 'completed', priority: 'medium',
    });
    expect([200, 201]).toContain(done.status);

    await page.reload();
    await page.waitForLoadState('networkidle');
    const after = (await todos(page)).find((t) => t.id === id);
    expect(after!.status).toBe('completed');
  });
});

// ================================================================ stale sessions and permissions

test.describe('a calendar tab that has gone stale', () => {
  test('a save from an expired session creates nothing', async ({ page, context, browser }) => {
    await signIn(page, 'agent');
    await page.goto('/crm/calendar');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: '+ Add Event' }).click();

    const modal = page.locator('.modal').first();
    const title = unique('ExpiredEvent');
    await modal.locator('#event-title').fill(title);
    await modal.locator('#event-date').fill(soon());
    await modal.locator('#event-time').fill(nextTime());

    await context.clearCookies();
    await modal.getByRole('button', { name: /Save Event/ }).click();
    await page.waitForTimeout(1500);

    const check = await browser.newContext();
    const p = await check.newPage();
    try {
      await signIn(p, 'agent');
      expect((await events(p)).some((e) => e.title === title)).toBe(false);
    } finally { await check.close(); }
  });

  /**
   * STALE PERMISSIONS. The tab was loaded with `calendar: edit`; `accounting` holds `calendar: view`.
   * The screen still shows every control — the server must refuse the write anyway.
   */
  test('a demoted user’s open tab can no longer create an event', async ({ browser }) => {
    const adminCtx = await browser.newContext();
    const staleCtx = await browser.newContext();
    const admin = await adminCtx.newPage();
    const stale = await staleCtx.newPage();

    try {
      await signIn(admin, 'superAdmin');
      await signIn(stale, 'agent2');
      await stale.goto('/crm/calendar');
      await stale.waitForLoadState('networkidle');

      // It could write a moment ago — so the refusal below is about the demotion, not about the call.
      /*
       * `allow_overlap`, because this test is about AUTHORIZATION and must not be answered by the
       * double-booking guard instead. Without it the first create returned 400 for overlapping an
       * earlier fixture, which reads exactly like a permission refusal and is not one.
       */
      const before = await apiSend(stale, 'POST', '/api/calendar/events?area=crm', {
        title: unique('BeforeDemotion'), date: soon(), time: nextTime(), type: 'meeting', allow_overlap: true,
      });
      expect([200, 201]).toContain(before.status);
      const beforeId = (before.body as { id?: number }).id;
      if (beforeId) createdEvents.push(beforeId);

      const list = await apiGet(admin, '/api/users');
      const rows = (Array.isArray(list.body) ? list.body : []) as Record<string, unknown>[];
      const u = rows.find((r) => String(r.email) === ACCOUNTS.agent2.email)!;
      const base = { name: u.name, email: u.email, username: u.username };
      await apiSend(admin, 'PUT', `/api/users/${u.id}`, { ...base, role: 'accounting', status: 'Active' });

      // Same tab, no reload.
      const after = await apiSend(stale, 'POST', '/api/calendar/events?area=crm', {
        title: unique('AfterDemotion'), date: soon(), time: nextTime(), type: 'meeting', allow_overlap: true,
      });
      expect(after.status, 'the server must re-decide rather than trust the tab').toBe(403);

      // Reading is still allowed — `accounting` keeps `calendar: view`.
      expect((await apiGet(stale, '/api/calendar/events?area=crm')).status).toBe(200);
    } finally {
      const list = await apiGet(admin, '/api/users');
      const rows = (Array.isArray(list.body) ? list.body : []) as Record<string, unknown>[];
      const u = rows.find((r) => String(r.email) === ACCOUNTS.agent2.email);
      if (u) {
        await apiSend(admin, 'PUT', `/api/users/${u.id}`, {
          name: u.name, email: u.email, username: u.username, role: 'agent', status: 'Active',
        });
      }
      await adminCtx.close();
      await staleCtx.close();
    }
  });
});

// ================================================================ two people at once

test.describe('two people on one calendar', () => {
  test('each agent sees only their own events', async ({ page, browser }) => {
    test.setTimeout(120_000);
    await signIn(page, 'agent');
    const title = unique('AgentAEvent');
    await addEvent(page, title);

    const ctx = await browser.newContext();
    const other = await ctx.newPage();
    try {
      await signIn(other, 'agent2');
      await other.goto('/crm/calendar');
      await other.waitForLoadState('networkidle');
      expect((await events(other)).some((e) => e.title === title)).toBe(false);
    } finally { await ctx.close(); }
  });

  test('an event deleted in one tab cannot be edited from another', async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await browser.newContext();
    const tabA = await ctx.newPage();
    const tabB = await ctx.newPage();

    try {
      await signIn(tabA, 'agent');
      const title = unique('Doomed');
      const id = await addEvent(tabA, title);

      await tabB.goto('/crm/calendar');
      await tabB.waitForLoadState('networkidle');
      const del = await apiSend(tabB, 'DELETE', `/api/calendar/events/${id}?area=crm`);
      expect([200, 204]).toContain(del.status);

      const stale = await apiSend(tabA, 'PUT', `/api/calendar/events/${id}?area=crm`, {
        title: `${title} REVIVED`, date: soon(), time: nextTime(), type: 'meeting', allow_overlap: true,
      });
      expect(stale.status, 'a deleted event must not accept an edit').toBe(404);
    } finally { await ctx.close(); }
  });
});
