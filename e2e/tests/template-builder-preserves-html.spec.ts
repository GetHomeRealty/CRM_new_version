import { test, expect, type Page } from '@playwright/test';
import { signIn, apiSend, apiGet } from './helpers';

/**
 * CRM-037: switching to the visual builder must not empty a hand-written template.
 *
 * WHAT HAPPENED. The builder recognises its own work by a marker it leaves in the body. Opening an
 * HTML-written template in it produced an EMPTY canvas over the words "Add a block from the left to
 * start building" — indistinguishable from a template with nothing in it — and switching back to
 * HTML wrote that empty design over the body: real content replaced by `{"v":2,"blocks":[],…}`,
 * with Update Template sitting in its usual place ready to make it permanent.
 *
 * NOTHING ADMITTED THE PARSE HAD FAILED, which is the whole defect. The natural reading of a blank
 * canvas is "this template is blank", and the natural response is to build one and save it.
 *
 * THE AUDIT'S OWN FRAMING, kept because it is the right one: this becomes serious the day somebody
 * authors a template in the HTML view — which the product offers as a first-class mode — and then
 * clicks Visual builder to see how it looks.
 *
 * NOT FIXED BY PARSING HTML INTO BLOCKS. That is a different and much larger feature; the audit's
 * expected result allows either that or refusing and leaving the body alone. This refuses.
 */

const unique = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const created: { page: Page; id: number }[] = [];

const HAND_WRITTEN = '<div><h1>ZZ Heading Alpha</h1><p>First paragraph.</p>'
  + '<p style="color:#123456">Second paragraph.</p></div>';

test.afterEach(async () => {
  while (created.length) {
    const t = created.pop()!;
    await apiSend(t.page, 'DELETE', `/api/campaigns/templates/${t.id}`).catch(() => undefined);
  }
});

async function makeTemplate(page: Page, content: string): Promise<{ id: number; name: string }> {
  const name = unique('ZZ-HTMLTPL');
  const res = await apiSend(page, 'POST', '/api/campaigns/templates', {
    name, subject: 'ZZ subject', content, category: 'custom',
  });
  expect([200, 201]).toContain(res.status);
  const id = (res.body as { id?: number; data?: { id?: number } })?.id
    ?? (res.body as { data?: { id?: number } })?.data?.id as number;
  created.push({ page, id });
  return { id, name };
}

async function openEditor(page: Page, name: string): Promise<void> {
  await page.goto('/crm/campaigns');
  await page.getByRole('button', { name: /Templates/i }).first().click();
  const card = page.locator('.tpl-card, li, tr').filter({ hasText: name }).first();
  await expect(card).toBeVisible({ timeout: 10_000 });
  // The control reads "✏️ Edit", so an anchored /^Edit$/ never matches it.
  await card.getByRole('button', { name: /Edit/ }).click();
  await expect(page.getByText('Body *')).toBeVisible({ timeout: 10_000 });
}

const bodyBox = (page: Page) => page.locator('textarea').first();

test.describe('the visual builder does not empty a hand-written template', () => {
  test('it refuses, and says why, instead of showing a blank canvas', async ({ page }) => {
    await signIn(page, 'admin');
    const tpl = await makeTemplate(page, HAND_WRITTEN);
    await openEditor(page, tpl.name);

    await page.getByRole('button', { name: /Visual builder/i }).click();

    // THE DEFECT: this silently switched and showed "Add a block from the left to start building".
    await expect(page.getByText(/cannot open this template/i)).toBeVisible();
    await expect(page.getByText(/only edit templates it made itself/i)).toBeVisible();
  });

  test('declining leaves the HTML exactly as it was', async ({ page }) => {
    await signIn(page, 'admin');
    const tpl = await makeTemplate(page, HAND_WRITTEN);
    await openEditor(page, tpl.name);

    await page.getByRole('button', { name: /Visual builder/i }).click();
    await page.locator('.modal').filter({ hasText: 'cannot open this template' })
      .getByRole('button', { name: /^Cancel$/ }).click();

    // Still the real body, in the editor and unsaved.
    await expect(bodyBox(page)).toHaveValue(/ZZ Heading Alpha/);
    await expect(bodyBox(page)).not.toHaveValue(/"blocks":\[\]/);
  });

  test('accepting is a deliberate choice, and only then replaces the body', async ({ page }) => {
    await signIn(page, 'admin');
    const tpl = await makeTemplate(page, HAND_WRITTEN);
    await openEditor(page, tpl.name);

    await page.getByRole('button', { name: /Visual builder/i }).click();
    await page.locator('.modal').filter({ hasText: 'cannot open this template' })
      .getByRole('button', { name: /Replace it with a new design/i }).click();

    // A starter design, not an empty canvas — the person asked for a design, so they get one.
    await expect(page.getByRole('button', { name: /Visual builder/i })).toHaveClass(/on/);
  });

  test('the stored template is untouched throughout', async ({ page }) => {
    // The audit's own reassurance, pinned: the loss lived in the editor until Save was pressed.
    await signIn(page, 'admin');
    const tpl = await makeTemplate(page, HAND_WRITTEN);
    await openEditor(page, tpl.name);

    await page.getByRole('button', { name: /Visual builder/i }).click();
    await page.locator('.modal').filter({ hasText: 'cannot open this template' })
      .getByRole('button', { name: /Replace it with a new design/i }).click();
    await page.getByRole('button', { name: /^Cancel$/ }).first().click();

    const stored = await apiGet(page, `/api/campaigns/templates/${tpl.id}`);
    expect(String((stored.body as { content: string }).content)).toContain('ZZ Heading Alpha');
  });

  test('a builder-made template still round-trips', async ({ page }) => {
    /*
     * The case that always worked, and must keep working: a body carrying the builder's marker
     * opens in the builder with its blocks and can go back to HTML unharmed.
     */
    await signIn(page, 'admin');
    const tpl = await makeTemplate(page, HAND_WRITTEN);
    await openEditor(page, tpl.name);

    // Convert it deliberately, then check the round trip from that point.
    await page.getByRole('button', { name: /Visual builder/i }).click();
    await page.locator('.modal').filter({ hasText: 'cannot open this template' })
      .getByRole('button', { name: /Replace it with a new design/i }).click();

    // Scoped to the builder/HTML segmented control: "HTML" appears on more than one button.
    await page.locator('.seg').getByRole('button', { name: /HTML/ }).click();
    const html = await bodyBox(page).inputValue();
    expect(html).toContain('BUILDER:');

    await page.getByRole('button', { name: /Visual builder/i }).click();
    // No refusal this time: the body is now the builder's own work.
    await expect(page.getByText(/cannot open this template/i)).toHaveCount(0);
  });
});
