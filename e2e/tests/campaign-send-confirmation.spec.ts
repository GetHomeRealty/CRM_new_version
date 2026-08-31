import { test, expect, type Page } from '@playwright/test';
import { signIn, apiSend } from './helpers';

/**
 * A campaign asks before it goes out, and says what it is about to do.
 *
 * WHY IT WAS NEEDED. Every other irreversible act in this module already confirms - deleting a
 * campaign, cancelling a schedule - while the one that actually mails clients went out on a single
 * click. CRM-011 removed the worst of that by unarming the composer's default audience, but a
 * narrowed audience of four hundred people was still one press away.
 *
 * WHAT THE DIALOG HAS TO GET RIGHT is that every figure on it is the server's. A confirmation built
 * from what the browser assumes could reassure somebody about a campaign that was going somewhere
 * else entirely - which is worse than no confirmation, because it invites the click it should be
 * slowing down. The count comes from `previewAudience`, the scope from the capability the send path
 * consults, the sender from the mailer's own resolution.
 *
 * BOTH SEATS ARE TESTED. The audience line is the one part that differs between an agent and a
 * brokerage-wide user, and it is the part somebody would rely on.
 *
 * NOTHING IS EVER SENT. Every test blocks the campaign POST at the network layer and asserts on
 * what was attempted, so a regression cannot mail the seeded book on the way to failing.
 */

/*
 * EACH TEST BRINGS ITS OWN TEMPLATE, and takes it away again.
 *
 * Campaign templates are author-scoped, so which seats have one depends on who happened to create
 * them - the agent seat has seeded templates and the admin seat does not, which made half of these
 * fail for a reason that had nothing to do with the confirmation. Creating one per test keeps the
 * suite honest about what it is testing; deleting it keeps this file from becoming the kind of
 * litter that has already broken an unrelated suite in this repository.
 */
const createdTemplates: { page: Page; id: number }[] = [];

