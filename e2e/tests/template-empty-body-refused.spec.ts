import { test, expect, type Page } from '@playwright/test';
import { signIn, apiGet, apiSend } from './helpers';

/**
 * CRM-041: an automatic customer email cannot be saved with nothing in it.
 *
 * THE OTHER HALF OF CRM-040. That one was Preview writing unsaved edits to a live template. This is
 * the same templates reachable through the front door: press Save on a body you have just cleared
 * and it stored the empty version, said "Template saved", and closed.
 *
 * WHY THE CHECK MISSED IT. Both sides asked whether the body was the empty string. Clearing a
 * rich-text field does not leave the empty string — it leaves `<br>` — so `'<br>' !== ''` and the
 * save went through. The rule now asks whether a READER would see anything, which is the only
 * version that catches `<br>`, `<p>&nbsp;</p>` and an empty `<div>` alike.
 *
 * ASSERTED IN THE BROWSER because the defect is about what the Save button does. The server refuses
 * it too — `server/src/email/template-body-required.spec.ts` — and that is the rule that actually
 * binds; this is about whether the person editing is told, rather than left to find out later from
 * a client who received a blank email.
 *
 * THESE TEMPLATES ARE SEEDED, NOT CREATED. `index()` creates any missing event template on read, so
 * there is no create endpoint to make a throwaway one with. Every test therefore edits a real row
 * and puts it back in `afterEach`, and asserts against the body it captured rather than a constant.
 */

const TEMPLATES = '/api/email-templates';

type Template = { id: number; name: string; module: string; subject: string; body_html: string };
type ListBody = { groups?: { module: string; templates: Template[] }[] };

/** Restores whatever the template held, so a seeded row is never left changed. */
const restore: { page: Page; tpl: Template }[] = [];

test.afterEach(async () => {
  while (restore.length) {
    const r = restore.pop()!;
    await apiSend(r.page, 'PUT', `${TEMPLATES}/${r.tpl.id}`, {
      subject: r.tpl.subject, body_html: r.tpl.body_html,
    }).catch(() => undefined);
  }
});

async function allTemplates(page: Page): Promise<Template[]> {
  const res = await apiGet(page, TEMPLATES);
  return ((res.body as ListBody).groups ?? []).flatMap((g) => g.templates);
}

/**
 * A CRM template with real content — CRM because the deep link opens the CRM-scoped Templates tab
 * and silently shows the list instead of the editor for an id that is not in it, and "with content"
 * so that "the body survived" is a meaningful thing to assert. The module is stored as `CRM`, hence
 * the case-insensitive compare.
 */
async function pickTemplate(page: Page): Promise<Template | null> {
  const all = await allTemplates(page);
  return all.find((t) => t.module.toLowerCase() === 'crm' && (t.body_html ?? '').length > 20) ?? null;
}

const storedBody = async (page: Page, id: number): Promise<string | undefined> =>
  (await allTemplates(page)).find((t) => t.id === id)?.body_html;

/*
 * Waits on the rich-text field rather than on `getByLabel('Subject')`: the editor's inputs sit
 * beside their captions without being associated to them, so `getByLabel` finds nothing even with
 * the editor plainly open. The message field is also the thing these tests are actually about.
 */
