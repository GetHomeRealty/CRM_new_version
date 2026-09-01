import { test, expect, type Page } from '@playwright/test';
import { signIn, apiSend, apiGet } from './helpers';

/**
 * CRM-023: deleting a tag must ask, and must say how far it reaches.
 *
 * WHY THIS IS NOT THE SAME AS DELETING A LEAD. A tag delete strips the tag from EVERY lead carrying
 * it, in one click, on rows the operator cannot see from the Tags window. The blast radius is not
 * the thing under the cursor. The window already knew the number - it renders a lead count beside
 * every tag - so the one fact needed for the decision was on screen and never made it into one.
 *
 * THE SAME STRUCTURAL CAUSE AS CRM-001. `TagsModal` is a separate component from `LeadsPage`, which
 * is what mounts the shared `ConfirmDialog`, so the confirmation machinery was not in scope here.
 * That is now the second component in this file to have needed its own.
 *
 * WHAT THIS DOES NOT FIX, and the test says so rather than implying otherwise: the undo still lives
 * only in the page. Reload and it is gone while the deletion stands. The confirmation is what makes
 * that acceptable - you can no longer arrive at the state where you need the undo without having
 * been asked - but a durable undo would need the tag to be soft-deleted server-side, and tags are
 * JSON on the lead rather than rows of their own.
 *
 * EVERY TEST CLEANS UP ITS OWN TAG.
 */

const unique = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const tagsModal = (page: Page) => page.locator('.modal').filter({ hasText: 'Lead Tags' });
const confirmDialog = (page: Page) => page.locator('.modal').filter({ hasText: /Delete the tag/ });

async function openTags(page: Page): Promise<void> {
  await page.goto('/crm/lead');
  await page.getByRole('button', { name: /^Tags/ }).first().click();
  await expect(tagsModal(page)).toBeVisible({ timeout: 10_000 });
}

/** The tags the server currently holds. */
async function serverTags(page: Page): Promise<string[]> {
  const res = await apiGet(page, '/api/leads/tags');
  const body = res.body as { tags?: string[]; counts?: { name: string }[] } | string[];
  if (Array.isArray(body)) return body as string[];
  return body.tags ?? (body.counts ?? []).map((c) => c.name);
}

test.describe('deleting a lead tag is confirmed first', () => {
  test('one click opens a dialog and deletes nothing yet', async ({ page }) => {
    await signIn(page, 'admin');
    const tag = unique('ZZ-TAGCONF');
    expect((await apiSend(page, 'POST', '/api/leads/tags', { tag })).status).toBeLessThan(300);

    try {
      await openTags(page);
      const row = tagsModal(page).locator('li').filter({ hasText: tag });
      await expect(row).toBeVisible();
      await row.getByRole('button', { name: /^Delete$/ }).click();

      // THE DEFECT: nothing was asked and the tag was already gone.
      await expect(confirmDialog(page)).toBeVisible();
      expect(await serverTags(page)).toContain(tag);
    } finally {
      await apiSend(page, 'DELETE', `/api/leads/tags?tag=${encodeURIComponent(tag)}`).catch(() => undefined);
    }
  });

  test('the dialog says how many leads it will reach', async ({ page }) => {
    await signIn(page, 'admin');
    const tag = unique('ZZ-TAGCOUNT');
    await apiSend(page, 'POST', '/api/leads/tags', { tag });

    try {
      await openTags(page);
      const row = tagsModal(page).locator('li').filter({ hasText: tag });
      // The count the window itself shows beside the tag.
      const shown = await row.locator('.pill').innerText();
      const count = Number(/(\d+)/.exec(shown)?.[1] ?? -1);
      expect(count).toBeGreaterThanOrEqual(0);

      await row.getByRole('button', { name: /^Delete$/ }).click();
      const dialog = confirmDialog(page);
      await expect(dialog).toContainText(tag);
      // Either the number of leads, or a plain statement that none carry it.
      await expect(dialog).toContainText(count > 0 ? new RegExp(`${count} lead`) : /No leads currently carry/i);
      // And it warns about the reach nobody can see from this window.
      if (count > 0) await expect(dialog).toContainText(/Campaign audiences/i);
    } finally {
      await apiSend(page, 'DELETE', `/api/leads/tags?tag=${encodeURIComponent(tag)}`).catch(() => undefined);
    }
  });

  test('Cancel leaves the tag alone', async ({ page }) => {
    await signIn(page, 'admin');
    const tag = unique('ZZ-TAGCANCEL');
    await apiSend(page, 'POST', '/api/leads/tags', { tag });

    try {
      await openTags(page);
      await tagsModal(page).locator('li').filter({ hasText: tag }).getByRole('button', { name: /^Delete$/ }).click();
      await confirmDialog(page).getByRole('button', { name: /^Cancel$/ }).click();

      await expect(confirmDialog(page)).toHaveCount(0);
      expect(await serverTags(page)).toContain(tag);
    } finally {
      await apiSend(page, 'DELETE', `/api/leads/tags?tag=${encodeURIComponent(tag)}`).catch(() => undefined);
    }
  });

  test('confirming really deletes it, and still offers the undo', async ({ page }) => {
    await signIn(page, 'admin');
    const tag = unique('ZZ-TAGGO');
    await apiSend(page, 'POST', '/api/leads/tags', { tag });

    try {
      await openTags(page);
      await tagsModal(page).locator('li').filter({ hasText: tag }).getByRole('button', { name: /^Delete$/ }).click();
      await confirmDialog(page).getByRole('button', { name: /Delete tag/ }).click();

      await expect.poll(async () => serverTags(page), { timeout: 10_000 }).not.toContain(tag);
      // The undo bar is unchanged by this fix and must not have been lost with the dialog.
      await expect(tagsModal(page).getByRole('button', { name: /^Restore$/ })).toBeVisible();
    } finally {
      await apiSend(page, 'DELETE', `/api/leads/tags?tag=${encodeURIComponent(tag)}`).catch(() => undefined);
    }
  });
});
