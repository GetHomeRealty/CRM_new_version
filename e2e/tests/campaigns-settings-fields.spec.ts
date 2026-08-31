import { test, expect, type Page, type Locator } from '@playwright/test';
import { signIn, apiGet, apiSend } from './helpers';

/**
 * THE OPTIONAL FIELDS THE OTHER SUITES DID NOT REACH: the campaign builder's audience filters, and
 * the CRM Settings forms.
 *
 * ================================================================================================
 * WHY THESE PARTICULAR FIELDS. The Leads editor got all twenty of its fields checked because a
 * whitelist validator drops a forgotten field in silence. The same risk applies here, and in the
 * campaign builder it is worse than cosmetic:
 *
 *   AN AUDIENCE FILTER THAT SILENTLY FAILS TO PERSIST DOES NOT ERROR — IT WIDENS THE SEND. The
 *   builder shows a recipient count from a live preview, so the number on screen is right; if the
 *   filter is then dropped on the way to the campaign row, the send resolves against a broader
 *   audience than the person chose. Nothing looks wrong at any point.
 *
 * So each filter is set individually and read back from the stored campaign, not from the preview
 * that produced the count.
 *
 * THE SETTINGS FIELDS are a smaller risk and a more annoying one: a signature that does not save is
 * discovered by the customer who receives an email without it.
 * ================================================================================================
 *
 * NOTHING HERE CHANGES A SIGN-IN CREDENTIAL. The suite authenticates by email, so a test that edits
 * `crm-email` and then fails before restoring it would lock every later test out of that account.
 * The email field is therefore checked by REFUSING a malformed value rather than by changing a good
 * one — which is the assertion worth having anyway.
 */

const unique = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const createdCampaigns: number[] = [];
const createdLeads: number[] = [];

test.afterAll(async ({ browser }) => {
  if (!createdCampaigns.length && !createdLeads.length) return;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await signIn(page, 'agent');
    for (const id of createdCampaigns) await apiSend(page, 'DELETE', `/api/campaigns/${id}`);
    for (const id of createdLeads) await apiSend(page, 'DELETE', `/api/leads/${id}`);
  } finally { await ctx.close(); }
});

// ================================================================ campaign audience filters

const builder = (page: Page) => page.locator('.modal').filter({ hasText: 'Create Campaign' }).first();

async function openBuilder(page: Page) {
  await page.goto('/crm/campaigns');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: '+ Create Campaign' }).first().click();
  await expect(builder(page)).toBeVisible();
}

/**
 * The `<select>` for a given filter label inside the builder.
 *
 * THE SELECT IS INSIDE ITS LABEL — `<label class="report-field"><span>Status</span><select>…</select>`
 * — not a sibling of it. `following-sibling::select` matched nothing, so every filter looked like it
 * offered no options and the test skipped all five while appearing to have run them. A skip that
 * reads as a pass is the worst outcome available here, which is why the assertion at the end fails
 * when everything was skipped rather than quietly succeeding.
 */
function filterSelect(page: Page, label: string): Locator {
  /*
   * ANCHORED ON THE SPAN, NOT THE LABEL. `hasText` tests an element's ENTIRE text, and the label
   * contains the select — so its text is "Status Any hot warm cold …" and `^Status$` never matched.
   * The span holds the label alone, which is the only part that identifies the field.
   */
  return builder(page).locator('label.report-field')
    .filter({ has: page.locator('span').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }) })
    .locator('select').first();
}

/**
 * Pick a real option, taken from the DOM so the test does not pin a configurable vocabulary.
 *
 * `'any'` is the builder's own sentinel for "no filter". Choosing it would store nothing, and the
 * test would then assert that nothing was stored — which proves nothing at all.
 */
async function pickAny(select: Locator): Promise<string | null> {
  return pickKnown(select, null);
}

/** Prefer `wanted` when the dropdown offers it; otherwise fall back to the first real option. */
async function pickKnown(select: Locator, wanted: string | null): Promise<string | null> {
  const values = await select.locator('option').evaluateAll(
    (o) => o.map((x) => (x as HTMLOptionElement).value).filter((v) => v !== '' && v !== 'any' && v !== 'all'),
  );
  if (!values.length) return null;
  const match = wanted && values.find((v) => v.toLowerCase() === wanted.toLowerCase());
  const chosen = match || values[0];
  await select.selectOption(chosen);
  return chosen;
}

/**
 * The five audience filters, with the key each is stored under in the campaign's `audience` JSON.
 * The label is what the builder renders; the key is what `AudienceFilter` calls it.
 */
