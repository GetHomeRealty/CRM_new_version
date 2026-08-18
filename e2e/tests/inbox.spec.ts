import { test, expect } from '@playwright/test';
import { signIn, apiGet, apiSend } from './helpers';

/**
 * The CRM Inbox, driven as a person uses it.
 *
 * The seeded mailbox belongs to `agent@test.local` and holds five messages, one of them already
 * read. Everything here is written against that.
 */

test.beforeEach(async ({ page }) => {
  await signIn(page, 'agent');
  await page.goto('/crm/inbox');
});

test('lists the seeded mail', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  await expect(page.getByText('Re: 12 Elm Street — offer question')).toBeVisible();
  await expect(page.getByText('Viewing availability this weekend')).toBeVisible();
});

test('names which mailbox is being shown', async ({ page }) => {
  // The list is one account's mail, not everything connected. Saying so is what stops a shorter
  // list than yesterday reading as lost mail.
  await expect(page.getByText(/dana\.okafor@test\.local/)).toBeVisible();
});

test('opens a message and shows its body', async ({ page }) => {
  await page.getByText('Re: 12 Elm Street — offer question').click();
  await expect(page.getByText(/deposit is due on acceptance/)).toBeVisible();
});

/**
 * A STRANGER'S HTML IS ISOLATED, NOT DELETED — and this test used to assert the opposite.
 *
 * ================================================================================================
 * WHAT CHANGED AND WHY THE OLD ASSERTION HAD TO GO. The reader used to strip every tag and print the
 * result in a `<pre>`, and this test checked for that `<pre>`. Stripping is safe and unreadable: a
 * mail with a logo, a table of figures or a photo arrived as a wall of text with bare URLs where the
 * links had been. `MailBody` replaced it, and the old assertion then failed on a screen that was
 * working better than before — a stale test reporting a regression that was an improvement.
 *
 * THE CONCERN THE OLD TEST HELD IS STILL RIGHT: a stranger's markup must never run in our origin.
 * The answer is now isolation rather than deletion, so this asserts the isolation:
 *
 *   `sandbox` WITHOUT `allow-scripts`      no script in the message runs at all
 *   `sandbox` WITHOUT `allow-same-origin`  the frame is an opaque origin — it cannot read our
 *                                          cookies, storage or DOM, and cannot call our API even
 *                                          though the browser would attach the session
 *
 * Those two absences are the entire security boundary, and they are enforced by the browser rather
 * than by our code — which is why they are worth pinning by name. `allow-popups` and
 * `allow-popups-to-escape-sandbox` are present on purpose: without them a link in a message does
 * nothing at all, because a sandboxed frame may not navigate its parent.
 * ================================================================================================
 */
test('renders the body in a sandboxed frame that can neither script nor reach our origin', async ({ page }) => {
  await page.getByText('Re: 12 Elm Street — offer question').click();
  const modal = page.locator('.modal').first();

  const frame = modal.locator('iframe.inbox-html');
  await expect(frame).toBeVisible();

  const sandbox = (await frame.getAttribute('sandbox')) ?? '';
  // The two that must be ABSENT. Either one alone would undo the isolation.
  expect(sandbox).not.toContain('allow-scripts');
  expect(sandbox).not.toContain('allow-same-origin');
  // And the two that must be PRESENT, or links stop working.
  expect(sandbox).toContain('allow-popups');
  expect(sandbox).toContain('allow-popups-to-escape-sandbox');

  // The body is carried in `srcdoc`, so nothing is fetched from a third party to render it.
  expect(await frame.getAttribute('srcdoc')).toBeTruthy();

  // The message still READS — isolation was not bought by losing the content.
  await expect(frame.contentFrame().getByText(/deposit is due on acceptance/)).toBeVisible();
});

/**
 * Timestamps are shown in the reader's timezone.
 *
 * This is the H-1 regression. The old code took the UTC instant the server sends, dropped the `Z`
 * and printed the digits as local time — four or five hours adrift in Toronto, and anything after
 * 8pm was dated the following day. A unit test cannot catch it because the bug only exists once a
 * real browser in a real timezone renders it.
 */
test('shows received times in local time, not UTC', async ({ page }) => {
  const rows = page.locator('.inbox-list li');
  await expect(rows.first()).toBeVisible();

  const shown = (await rows.first().locator('.inbox-meta .muted').innerText()).trim();

  // The raw ISO string must not be what is on screen: no `T` separator, no trailing Z.
  expect(shown).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  expect(shown).not.toMatch(/Z$/);

  // And it must agree with what toLocaleString would produce for the instant the API returned.
  const res = await apiGet(page, '/api/account/inbox?area=crm');
  const first = (res.body as { data: { received_at: string }[] }).data[0];
  const expected = await page.evaluate(
    (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
    first.received_at,
  );
  expect(shown).toBe(expected);
});

test('marks a message read, and the unread count follows', async ({ page }) => {
  /*
   * Guarantee something is unread before asserting that reading it changes the count.
   *
   * Without this the test passes once and fails ever after: the first run leaves every seeded
   * message read, so the second finds no "Mark read" button and reports a broken inbox when the
   * only thing wrong is a database the previous run left behind.
   */
  // Set up through the API, not the UI. Clicking "Mark unread" first works, but the count then
  // has to be read after the list has finished reloading, and racing that is how this test spent
  // two runs reporting a broken inbox that was fine.
  const list = await apiGet(page, '/api/account/inbox?area=crm');
  const firstId = (list.body as { data: { id: number }[] }).data[0].id;
  // `?area=crm` is not optional in practice. Omitting it makes parseArea fall back to the
  // Transaction Desk, whose primary mailbox is a different account — so the very message the list
  // just returned comes back 404 from the write. Worth knowing when reading this endpoint's docs.
  await apiSend(page, 'PUT', `/api/account/inbox/${firstId}/seen?area=crm`, { seen: false });
  await page.reload();

  const before = await apiGet(page, '/api/account/inbox?area=crm');
  const unreadBefore = (before.body as { unread: number }).unread;
  expect(unreadBefore).toBeGreaterThan(0);

  await page.locator('.inbox-list li').filter({ hasText: 'Mark read' }).first()
    .getByRole('button', { name: 'Mark read' }).click();

  await expect.poll(async () => {
    const after = await apiGet(page, '/api/account/inbox?area=crm');
    return (after.body as { unread: number }).unread;
  }, { timeout: 10_000 }).toBe(unreadBefore - 1);
});

test('the unread filter shows only unread mail', async ({ page }) => {
  await page.getByRole('button', { name: 'All mail' }).click();
  await expect(page.getByRole('button', { name: 'Showing unread' })).toBeVisible();

  // The seeded read message must drop out of the list.
  await expect(page.getByText('New listings matching your search')).toHaveCount(0);
});

test('what the screen shows matches what the API returns', async ({ page }) => {
  const res = await apiGet(page, '/api/account/inbox?area=crm');
  const total = (res.body as { data: unknown[] }).data.length;
  await expect(page.locator('.inbox-list li')).toHaveCount(total);
});

test('another agent cannot read this mailbox', async ({ page, context }) => {
  // Nobody reads anyone else's mail. Checked against the API directly, because the UI never
  // offers the option and the guarantee has to hold whether or not it does.
  const mine = await apiGet(page, '/api/account/inbox?area=crm');
  const id = (mine.body as { data: { id: number }[] }).data[0].id;

  await context.clearCookies();
  await signIn(page, 'agent2');

  const theirs = await apiGet(page, `/api/account/inbox/${id}?area=crm`);
  expect(theirs.status).toBe(404);
});
