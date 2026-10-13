import { test, expect, type Page } from '@playwright/test';
import { signIn, apiSend } from './helpers';

/**
 * THE TWO EMAIL STYLES, AND THE PREVIEW, IN A BROWSER.
 *
 * WHAT ONLY A BROWSER CAN ANSWER. `campaign-body-mode.spec.ts` proves what the send does in each
 * mode and `simple-email.spec.ts` proves the rendering. Neither can tell you that the composer
 * offers the choice, that the preview shows the message, or that the text on screen is readable
 * rather than a string of escape sequences - a mistake that typechecks perfectly and renders as
 * "Gmail’s" to the reader. One was in this feature until this file was written.
 *
 * NOTHING IS EVER SENT. No test here commits a campaign. The preview endpoint creates nothing by
 * construction, and the composer is only read.
 *
 * NO CLAIM ABOUT INBOX PLACEMENT is asserted anywhere, because none is made. What IS asserted is
 * that the screen says so: the Promotions caveat has to be visible wherever the signals are, or
 * the list reads as a checklist for reaching the Primary tab, which it is not.
 */

const createdTemplates: { page: Page; id: number }[] = [];

/** A template with every piece of newsletter furniture the simple style is meant to drop. */
const DESIGNED = '<table width="600" bgcolor="#f3f4f6" cellpadding="24">'
  + '<tr><td style="background:#0a4;color:#fff;font-size:30px;">GET HOME REALTY</td></tr>'
  + '<tr><td><img src="https://cdn.test/banner.png" width="600" alt="Spring market" /></td></tr>'
  + '<tr><td style="font-family:Georgia,serif;">Prices in Brampton rose three percent last month.</td></tr>'
  + '<tr><td><a href="https://gethomerealty.ca/listings" style="background:#0a4;padding:14px 28px;color:#fff;">BROWSE LISTINGS</a></td></tr>'
  + '</table>';