async function openEditor(page: Page, tpl: Template): Promise<void> {
  await page.goto(`/crm/settings?tab=crm&section=templates&template=${tpl.id}`);
  await expect(page.getByText(tpl.name, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[contenteditable="true"]').first()).toBeVisible({ timeout: 15_000 });
}

/** Empty the rich-text field the way a person does: select all, delete. */
async function clearBody(page: Page): Promise<void> {
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
}

test.describe('an automatic customer email cannot be saved empty', () => {
  test('Save refuses a cleared body and says so', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const tpl = await pickTemplate(page);
    test.skip(!tpl, 'no seeded template with content on this database');
    restore.push({ page, tpl: tpl! });

    await openEditor(page, tpl!);
    await clearBody(page);
    await page.getByRole('button', { name: /^Save$/ }).click();

    // THE DEFECT: this said "Template saved" and closed, leaving a live template with no content.
    await expect(page.getByText(/message is empty/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Template saved/i)).toHaveCount(0);
  });

  test('the editor refuses it without asking the server', async ({ page }) => {
    /*
     * THIS IS THE TEST THAT PINS THE CLIENT-SIDE CHECK, and it exists because the obvious one does
     * not. Reverting the editor's check to the old `!form.body_html.trim()` leaves the two tests
     * either side of this one green: the server still answers 422, and the same toast renders the
     * server's wording, so "the person is told" stays true either way.
     *
     * What actually changes is whether an empty body is sent at all. Counting the request is the
     * only assertion here that can tell the two versions apart.
     *
     * OBSERVED, NOT INTERCEPTED. `page.on('request')` cannot swallow anything; a `page.route` that
     * aborts has twice in this suite's history also aborted the test's own cleanup.
     */
    await signIn(page, 'superAdmin');
    const tpl = await pickTemplate(page);
    test.skip(!tpl, 'no seeded template with content on this database');
    restore.push({ page, tpl: tpl! });

    await openEditor(page, tpl!);

    const puts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'PUT' && r.url().includes('/api/email-templates/')) puts.push(r.url());
    });

    await clearBody(page);
    await page.getByRole('button', { name: /^Save$/ }).click();
    await expect(page.getByText(/message is empty/i)).toBeVisible({ timeout: 10_000 });

    expect(puts).toEqual([]);
  });

  test('the stored template still holds its content', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const tpl = await pickTemplate(page);
    test.skip(!tpl, 'no seeded template with content on this database');
    restore.push({ page, tpl: tpl! });

    await openEditor(page, tpl!);
    await clearBody(page);
    await page.getByRole('button', { name: /^Save$/ }).click();
    await expect(page.getByText(/message is empty/i)).toBeVisible({ timeout: 10_000 });

    expect(await storedBody(page, tpl!.id)).toBe(tpl!.body_html);
  });

  test('the server refuses it even when the screen is bypassed', async ({ page }) => {
    /*
     * The screen is a courtesy. CRM-040 was exactly a save that arrived without passing the screen's
     * check, so the rule has to hold at the API too.
     */
    await signIn(page, 'superAdmin');
    const tpl = await pickTemplate(page);
    test.skip(!tpl, 'no seeded template with content on this database');
    restore.push({ page, tpl: tpl! });

    for (const blank of ['<br>', '<p>&nbsp;</p>', '<div></div>', '   ']) {
      const res = await apiSend(page, 'PUT', `${TEMPLATES}/${tpl!.id}`, {
        subject: tpl!.subject, body_html: blank,
      });
      expect(res.status, `accepted ${JSON.stringify(blank)}`).toBe(422);
    }

    expect(await storedBody(page, tpl!.id)).toBe(tpl!.body_html);
  });

  test('an ordinary edit still saves', async ({ page }) => {
    // The rule must not stand in the way of the work it is protecting.
    await signIn(page, 'superAdmin');
    const tpl = await pickTemplate(page);
    test.skip(!tpl, 'no seeded template with content on this database');
    restore.push({ page, tpl: tpl! });

    const res = await apiSend(page, 'PUT', `${TEMPLATES}/${tpl!.id}`, {
      subject: tpl!.subject, body_html: '<p>ZZ replacement body for the empty-body test.</p>',
    });
    expect([200, 201]).toContain(res.status);
    expect(await storedBody(page, tpl!.id)).toContain('ZZ replacement body');
  });

  test('a template whose whole body is a banner still saves', async ({ page }) => {
    // The case a stricter "must contain words" rule would have broken.
    await signIn(page, 'superAdmin');
    const tpl = await pickTemplate(page);
    test.skip(!tpl, 'no seeded template with content on this database');
    restore.push({ page, tpl: tpl! });

    const banner = '<img src="https://example.test/zz-banner.png" alt="Season greetings">';
    const res = await apiSend(page, 'PUT', `${TEMPLATES}/${tpl!.id}`, {
      subject: tpl!.subject, body_html: banner,
    });
    expect([200, 201]).toContain(res.status);
    expect(await storedBody(page, tpl!.id)).toBe(banner);
  });
});