async function ensureTemplate(page: Page): Promise<string> {
  const name = `ZZ-CONFIRM-TPL-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const res = await apiSend(page, 'POST', '/api/campaigns/templates', {
    name,
    subject: 'ZZ confirmation subject',
    content: '<p>ZZ body</p>',
    category: 'custom',
  });
  expect([200, 201]).toContain(res.status);
  const id = (res.body as { id?: number }).id;
  if (id) createdTemplates.push({ page, id });
  return name;
}

test.afterEach(async () => {
  while (createdTemplates.length) {
    const t = createdTemplates.pop()!;
    await apiSend(t.page, 'DELETE', `/api/campaigns/templates/${t.id}`).catch(() => undefined);
  }
});

async function openComposer(page: Page): Promise<void> {
  await page.goto('/crm/campaigns');
  await page.getByRole('button', { name: /Create Campaign/i }).first().click();
  await expect(page.getByText(/recipients? match this segment/i)).toBeVisible({ timeout: 10_000 });
}

/** Fill the two required fields and arm the unfiltered audience, as a person would. */
async function readyToSend(page: Page, name: string, templateName: string): Promise<void> {
  await page.getByPlaceholder(/market update/i).fill(name);

  /*
   * BY ITS OWN NAME. "Whichever template is last" picked up a leftover from another spec and this
   * test then asserted against that one's subject - a failure that pointed at the confirmation
   * dialog and was really about test litter.
   */
  const template = page.locator('select').filter({ hasText: 'Choose a template to send' }).first();
  await template.selectOption({ label: templateName });

  const everyone = page.getByRole('checkbox');
  if (await everyone.count()) await everyone.first().check();
}

/** Record every attempted campaign commit, and let none of them through. */
async function blockSends(page: Page): Promise<string[]> {
  const attempted: string[] = [];
  await page.route('**/api/campaigns', async (route) => {
    if (route.request().method() === 'POST') { attempted.push(route.request().postData() ?? ''); return route.abort(); }
    return route.fallback();
  });
  return attempted;
}

const sendButton = (page: Page) => page.getByRole('button', { name: /^(Send to|Schedule for)\s+\d+/ });
const confirmButton = (page: Page) => page.getByRole('button', { name: /^Confirm Send$/ });

test.describe('sending a campaign is confirmed first', () => {
  test('pressing Send opens a dialog and sends nothing yet', async ({ page }) => {
    await signIn(page, 'admin');
    const attempted = await blockSends(page);
    const tplName = await ensureTemplate(page);
    await openComposer(page);
    await readyToSend(page, `ZZ-CONFIRM-${Date.now()}`, tplName);

    await sendButton(page).click();

    await expect(page.getByText(/You are sending this campaign to/i)).toBeVisible();
    await expect(confirmButton(page)).toBeVisible();
    // THE POINT: the dialog is open and the campaign has not been committed.
    expect(attempted).toEqual([]);
  });

  test('the dialog states the count, the audience, the sender and the subject', async ({ page }) => {
    await signIn(page, 'admin');
    await blockSends(page);
    const tplName = await ensureTemplate(page);
    await openComposer(page);

    // The count the server resolved for these filters, read off the composer itself.
    const audienceText = await page.locator('.camp-audience').first().innerText();
    const count = Number(/(\d+)\s+recipient/.exec(audienceText)?.[1] ?? 0);
    expect(count).toBeGreaterThan(0);

    await readyToSend(page, `ZZ-CONFIRM-${Date.now()}`, tplName);
    await sendButton(page).click();

    const dialog = page.locator('.modal').filter({ hasText: 'Send this campaign?' });
    await expect(dialog).toContainText(new RegExp(`${count} lead`));
    await expect(dialog).toContainText('Audience');
    await expect(dialog).toContainText('Sender');
    await expect(dialog).toContainText('Subject');
    // A real address, not a placeholder for one.
    await expect(dialog).toContainText(/@/);
    // THE ACTUAL SUBJECT of the template this test created - a label reading "Subject" beside
    // placeholder text would satisfy a weaker assertion and tell the sender nothing.
    await expect(dialog).toContainText('ZZ confirmation subject');
    // And the scope the server decided, rather than a guess from the role in the browser.
    await expect(dialog).toContainText(/Brokerage-wide|Your leads only/);
  });

  test('Cancel closes it and sends nothing', async ({ page }) => {
    await signIn(page, 'admin');
    const attempted = await blockSends(page);
    const tplName = await ensureTemplate(page);
    await openComposer(page);
    await readyToSend(page, `ZZ-CONFIRM-${Date.now()}`, tplName);

    await sendButton(page).click();
    // The DIALOG's Cancel. The composer behind it has one too, and it is covered by the overlay -
    // `.first()` picked that one and waited ten seconds for a button nothing could click.
    await page.locator('.modal').filter({ hasText: 'Send this campaign?' })
      .getByRole('button', { name: /^Cancel$/ }).click();

    await expect(page.getByText(/You are sending this campaign to/i)).toHaveCount(0);
    expect(attempted).toEqual([]);
    // The composer is still there, with the work still in it.
    await expect(sendButton(page)).toBeVisible();
  });

  test('Confirm Send commits exactly one campaign, however many times it is pressed', async ({ page }) => {
    await signIn(page, 'admin');
    const attempted = await blockSends(page);
    const tplName = await ensureTemplate(page);
    await openComposer(page);
    await readyToSend(page, `ZZ-CONFIRM-${Date.now()}`, tplName);

    await sendButton(page).click();
    const confirm = confirmButton(page);
    // A REAL double click, not two deliberate presses: the case being guarded is an impatient
    // user or a slow network, where both events land before anything has had time to react.
    await confirm.dblclick({ delay: 0 });
    // The dialog closes on confirm, so a second press cannot reach it - asserted rather than
    // assumed, because "the button went away" is the whole duplicate-send guard on this side.
    await expect(confirm).toHaveCount(0);
    await page.waitForTimeout(500);

    expect(attempted).toHaveLength(1);
    // And the commit carries the idempotency key the server de-duplicates on, so a retry at the
    // network layer cannot become a second campaign either.
    expect(attempted[0]).toContain('idempotency_key');
  });

  test('an agent is told their campaign reaches their own leads only', async ({ page }) => {
    await signIn(page, 'agent');
    await blockSends(page);
    const tplName = await ensureTemplate(page);
    await openComposer(page);
    await readyToSend(page, `ZZ-CONFIRM-AGENT-${Date.now()}`, tplName);

    await sendButton(page).click();
    const dialog = page.locator('.modal').filter({ hasText: 'Send this campaign?' });
    await expect(dialog).toContainText('Your leads only');
    await expect(dialog).not.toContainText('Brokerage-wide');
  });

  test('a brokerage-wide user is told the audience is brokerage-wide', async ({ page }) => {
    // The same dialog, the other answer. Both come from `campaigns.brokerage-audience`, so this
    // pair is what stops the sentence drifting from the capability that decides the audience.
    await signIn(page, 'admin');
    await blockSends(page);
    const tplName = await ensureTemplate(page);
    await openComposer(page);
    await readyToSend(page, `ZZ-CONFIRM-ADMIN-${Date.now()}`, tplName);

    await sendButton(page).click();
    const dialog = page.locator('.modal').filter({ hasText: 'Send this campaign?' });
    await expect(dialog).toContainText('Brokerage-wide');
  });
});