async function ensureTemplate(page: Page): Promise<string> {
  const name = `ZZ-MODE-TPL-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const res = await apiSend(page, 'POST', '/api/campaigns/templates', {
    name, subject: 'Hi {{LEAD_NAME}}, your market update', content: DESIGNED, category: 'custom',
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

async function openComposer(page: Page, templateName: string): Promise<void> {
  await page.goto('/crm/campaigns');
  await page.getByRole('button', { name: /Create Campaign/i }).first().click();
  await expect(page.getByText(/recipients? match this segment/i)).toBeVisible({ timeout: 15_000 });
  const template = page.locator('select').filter({ hasText: 'Choose a template to send' }).first();
  await template.selectOption({ label: templateName });
}

/** Nothing in this file may commit a campaign; this makes that a property rather than a hope. */
async function blockSends(page: Page): Promise<string[]> {
  const attempted: string[] = [];
  await page.route('**/api/campaigns', async (route) => {
    if (route.request().method() === 'POST') { attempted.push(route.request().postData() ?? ''); return route.abort(); }
    return route.fallback();
  });
  return attempted;
}

// =====================================================================================
test.describe('the composer offers two email styles', () => {
  test('STANDARD IS THE DEFAULT, so a campaign built without touching this is unchanged', async ({ page }) => {
    await signIn(page, 'agent');
    const tpl = await ensureTemplate(page);
    await openComposer(page, tpl);

    await expect(page.getByTestId('mode-standard')).toBeChecked();
    await expect(page.getByTestId('mode-simple')).not.toBeChecked();
    await expect(page.getByTestId('mode-note')).toContainText(/exactly as designed/i);
  });

  test('CHOOSING SIMPLE STATES THE CONSEQUENCE — that opens and clicks are not measured', async ({ page }) => {
    /*
     * The honesty requirement, on screen. A simple email records no opens, and somebody who is not
     * told that will read the resulting zero as a result rather than as an absence.
     */
    await signIn(page, 'agent');
    const tpl = await ensureTemplate(page);
    await openComposer(page, tpl);

    await page.getByTestId('mode-simple').check();

    const note = page.getByTestId('mode-note');
    await expect(note).toContainText(/NOT measured/i);
    await expect(note).toContainText(/unsubscribe/i);
    // And the caveat that this is not a trick for reaching the Primary tab.
    await expect(page.getByText(/not.*a way around Gmail/i)).toBeVisible();
  });

  test('THE ON-SCREEN TEXT IS READABLE, not raw escape sequences', async ({ page }) => {
    /*
     * This exists because the bug happened. `\\u2019` inside JSX TEXT is not an escape - it renders
     * literally - while the identical sequence inside a JavaScript string is fine. Both typecheck.
     * The only thing that catches it is reading the rendered page.
     */
    await signIn(page, 'agent');
    const tpl = await ensureTemplate(page);
    await openComposer(page, tpl);
    await page.getByTestId('mode-simple').check();

    const body = await page.locator('.modal').first().innerText();
    expect(body).not.toMatch(/\\u[0-9a-fA-F]{4}/);
  });
});

// =====================================================================================
test.describe('the preview shows the message that will actually be sent', () => {
  test('SIMPLE STRIPS THE DESIGN AND KEEPS THE WORDS, and still shows the unsubscribe footer', async ({ page }) => {
    await signIn(page, 'agent');
    const attempted = await blockSends(page);
    const tpl = await ensureTemplate(page);
    await openComposer(page, tpl);
    await page.getByTestId('mode-simple').check();

    await page.getByTestId('open-email-preview').click();
    await expect(page.getByTestId('email-preview-modal')).toBeVisible({ timeout: 15_000 });

    // The subject is personalised, not a raw token.
    await expect(page.getByTestId('preview-subject')).not.toContainText('{{');

    const frame = page.frameLocator('[data-testid="preview-frame"]');
    const text = await frame.locator('body').innerText();
    expect(text).toContain('Prices in Brampton rose three percent last month.');
    // The footer IS part of the email and IS previewed.
    expect(text.toLowerCase()).toContain('unsubscribe');
    // The furniture is gone.
    const html = await frame.locator('body').innerHTML();
    expect(html).not.toContain('<table');
    expect(html).not.toContain('cdn.test/banner.png');

    await expect(page.getByTestId('preview-tracking')).toContainText(/not measured/i);
    // Nothing was committed to open a preview.
    expect(attempted).toEqual([]);
  });

  test('STANDARD PREVIEWS THE DESIGN UNTOUCHED, and says tracking is on', async ({ page }) => {
    await signIn(page, 'agent');
    await blockSends(page);
    const tpl = await ensureTemplate(page);
    await openComposer(page, tpl);

    await page.getByTestId('open-email-preview').click();
    await expect(page.getByTestId('email-preview-modal')).toBeVisible({ timeout: 15_000 });

    const html = await page.frameLocator('[data-testid="preview-frame"]').locator('body').innerHTML();
    expect(html).toContain('<table');
    expect(html).toContain('cdn.test/banner.png');
    await expect(page.getByTestId('preview-tracking')).toContainText(/measured/i);
    await expect(page.getByTestId('preview-tracking')).not.toContainText(/not measured/i);
  });

  test('THE PROMOTIONS CAVEAT APPEARS WHEREVER THE SIGNALS DO', async ({ page }) => {
    /*
     * The signals list invites exactly the wrong conclusion if it stands alone — that working
     * through it buys the Primary tab. It does not, and the screen has to say so in the same place.
     */
    await signIn(page, 'agent');
    await blockSends(page);
    const tpl = await ensureTemplate(page);
    await openComposer(page, tpl);
    await page.getByTestId('open-email-preview').click();
    await expect(page.getByTestId('email-preview-modal')).toBeVisible({ timeout: 15_000 });

    const signals = page.getByTestId('preview-signals');
    if (await signals.count()) {
      await expect(signals).toContainText(/per recipient/i);
      await expect(signals).toContainText(/no change here guarantees/i);
    }
  });

  test('shows the plain-text alternative too', async ({ page }) => {
    await signIn(page, 'agent');
    await blockSends(page);
    const tpl = await ensureTemplate(page);
    await openComposer(page, tpl);
    await page.getByTestId('mode-simple').check();
    await page.getByTestId('open-email-preview').click();
    await expect(page.getByTestId('email-preview-modal')).toBeVisible({ timeout: 15_000 });

    await page.getByText(/Plain-text version/i).click();
    const text = await page.getByTestId('preview-text').innerText();
    expect(text).toContain('Brampton');
    expect(text).not.toContain('<');
  });

  test('the Preview button is unavailable until a template is chosen', async ({ page }) => {
    await signIn(page, 'agent');
    await page.goto('/crm/campaigns');
    await page.getByRole('button', { name: /Create Campaign/i }).first().click();
    await expect(page.getByText(/recipients? match this segment/i)).toBeVisible({ timeout: 15_000 });

    await expect(page.getByTestId('open-email-preview')).toBeDisabled();
  });
});
