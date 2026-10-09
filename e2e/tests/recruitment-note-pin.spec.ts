import { test, expect, type Page } from '@playwright/test';
import { apiSend, signIn } from './helpers';

/**
 * PINNING A CANDIDATE'S NOTES, through the browser.
 *
 * The service tests already cover what is saved, who may save it and the order it comes back in.
 * What only a browser can show is the part the person actually touches: that the button is there
 * beside Edit and Delete, that the list re-orders in front of them, that a pin survives a reload,
 * that a failure is visible on the note rather than swallowed, and that a second click while the
 * first is still in flight cannot reach the server.
 */

const unique = (p: string) => `${p}${Date.now().toString().slice(-7)}${Math.floor(Math.random() * 1000)}`;

type Made = { candidates: number[] };

async function newCandidate(page: Page, made: Made, name: string): Promise<number> {
  const res = await apiSend(page, 'POST', '/api/recruitment/candidates', {
    name, email: `${name.toLowerCase()}@probe.test`,
  });
  const id = (res.body as { data: { id: number } }).data.id;
  made.candidates.push(id);
  return id;
}

const addNote = (page: Page, id: number, body: string) =>
  apiSend(page, 'POST', `/api/recruitment/candidates/${id}/notes`, { body });

async function cleanUp(page: Page, made: Made): Promise<void> {
  for (const id of made.candidates) {
    await apiSend(page, 'DELETE', `/api/recruitment/candidates/${id}`).catch(() => undefined);
  }
  made.candidates = [];
}

/** The note bodies as the page renders them, top first. */
const shownNotes = (page: Page): Promise<string[]> =>
  page.locator('[data-note-id]').evaluateAll((els) =>
    els.map((e) => (e.querySelector('div')?.textContent ?? '').trim()));

/** The pinned flag on each rendered note, in display order. */
const pinnedFlags = (page: Page): Promise<string[]> =>
  page.locator('[data-note-id]').evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-pinned') ?? '?'));

const noteCard = (page: Page, body: string) =>
  page.locator('[data-note-id]').filter({ hasText: body });