const AUDIENCE_FILTERS = [
  { label: 'Status', key: 'leadStatus', leadField: 'lead_status' },
  { label: 'Lead type', key: 'leadType', leadField: 'lead_type' },
  { label: 'Source', key: 'leadSource', leadField: 'lead_source' },
  { label: 'Client type', key: 'clientType', leadField: 'client_type' },
  { label: 'Tag', key: 'tag', leadField: 'tags' },
] as const;

/**
 * A lead carrying a known value in every filterable field, created by this test.
 *
 * ================================================================================================
 * WHY A FIXTURE RATHER THAN THE SEEDED BOOK. The agent's twenty-five seeded leads have EMPTY
 * `lead_status`, `lead_type`, `lead_source` and `client_type` — measured, not assumed. So every
 * filter value in the dropdowns matched nobody, the commit button stayed disabled, and all five
 * filters were skipped while the run still reported green. Choosing a value out of the agent's own
 * book did not help either: there was no value to choose.
 *
 * Creating one lead that carries the exact vocabulary the dropdowns offer makes each filter
 * REACHABLE, which is the only way the assertion means anything. The vocabulary itself still comes
 * from the DOM, so the test does not pin values a brokerage may edit.
 * ================================================================================================
 */
async function seedFilterableLead(page: Page, values: Record<string, string>): Promise<number> {
  const res = await apiSend(page, 'POST', '/api/leads', {
    name: unique('AudienceFixture'),
    email: `${unique('audience')}@example.test`,
    phone: '4165550000',
    ...values,
  });
  expect([200, 201]).toContain(res.status);
  const id = (res.body as { id: number }).id;
  createdLeads.push(id);
  return id;
}

/** The first real option each filter offers, read from the builder itself. */
async function vocabularyFromBuilder(page: Page): Promise<Record<string, string>> {
  await openBuilder(page);
  const out: Record<string, string> = {};
  for (const f of AUDIENCE_FILTERS) {
    const values = await filterSelect(page, f.label).locator('option').evaluateAll(
      (o) => o.map((x) => (x as HTMLOptionElement).value).filter((v) => v !== '' && v !== 'any' && v !== 'all'),
    );
    if (values.length) out[f.leadField] = values[0];
  }
  await builder(page).getByRole('button', { name: 'Cancel' }).first().click();
  return out;
}

