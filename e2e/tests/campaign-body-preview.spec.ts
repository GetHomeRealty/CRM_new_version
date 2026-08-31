import { test, expect, type Page } from '@playwright/test';
import { signIn, apiSend } from './helpers';

/**
 * CRM-029: the composer must show the message it is about to send.
 *
 * NOT HYPOTHETICAL. A template still carrying the placeholder it shipped with — "Write your message
 * here." — was sent to two real clients on 27 August, and both opened it. Everything around that
 * sentence was right: the brokerage header, the lead's name substituted twice, a styled panel, a
 * call-to-action, the agent's phone number, a working unsubscribe. Only the message was missing,
 * and the polish is what made it convincing enough to send.
 *
 * THE TEMPLATE HALF IS THE BROKERAGE'S AND IS DONE. This covers the half that would let it happen
 * again: the composer offered a message by NAME and a button reading "Send to 1", and never showed
 * the message. As the audit put it — a brokerage can be careless with a template; a product should
 * not let the result go out unseen.
 *
 * SHOWN AS TEXT, NOT RENDERED. Rendering the markup would produce a handsome email around an empty
 * message, which is precisely the thing that got past everybody the first time.
 *
 * NOTHING IS SENT: the campaign POST is blocked and each test cleans up its own template.
 */

const unique = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const created: { page: Page; id: number }[] = [];

test.afterEach(async () => {
  while (created.length) {
    const t = created.pop()!;
    await apiSend(t.page, 'DELETE', `/api/campaigns/templates/${t.id}`).catch(() => undefined);
  }
});

async function makeTemplate(page: Page, name: string, content: string): Promise<string> {
  const res = await apiSend(page, 'POST', '/api/campaigns/templates', {
    name, subject: 'ZZ preview subject', content, category: 'custom',
  });
  expect([200, 201]).toContain(res.status);
  const id = (res.body as { id?: number; data?: { id?: number } })?.id ?? (res.body as { data?: { id?: number } })?.data?.id;
  if (id) created.push({ page, id });
  return name;
}

async function openComposerWith(page: Page, templateName: string): Promise<void> {
  await page.route('**/api/campaigns', (r) => (r.request().method() === 'POST' ? r.abort() : r.fallback()));
  await page.goto('/crm/campaigns');
  await page.getByRole('button', { name: /Create Campaign/i }).first().click();
  await expect(page.getByText(/recipients? match this segment/i)).toBeVisible({ timeout: 10_000 });
  await page.locator('select').filter({ hasText: 'Choose a template to send' }).first()
    .selectOption({ label: templateName });
}

test.describe('the composer shows what is about to be sent', () => {
  test('a chosen template shows its message, not just its name', async ({ page }) => {
    await signIn(page, 'admin');
    const name = await makeTemplate(page, unique('ZZ-PREVIEW'),
      '<div style="padding:20px"><h1>Hello {{lead_name}}</h1><p>The spring market in Caledon is moving quickly.</p></div>');

    await openComposerWith(page, name);

    // THE DEFECT: the screen showed the name and the subject and nothing else.
    await expect(page.getByText('Message preview')).toBeVisible();
    await expect(page.getByText(/spring market in Caledon is moving quickly/i)).toBeVisible();
  });

  test('a template still holding its placeholder is called out', async ({ page }) => {
    await signIn(page, 'admin');
    const name = await makeTemplate(page, unique('ZZ-PLACEHOLDER'),
      '<div><h1>Welcome {{lead_name}}</h1><p>Write your message here.</p><a href="#">Get in touch</a></div>');

    await openComposerWith(page, name);

    await expect(page.getByText(/still has its placeholder text/i)).toBeVisible();
    // And the placeholder itself is visible, so the warning is evidenced rather than asserted.
    await expect(page.getByText(/Write your message here/i).first()).toBeVisible();
  });

  test('a written template is not accused of being unwritten', async ({ page }) => {
    // The warning has to stay rare, or it becomes something people click past.
    await signIn(page, 'admin');
    const name = await makeTemplate(page, unique('ZZ-WRITTEN'),
      '<div><p>Thank you for getting in touch about the Caledon listing.</p></div>');

    await openComposerWith(page, name);

    await expect(page.getByText(/Thank you for getting in touch/i)).toBeVisible();
    await expect(page.getByText(/still has its placeholder text/i)).toHaveCount(0);
  });

  test('the send confirmation repeats the opening words', async ({ page }) => {
    /*
     * The preview pane can be scrolled past. The confirmation is the last moment before a mailing
     * leaves, so the message appears there too — the whole finding is that somebody could commit to
     * a send without ever having seen what it says.
     */
    await signIn(page, 'admin');
    const name = await makeTemplate(page, unique('ZZ-CONFIRM-BODY'),
      '<div><p>A distinctive opening line about Caledon pre-construction.</p></div>');

    await openComposerWith(page, name);
    await page.getByPlaceholder(/market update/i).fill(unique('ZZ-BODY-CAMP'));
    const everyone = page.getByRole('checkbox');
    if (await everyone.count()) await everyone.first().check();
    await page.getByRole('button', { name: /^(Send to|Schedule for)\s+\d+/ }).click();

    const dialog = page.locator('.modal').filter({ hasText: 'Send this campaign?' });
    await expect(dialog).toContainText('Opens with');
    await expect(dialog).toContainText(/distinctive opening line about Caledon/i);
  });
});