test.describe('pinning a note on the candidate page', () => {
  test('PINS, RE-ORDERS AND SURVIVES A RELOAD', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const made: Made = { candidates: [] };
    try {
      const id = await newCandidate(page, made, unique('ZZPIN'));
      await addNote(page, id, 'First note');
      await addNote(page, id, 'Second note');
      await addNote(page, id, 'Third note');

      await page.goto(`/crm/recruitment/${id}`);
      await expect(page.locator('[data-note-id]')).toHaveCount(3);

      // Newest first, as before — nothing pinned yet.
      expect(await shownNotes(page)).toEqual(['Third note', 'Second note', 'First note']);
      expect(await pinnedFlags(page)).toEqual(['false', 'false', 'false']);

      // Pin the OLDEST, which is furthest from the top, so a change of order is unmistakable.
      await noteCard(page, 'First note').getByRole('button', { name: 'Pin this note to the top' }).click();

      await expect(page.locator('[data-note-id]').first()).toContainText('First note');
      expect(await shownNotes(page)).toEqual(['First note', 'Third note', 'Second note']);
      expect(await pinnedFlags(page)).toEqual(['true', 'false', 'false']);
      await expect(noteCard(page, 'First note').getByTestId('note-pinned-badge')).toBeVisible();

      // IT IS SAVED, not just moved on screen.
      await page.reload();
      await expect(page.locator('[data-note-id]')).toHaveCount(3);
      expect(await shownNotes(page)).toEqual(['First note', 'Third note', 'Second note']);
      expect(await pinnedFlags(page)).toEqual(['true', 'false', 'false']);
    } finally {
      await cleanUp(page, made);
    }
  });

  test('UNPINNING PUTS IT BACK where it was, not at the top of the rest', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const made: Made = { candidates: [] };
    try {
      const id = await newCandidate(page, made, unique('ZZUNPIN'));
      await addNote(page, id, 'Alpha');
      await addNote(page, id, 'Bravo');
      await addNote(page, id, 'Charlie');

      await page.goto(`/crm/recruitment/${id}`);
      await expect(page.locator('[data-note-id]')).toHaveCount(3);
      const before = await shownNotes(page);

      await noteCard(page, 'Alpha').getByRole('button', { name: 'Pin this note to the top' }).click();
      await expect(page.locator('[data-note-id]').first()).toContainText('Alpha');

      await noteCard(page, 'Alpha').getByRole('button', { name: 'Unpin this note' }).click();
      await expect(noteCard(page, 'Alpha').getByTestId('note-pinned-badge')).toHaveCount(0);

      expect(await shownNotes(page)).toEqual(before);
    } finally {
      await cleanUp(page, made);
    }
  });

  test('SEVERAL NOTES CAN BE PINNED AT ONCE', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const made: Made = { candidates: [] };
    try {
      const id = await newCandidate(page, made, unique('ZZMULTI'));
      await addNote(page, id, 'One');
      await addNote(page, id, 'Two');
      await addNote(page, id, 'Three');

      await page.goto(`/crm/recruitment/${id}`);
      await expect(page.locator('[data-note-id]')).toHaveCount(3);

      await noteCard(page, 'One').getByRole('button', { name: 'Pin this note to the top' }).click();
      await expect(noteCard(page, 'One').getByTestId('note-pinned-badge')).toBeVisible();
      await noteCard(page, 'Two').getByRole('button', { name: 'Pin this note to the top' }).click();
      await expect(noteCard(page, 'Two').getByTestId('note-pinned-badge')).toBeVisible();

      // Pinning the second did not unpin the first — it is not a single slot.
      expect(await page.getByTestId('note-pinned-badge').count()).toBe(2);
      expect(await shownNotes(page)).toEqual(['Two', 'One', 'Three']);
    } finally {
      await cleanUp(page, made);
    }
  });

  test('A FAILED PIN IS VISIBLE ON THE NOTE, and nothing moves', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const made: Made = { candidates: [] };
    try {
      const id = await newCandidate(page, made, unique('ZZFAIL'));
      await addNote(page, id, 'Stays put');
      await addNote(page, id, 'Also here');

      await page.goto(`/crm/recruitment/${id}`);
      await expect(page.locator('[data-note-id]')).toHaveCount(2);
      const before = await shownNotes(page);

      await page.route('**/api/recruitment/candidates/*/notes/*/pin', (r) => r.fulfill({
        status: 500, contentType: 'application/json',
        body: JSON.stringify({ message: 'The note could not be pinned right now.' }),
      }));

      await noteCard(page, 'Stays put').getByRole('button', { name: 'Pin this note to the top' }).click();

      // Said so, on the note itself, with the server's own words — not swallowed, not a silent no-op.
      const failed = noteCard(page, 'Stays put').locator('[role="alert"]');
      await expect(failed).toBeVisible();
      await expect(failed).toContainText(/could not be pinned/i);

      // And the list is exactly as it was: no optimistic re-order left behind.
      expect(await shownNotes(page)).toEqual(before);
      expect(await page.getByTestId('note-pinned-badge').count()).toBe(0);

      // The button is usable again, rather than stuck disabled after the failure.
      await expect(noteCard(page, 'Stays put').getByTestId('note-pin-toggle')).toBeEnabled();
    } finally {
      await cleanUp(page, made);
    }
  });

  test('A DOUBLE CLICK SENDS ONE REQUEST, not two', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const made: Made = { candidates: [] };
    try {
      const id = await newCandidate(page, made, unique('ZZDOUBLE'));
      await addNote(page, id, 'Clicked fast');

      await page.goto(`/crm/recruitment/${id}`);
      await expect(page.locator('[data-note-id]')).toHaveCount(1);

      /*
       * Hold the request open so the second click lands while the first is still in flight — the
       * exact window the `busy` flag exists to close. Without the delay the first would finish
       * first and the test would prove nothing about concurrency.
       */
      let sent = 0;
      await page.route('**/api/recruitment/candidates/*/notes/*/pin', async (r) => {
        sent += 1;
        await new Promise((res) => setTimeout(res, 1200));
        await r.continue();
      });

      const pin = noteCard(page, 'Clicked fast').getByTestId('note-pin-toggle');
      await pin.click();
      // Disabled the moment the first click is accepted, so the second cannot be delivered.
      await expect(pin).toBeDisabled();
      await pin.click({ force: true, timeout: 2000 }).catch(() => undefined);

      await expect(noteCard(page, 'Clicked fast').getByTestId('note-pinned-badge')).toBeVisible({ timeout: 15_000 });
      expect(sent).toBe(1);
    } finally {
      await cleanUp(page, made);
    }
  });

  test('A VIEW-ONLY PERSON SEES THE PIN BUT IS GIVEN NO CONTROLS', async ({ page }) => {
    /*
     * PERMISSIONS ARE MOCKED, DELIBERATELY. No seeded account holds Recruitment view without edit
     * — the roles that can open a candidate at all have edit — and manufacturing one would mean
     * creating a user and changing role permissions, which is another module's business and would
     * outlive the test. Downgrading the `/api/user` payload puts the SPA in exactly the state a
     * view-only person's session would, without touching a single row.
     *
     * `is_admin: false` matters as much as the permission: `can()` in AuthContext short-circuits to
     * true for an admin, so leaving it set would render the controls whatever the screen map says.
     *
     * The SERVER still sees the real admin session, which is what lets the candidate load at all.
     * That split is the point — this test is about what the page RENDERS for someone who may not
     * edit. That the server also refuses them is a separate claim, proven in
     * `server/src/recruitment/recruitment-note-pin.spec.ts`.
     */
    await signIn(page, 'superAdmin');
    const made: Made = { candidates: [] };
    try {
      const id = await newCandidate(page, made, unique('ZZVIEW'));
      const res = await addNote(page, id, 'Pinned for everybody');
      const noteId = (res.body as { data: { id: number } }).data.id;
      await apiSend(page, 'POST', `/api/recruitment/candidates/${id}/notes/${noteId}/pin`, { pinned: true });
      await addNote(page, id, 'An ordinary note');

      // ---------------------------------------------------- first, as somebody who MAY edit
      await page.goto(`/crm/recruitment/${id}`);
      await expect(page.locator('[data-note-id]')).toHaveCount(2);
      await expect(page.getByTestId('note-pinned-badge')).toBeVisible();
      await expect(page.getByTestId('note-pin-toggle')).toHaveCount(2);

      // ---------------------------------------------------- now with the permission downgraded
      await page.route('**/api/user', async (route) => {
        const real = await route.fetch();
        const user = await real.json() as { is_admin: boolean; permissions: Record<string, string> };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ...user,
            is_admin: false,
            is_super_admin: false,
            is_admin_or_above: false,
            permissions: { ...user.permissions, recruitment: 'view' },
          }),
        });
      });
      await page.reload();
      await expect(page.locator('[data-note-id]')).toHaveCount(2);

      // THE PIN IS STILL VISIBLE — otherwise a note sits at the top for no stated reason.
      await expect(page.getByTestId('note-pinned-badge')).toBeVisible();
      expect(await page.getByTestId('note-pinned-badge').count()).toBe(1);
      // It is still the pinned note that is first.
      await expect(page.locator('[data-note-id]').first()).toContainText('Pinned for everybody');

      // AND EVERY CONTROL IS GONE — Pin and Unpin along with Edit and Delete.
      await expect(page.getByTestId('note-pin-toggle')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Pin this note to the top' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Unpin this note' })).toHaveCount(0);
      const notes = page.locator('[data-note-id]');
      await expect(notes.getByRole('button', { name: 'Edit' })).toHaveCount(0);
      await expect(notes.getByRole('button', { name: 'Delete' })).toHaveCount(0);
    } finally {
      await page.unroute('**/api/user');
      await cleanUp(page, made);
    }
  });

  /*
  /*
   * NOT COVERED IN A BROWSER: the server refusing a genuinely view-only SESSION.
   *
   * The test above mocks the client's permission payload, so the session behind it is still an
   * admin one — which is the right trade for a rendering test and the wrong one for an access
   * test. A real view-only session cannot be signed in to without creating a user and changing
   * role permissions, which this task excludes.
   *
   * It is covered where it belongs instead: `recruitment-note-pin.spec.ts` on the server asserts
   * the route carries `@Screen('recruitment', 'edit')` and that `PermissionService` denies `edit`
   * to a holder of `view`, so the endpoint refuses regardless of what any page renders.
   */

  test('pinning on one candidate leaves another candidate alone', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const made: Made = { candidates: [] };
    try {
      const a = await newCandidate(page, made, unique('ZZISOA'));
      const b = await newCandidate(page, made, unique('ZZISOB'));
      await addNote(page, a, 'A first');
      await addNote(page, a, 'A second');
      await addNote(page, b, 'B first');
      await addNote(page, b, 'B second');

      await page.goto(`/crm/recruitment/${a}`);
      await expect(page.locator('[data-note-id]')).toHaveCount(2);
      await noteCard(page, 'A first').getByRole('button', { name: 'Pin this note to the top' }).click();
      await expect(page.locator('[data-note-id]').first()).toContainText('A first');

      await page.goto(`/crm/recruitment/${b}`);
      await expect(page.locator('[data-note-id]')).toHaveCount(2);
      expect(await shownNotes(page)).toEqual(['B second', 'B first']);
      expect(await page.getByTestId('note-pinned-badge').count()).toBe(0);
    } finally {
      await cleanUp(page, made);
    }
  });
});
