import { test, expect, type Page } from '@playwright/test';
import { signIn } from './helpers';

/**
 * CRM-025: the composer's Send button must not invite a press it cannot honour.
 *
 * SMALL ON ITS OWN, and filed for the company it keeps. An empty send would only earn a refusal
 * from the server. But this is the one screen in the CRM where somebody types a FREE-TEXT address
 * and mails it from the brokerage's own account, with attachments, and there is no confirmation
 * anywhere on that path - so a Send button that is live before anything has been typed is a sign
 * that the path is not checked before it fires.
 *
 * THE THRESHOLD IS "SOMEBODY TO SEND TO", NOT A VALID ADDRESS. Disabling Send while a person is
 * half-way through typing an address reads as the application being broken, and whether an address
 * is real is the server's question. Any of To, CC or BCC counts, because a message addressed only
 * by BCC is a real thing people send.
 *
 * NOTHING IS SENT. The one test that presses Send blocks the request and asserts on what was
 * attempted; the rest stop at the button's state.
 */

const composer = (page: Page) => page.locator('.modal').filter({ hasText: /New message|Discard/ }).first();
const sendButton = (page: Page) => composer(page).getByRole('button', { name: /^Send$/ });

async function openComposer(page: Page): Promise<void> {
  await page.goto('/crm/inbox');
  await page.getByRole('button', { name: /New message/i }).first().click();
  await expect(composer(page)).toBeVisible({ timeout: 15_000 });
}

/** The recipient inputs, in the order the composer renders them. */
const toField = (page: Page) => composer(page).locator('input').first();

test.describe('the mail composer will not send to nobody', () => {
  test('Send is disabled on an empty composer', async ({ page }) => {
    // The agent seat, because composing needs a connected mail account and that is the seat with one.
    await signIn(page, 'agent');
    await openComposer(page);

    // THE DEFECT: this button was live from the moment the composer opened.
    await expect(sendButton(page)).toBeDisabled();
    // Save draft stays available — keeping an unfinished message is not the same as sending it.
    await expect(composer(page).getByRole('button', { name: /Save draft/i })).toBeEnabled();
  });

  test('typing a recipient enables it, clearing the field disables it again', async ({ page }) => {
    // The agent seat, because composing needs a connected mail account and that is the seat with one.
    await signIn(page, 'agent');
    await openComposer(page);

    await toField(page).fill('someone@probe.invalid');
    await expect(sendButton(page)).toBeEnabled();

    await toField(page).fill('');
    await expect(sendButton(page)).toBeDisabled();
  });

  test('a subject and a body alone are not enough', async ({ page }) => {
    // Content without an address is exactly the half-finished message this guards.
    // The agent seat, because composing needs a connected mail account and that is the seat with one.
    await signIn(page, 'agent');
    await openComposer(page);

    /*
     * The subject is the second visible text field: CC and BCC stay hidden until "Add CC / BCC" is
     * pressed, and the file input is present but hidden. `.last()` picked that file input and the
     * fill timed out - a selector fault that looked like the guard misbehaving.
     */
    await composer(page).locator('input:not([type="file"])').nth(1).fill('A subject with nobody to read it');
    await expect(sendButton(page)).toBeDisabled();
  });

  test('pressing Send anyway attempts nothing', async ({ page }) => {
    const attempted: string[] = [];
    await page.route('**/api/mailbox/**', (r) => {
      if (r.request().method() === 'POST') { attempted.push(r.request().url()); return r.abort(); }
      return r.fallback();
    });

    // The agent seat, because composing needs a connected mail account and that is the seat with one.
    await signIn(page, 'agent');
    await openComposer(page);
    await sendButton(page).click({ force: true, timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(800);

    expect(attempted.filter((u) => /send/i.test(u))).toEqual([]);
  });
});