test.describe('every campaign audience filter reaches the stored campaign', () => {
  test('each filter, set on its own, is persisted under its own key', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page, 'agent');

    // One lead carrying every filterable value the dropdowns offer, so each filter can match it.
    const vocab = await vocabularyFromBuilder(page);
    await seedFilterableLead(page, vocab);

    const missing: string[] = [];
    const skipped: string[] = [];

    for (const f of AUDIENCE_FILTERS) {
      await openBuilder(page);
      const name = unique(`Filter-${f.key}`);

      await builder(page).locator('input').first().fill(name);
      const template = builder(page).locator('select').filter({ hasText: 'Choose a template to send' }).first();
      const templates = await template.locator('option').evaluateAll(
        (o) => o.map((x) => (x as HTMLOptionElement).value).filter((v) => v !== ''),
      );
      expect(templates.length, 'a campaign template is needed for this suite').toBeGreaterThan(0);
      await template.selectOption(templates[0]);

      const chosen = await pickKnown(filterSelect(page, f.label), vocab[f.leadField] ?? null);
      if (chosen === null) {
        // A vocabulary with nothing in it on this deployment. Recorded rather than silently passed.
        skipped.push(f.key);
        await builder(page).getByRole('button', { name: 'Cancel' }).first().click();
        continue;
      }

      /*
       * WAIT FOR THE AUDIENCE TO RESOLVE BEFORE JUDGING IT. The recipient count is fetched when the
       * segment changes, so reading the commit button the instant after a filter is chosen reads the
       * PREVIOUS state — every filter then looked like it matched nobody and was skipped. The count
       * is polled to a settled value first; only then is "matches nobody" a real answer.
       */
      const commit = builder(page).getByRole('button', { name: /^(Send to|Schedule for)\s+\d+/ });
      await expect.poll(async () => {
        const txt = await builder(page).locator('.camp-audience').innerText();
        return Number(/(\d+)\s+recipient/.exec(txt)?.[1] ?? -1);
      }, { timeout: 15_000 }).toBeGreaterThanOrEqual(0);

      if (await commit.isDisabled()) {
        skipped.push(`${f.key} (no recipients match)`);
        await builder(page).getByRole('button', { name: 'Cancel' }).first().click();
        continue;
      }

      // Scheduled, so nothing is delivered.
      await builder(page).locator('input[type="radio"]').nth(1).check();
      await builder(page).locator('input[type="datetime-local"]')
        .fill(new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 16));
      await commit.click();
      /*
       * THE COMMIT BUTTON OPENS A CONFIRMATION NOW, for a scheduled send as well as an immediate
       * one — see CRM-030. Without this the builder is still on screen behind the dialog and the
       * wait below times out, which is what this test did until it was re-run against that change.
       */
      // This suite schedules, so the dialog reads "Schedule this campaign?" / "Confirm schedule";
      // an immediate send says "Send this campaign?" / "Confirm Send". Both are matched.
      await page.locator('.modal').filter({ hasText: /(Send|Schedule) this campaign\?/ })
        .getByRole('button', { name: /^Confirm (Send|schedule)$/ }).click();
      await expect(builder(page)).toBeHidden({ timeout: 30_000 });

      const list = await apiGet(page, '/api/campaigns');
      const rows = (Array.isArray(list.body) ? list.body : (list.body as { data?: unknown[] }).data ?? []) as
        { id: number; name: string }[];
      const row = rows.find((c) => c.name === name);
      expect(row, `campaign for ${f.key} should exist`).toBeTruthy();
      createdCampaigns.push(row!.id);

      // Read the STORED audience, not the preview that produced the count.
      const detail = await apiGet(page, `/api/campaigns/${row!.id}`);
      const audience = (detail.body as { audience?: Record<string, unknown> }).audience ?? {};
      if (String(audience[f.key] ?? '') !== chosen) {
        missing.push(`${f.key}: chose "${chosen}", stored "${String(audience[f.key] ?? '')}"`);
      }
    }

    // Every filter that could be exercised must have persisted. Skips are reported, not hidden.
    expect(missing, 'audience filters that did not reach the stored campaign').toEqual([]);
    expect(skipped.length, `skipped (no options or no matching recipients): ${skipped.join(', ')}`)
      .toBeLessThan(AUDIENCE_FILTERS.length);
  });

  test('two filters together are both stored, and neither overwrites the other', async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, 'agent');
    await openBuilder(page);

    const name = unique('TwoFilters');
    await builder(page).locator('input').first().fill(name);
    const template = builder(page).locator('select').filter({ hasText: 'Choose a template to send' }).first();
    const templates = await template.locator('option').evaluateAll(
      (o) => o.map((x) => (x as HTMLOptionElement).value).filter((v) => v !== ''),
    );
    await template.selectOption(templates[0]);

    const a = await pickAny(filterSelect(page, 'Status'));
    const b = await pickAny(filterSelect(page, 'Source'));
    test.skip(a === null || b === null, 'this deployment has no options for both filters');

    const commit = builder(page).getByRole('button', { name: /^(Send to|Schedule for)\s+\d+/ });
    await expect.poll(async () => {
      const txt = await builder(page).locator('.camp-audience').innerText();
      return Number(/(\d+)\s+recipient/.exec(txt)?.[1] ?? -1);
    }, { timeout: 15_000 }).toBeGreaterThanOrEqual(0);
    test.skip(await commit.isDisabled(), 'no recipients match both filters');

    await builder(page).locator('input[type="radio"]').nth(1).check();
    await builder(page).locator('input[type="datetime-local"]')
      .fill(new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 16));
    await commit.click();
    // Same confirmation step as above — see CRM-030.
    await page.locator('.modal').filter({ hasText: /(Send|Schedule) this campaign\?/ })
      .getByRole('button', { name: /^Confirm (Send|schedule)$/ }).click();
    await expect(builder(page)).toBeHidden({ timeout: 30_000 });

    const list = await apiGet(page, '/api/campaigns');
    const rows = (Array.isArray(list.body) ? list.body : (list.body as { data?: unknown[] }).data ?? []) as
      { id: number; name: string }[];
    const row = rows.find((c) => c.name === name)!;
    createdCampaigns.push(row.id);

    const detail = await apiGet(page, `/api/campaigns/${row.id}`);
    const audience = (detail.body as { audience?: Record<string, unknown> }).audience ?? {};
    expect(String(audience.leadStatus ?? '')).toBe(a);
    expect(String(audience.leadSource ?? '')).toBe(b);
  });
});

// ================================================================ CRM settings fields

const CRM_SETTINGS = '/crm/settings?tab=crm';

test.describe('every CRM Settings field saves, reloads and clears', () => {
  /**
   * Signature and reply template: free text, optional, and the two whose failure is discovered by a
   * customer rather than by us. Set, saved, reloaded, then CLEARED — clearing is the half that
   * breaks, because `if (value)` accepts a change and ignores a deletion.
   */
  test('signature and reply template save, survive a reload, and can be emptied again', async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, 'superAdmin');
    await page.goto(CRM_SETTINGS);
    await page.waitForLoadState('networkidle');

    const sig = page.locator('#crm-signature');
    const reply = page.locator('#crm-reply-template');
    await expect(sig).toBeVisible();

    const originalSig = await sig.inputValue();
    const originalReply = await reply.inputValue();
    const nextSig = `Sig ${unique('s')}`;
    const nextReply = `Reply ${unique('r')}`;

    try {
      await sig.fill(nextSig);
      await reply.fill(nextReply);
      await page.getByRole('button', { name: /Save Email Preferences/ }).click();
      await page.waitForTimeout(1200);

      await page.reload();
      await page.waitForLoadState('networkidle');
      await expect(page.locator('#crm-signature')).toHaveValue(nextSig);
      await expect(page.locator('#crm-reply-template')).toHaveValue(nextReply);

      // Now empty both. They must actually become empty rather than keeping the old text.
      await page.locator('#crm-signature').fill('');
      await page.locator('#crm-reply-template').fill('');
      await page.getByRole('button', { name: /Save Email Preferences/ }).click();
      await page.waitForTimeout(1200);

      await page.reload();
      await page.waitForLoadState('networkidle');
      await expect(page.locator('#crm-signature')).toHaveValue('');
      await expect(page.locator('#crm-reply-template')).toHaveValue('');
    } finally {
      await page.goto(CRM_SETTINGS);
      await page.waitForLoadState('networkidle');
      await page.locator('#crm-signature').fill(originalSig);
      await page.locator('#crm-reply-template').fill(originalReply);
      await page.getByRole('button', { name: /Save Email Preferences/ }).click();
      await page.waitForTimeout(1000);
    }
  });

  test('the username field saves and survives a reload', async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, 'superAdmin');
    await page.goto(CRM_SETTINGS);
    await page.waitForLoadState('networkidle');

    const username = page.locator('#crm-username');
    const original = await username.inputValue();
    const next = `sam-${Date.now()}`;

    try {
      await username.fill(next);
      await page.getByRole('button', { name: /Save Personal Information/ }).click();
      await page.waitForTimeout(1200);

      await page.reload();
      await page.waitForLoadState('networkidle');
      await expect(page.locator('#crm-username')).toHaveValue(next);
    } finally {
      /*
       * Restored even if the assertion failed. Sign-in uses the EMAIL, so a stranded username does
       * not lock anybody out — but leaving one behind would make the next run's "original" value a
       * previous run's litter.
       */
      await page.goto(CRM_SETTINGS);
      await page.waitForLoadState('networkidle');
      await page.locator('#crm-username').fill(original);
      await page.getByRole('button', { name: /Save Personal Information/ }).click();
      await page.waitForTimeout(1000);
    }
  });

  /**
   * The email field is checked by REFUSING a bad value rather than by changing a good one — the
   * suite signs in by email, so a test that stranded a broken address would lock every later test
   * out of this account. Refusing malformed input is the more valuable assertion regardless.
   */
  test('a malformed email address is refused and nothing is saved', async ({ page }) => {
    await signIn(page, 'superAdmin');
    await page.goto(CRM_SETTINGS);
    await page.waitForLoadState('networkidle');

    const email = page.locator('#crm-email');
    const original = await email.inputValue();
    expect(original).toContain('@');

    await email.fill('not-an-address');
    await page.getByRole('button', { name: /Save Personal Information/ }).click();
    await page.waitForTimeout(1000);

    // Whatever the screen shows, the stored address is untouched.
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#crm-email')).toHaveValue(original);
  });

  test('a required field cannot be emptied — the old value comes back after a reload', async ({ page }) => {
    await signIn(page, 'superAdmin');
    await page.goto(CRM_SETTINGS);
    await page.waitForLoadState('networkidle');

    const username = page.locator('#crm-username');
    const original = await username.inputValue();

    await username.fill('');
    await page.getByRole('button', { name: /Save Personal Information/ }).click();
    await page.waitForTimeout(1000);

    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#crm-username')).toHaveValue(original);
  });

  test('an agent cannot edit the brokerage-level email preferences', async ({ page }) => {
    await signIn(page, 'agent');
    // The CRM Settings tab is gated on `settings`, which an agent does not hold.
    expect((await apiGet(page, '/api/crm-settings')).status).toBe(403);
  });
});
