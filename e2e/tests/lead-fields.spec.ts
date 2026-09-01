import { test, expect, type Page, type Locator } from '@playwright/test';
import { signIn, apiGet, apiSend } from './helpers';

/**
 * EVERY FIELD IN THE LEAD EDITOR: typed in, saved, reloaded, read back, cleared.
 *
 * ================================================================================================
 * WHY FIELD-BY-FIELD IS WORTH ITS OWN FILE. The other Lead suites prove the FORM works — required
 * fields, validation, the save round trip. What they do not prove is that each of the twenty
 * individual fields survives the journey, and that is a different question with a different failure
 * mode: one field missing from a `select` clause, one name misspelled between the client payload and
 * the validator's allow-list, and that field silently never saves. Nothing errors. The form closes,
 * the toast says saved, and the value is gone on the next open.
 *
 * A whitelist-based validator — which this one is, deliberately — makes that failure MORE likely,
 * not less: a field the allow-list forgets is dropped in silence rather than rejected.
 *
 * THREE PHASES, because they fail independently:
 *
 *   1. WRITE      fill every field through the real form and save
 *   2. READ BACK  reload the page, reopen the editor, and assert each field shows what was typed
 *                 — this is the UI round trip, and it catches a value that saved but never renders
 *   3. PERSIST    assert the same values through the API, which is the database's answer rather
 *                 than the client's — a field held only in React state passes phase 2 and fails here
 *   4. CLEAR      empty every optional field, save, reload, and assert they are actually EMPTY.
 *                 Clearing is the half that breaks: `if (value) out.field = value` saves a change
 *                 and silently ignores a deletion, so the old value stays for ever.
 * ================================================================================================
 */

const unique = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const created: number[] = [];

test.afterAll(async ({ browser }) => {
  if (!created.length) return;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await signIn(page, 'agent');
    for (const id of created) await apiSend(page, 'DELETE', `/api/leads/${id}`);
  } finally { await ctx.close(); }
});

/**
 * The `.field` block whose LABEL is exactly this text.
 *
 * EXACT, VIA A REGEX, AND THAT IS NOT PEDANTRY. Playwright's `hasText` is case-INSENSITIVE and
 * matches substrings, so `hasText: 'Age'` also matched the *Language* field — whose control is a
 * `<select>`, not an input — and `fill()` sat there until it timed out. Anchoring on the label
 * element with `^…$` is what makes each of the twenty fields address exactly one control.
 */
const field = (page: Page, label: string): Locator =>
  page.locator('.modal').first().locator('.field').filter({
    has: page.locator('label').filter({ hasText: exactly(label) }),
  }).first();

/** `^label$`, with the regex metacharacters in the label escaped. */
function exactly(label: string): RegExp {
  return new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
}

async function openAddLead(page: Page) {
  await page.goto('/crm/lead');
  await page.getByRole('button', { name: '+ Add Lead' }).click();
  await expect(page.getByText('Add New Lead')).toBeVisible();
}

/** Reopen a saved lead's editor from its detail page. */
async function openExisting(page: Page, id: number) {
  await page.goto(`/crm/lead/${id}`);
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Edit Lead' }).click();
  await expect(page.locator('.modal').first()).toBeVisible();
}

/**
 * Choose a real option from a `select`, taken from the DOM rather than hard-coded.
 *
 * The vocabularies (lead status, source, gender, language, religion…) are configurable and are
 * loaded from `/api/leads/options`. Pinning literals here would make this file fail whenever the
 * brokerage edits a dropdown, which is a false alarm about the wrong thing.
 */
async function pickOption(select: Locator): Promise<string> {
  const values = await select.locator('option').evaluateAll(
    (opts) => opts.map((o) => (o as HTMLOptionElement).value).filter((v) => v !== ''),
  );
  if (!values.length) throw new Error('a select offered no values — the options endpoint may have failed');
  const chosen = values[values.length - 1];
  await select.selectOption(chosen);
  return chosen;
}

/**
 * The age the birthday below implies today.
 *
 * Computed rather than written down, so this fixture cannot expire again the way the hard-coded 43
 * did on 17 April 2026. Mirrors `ageFromDateOfBirth` on the server: UTC, and one fewer completed
 * year when this year's birthday has not arrived yet.
 */
const DOB = '1982-04-17';
function ageOnRecord(now: Date = new Date()): number {
  const d = new Date(`${DOB}T00:00:00.000Z`);
  const years = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  const day = now.getUTCDate() - d.getUTCDate();
  return m < 0 || (m === 0 && day < 0) ? years - 1 : years;
}

/** Text and date fields, with the value each is given. Optional ones are cleared in phase 4. */
const TEXT_FIELDS: {
  label: string; value: string; api: string; optional: boolean;
  /** Read back as a value computed from another field rather than as what was typed. */
  derivedFromDob?: boolean;
}[] = [
  { label: 'Phone', value: '416-555-8899', api: 'phone', optional: true },
  { label: 'Location', value: 'Etobicoke', api: 'location', optional: true },
  { label: 'Property of Interest', value: 'Semi-detached', api: 'property', optional: true },
  /*
   * AGE IS DERIVED FROM THE BIRTHDAY, so it is not asserted as a typed value.
   *
   * This paired a hard-coded `43` with a date of birth of 1982-04-17, and the API returns the age
   * DERIVED from that birthday whenever one is on file — see `present` — so the pair stopped
   * agreeing on 17 April 2026 and this test has been failing ever since. A fixture whose
   * correctness expires on a particular date is a time bomb, not a fixture.
   *
   * The field is still typed and still cleared in phase 4; what it is checked against now comes
   * from the birthday, below, so it cannot go stale again. This is the same confusion CRM-034 was
   * about: a stored age beside a date of birth, where only one of them is what anybody sees.
   */
  { label: 'Age', value: '43', api: 'age', optional: true, derivedFromDob: true },
  { label: 'Date of Birth', value: '1982-04-17', api: 'date_of_birth', optional: true },
  { label: 'Marriage Day', value: '2010-09-02', api: 'marriage_day', optional: true },
];

const SELECT_FIELDS: { label: string; api: string }[] = [
  { label: 'Lead Status', api: 'lead_status' },
  { label: 'Lead Type', api: 'lead_type' },
  { label: 'Lead Source', api: 'lead_source' },
  { label: 'Lead Response', api: 'lead_response' },
  { label: 'Client Type', api: 'client_type' },
  { label: 'Conversion', api: 'lead_conversion' },
  { label: 'Gender', api: 'gender' },
  { label: 'Language', api: 'language' },
  { label: 'Religion', api: 'religion' },
];

test.describe('every lead field survives save, reload and read-back', () => {
  test('writes all twenty fields, reads them back, and persists them to the database', async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, 'agent');
    await openAddLead(page);

    const name = unique('AllFields');
    const email = `${unique('fields')}@example.test`;
    const expected: Record<string, string> = {};

    // ---------------------------------------------------------------- 1. write
    await field(page, 'Name *').locator('input').first().fill(name);
    await field(page, 'Email *').locator('input').first().fill(email);
    for (const f of TEXT_FIELDS) {
      await field(page, f.label).locator('input').first().fill(f.value);
      // A derived field is read back as what the birthday implies TODAY, not as what was typed.
      expected[f.api] = f.derivedFromDob ? String(ageOnRecord()) : f.value;
    }
    for (const f of SELECT_FIELDS) {
      const select = field(page, f.label).locator('select').first();
      expected[f.api] = await pickOption(select);
    }
    await field(page, 'Tags').locator('input').first().fill('VIP, Expo-2026');

    await page.getByRole('button', { name: 'Create Lead' }).click();
    await expect(page.getByText('Add New Lead')).toBeHidden({ timeout: 20_000 });

    // ---------------------------------------------------------------- 3. persist (API first)
    const found = await apiGet(page, `/api/leads?search=${encodeURIComponent(name)}`);
    const row = (found.body as { data?: Record<string, unknown>[] }).data?.[0];
    expect(row, 'the lead should be findable after saving').toBeTruthy();
    const id = row!.id as number;
    created.push(id);

    const detail = await apiGet(page, `/api/leads/${id}`);
    const saved = detail.body as Record<string, unknown>;

    const wrong: string[] = [];
    for (const [key, want] of Object.entries(expected)) {
      const got = saved[key];
      const gotStr = got === null || got === undefined ? '' : String(got);
      // Dates come back as ISO timestamps; compare the day only.
      const ok = key.includes('date') || key === 'marriage_day'
        ? gotStr.slice(0, 10) === want
        : gotStr === want;
      if (!ok) wrong.push(`${key}: expected "${want}", got "${gotStr}"`);
    }
    expect(wrong, 'fields that did not persist to the database').toEqual([]);

    // ---------------------------------------------------------------- 2. read back through the UI
    await openExisting(page, id);
    const notShown: string[] = [];
    for (const f of TEXT_FIELDS) {
      const actual = await field(page, f.label).locator('input').first().inputValue();
      const want = f.derivedFromDob ? String(ageOnRecord()) : f.value;
      if (actual.slice(0, want.length) !== want) notShown.push(`${f.label}: shows "${actual}", saved "${want}"`);
    }
    for (const f of SELECT_FIELDS) {
      const actual = await field(page, f.label).locator('select').first().inputValue();
      if (actual !== expected[f.api]) notShown.push(`${f.label}: shows "${actual}", saved "${expected[f.api]}"`);
    }
    expect(notShown, 'fields that saved but do not render on reopen').toEqual([]);
  });

  /**
   * CLEARING IS THE HALF THAT BREAKS. A validator written as `if (value) out.field = value` accepts
   * a change and silently drops a deletion — so the old value survives every attempt to remove it,
   * and the only symptom is a customer's date of birth that will not go away.
   */
  test('clearing an optional field actually empties it, rather than keeping the old value', async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, 'agent');
    await openAddLead(page);

    const name = unique('Clearable');
    await field(page, 'Name *').locator('input').first().fill(name);
    await field(page, 'Email *').locator('input').first().fill(`${unique('clear')}@example.test`);
    for (const f of TEXT_FIELDS) await field(page, f.label).locator('input').first().fill(f.value);

    await page.getByRole('button', { name: 'Create Lead' }).click();
    await expect(page.getByText('Add New Lead')).toBeHidden({ timeout: 20_000 });

    const found = await apiGet(page, `/api/leads?search=${encodeURIComponent(name)}`);
    const id = (found.body as { data?: { id: number }[] }).data![0].id;
    created.push(id);

    // Now empty every optional field and save again.
    await openExisting(page, id);
    for (const f of TEXT_FIELDS) await field(page, f.label).locator('input').first().fill('');
    await page.getByRole('button', { name: /Update Lead/ }).click();
    await expect(page.locator('.modal').first()).toBeHidden({ timeout: 20_000 });

    const after = await apiGet(page, `/api/leads/${id}`);
    const saved = after.body as Record<string, unknown>;

    const stuck: string[] = [];
    for (const f of TEXT_FIELDS) {
      const got = saved[f.api];
      const empty = got === null || got === undefined || String(got) === '';
      if (!empty) stuck.push(`${f.api} still holds "${String(got)}"`);
    }
    expect(stuck, 'optional fields that could not be cleared').toEqual([]);

    // And the UI agrees after a reload — not just the API.
    await openExisting(page, id);
    for (const f of TEXT_FIELDS) {
      await expect(field(page, f.label).locator('input').first()).toHaveValue('');
    }
  });

  /**
   * THE IDENTITY LOCK NOW MATCHES THE SERVER, ON BOTH SCREENS.
   *
   * This test previously recorded a divergence, and the divergence I first reported was not the one
   * that existed. The Leads list and the detail page used the SAME predicate as each other — the
   * list's helper is called `isBrokerageLead` but its body reads
   * `role === 'agent' && owner != null && owner !== me`, which is not what the name suggests. Both
   * screens agreed, and both disagreed with `LeadsService.isBrokerageAssigned`:
   *
   *   `owner != null` exempted the BROKERAGE's own leads, whose owner is null — so an agent working
   *   a lead the brokerage handed them was offered the email field and then refused on save.
   *   `role === 'agent'` exempted crm, accounting and documentation, three roles that sit below
   *   manager and that the server locks.
   *
   * Both screens now call `identityLocked`, which asks the server's question: may this person
   * rewrite identity at all (`is_admin_or_above`), and is this lead theirs?
   */
  test('an agent working a brokerage lead sees the identity fields locked on BOTH screens', async ({ page, browser }) => {
    const adminCtx = await browser.newContext();
    const admin = await adminCtx.newPage();
    try {
      await signIn(admin, 'superAdmin');
      const name = unique('Assigned');
      const res = await apiSend(admin, 'POST', '/api/leads', {
        name, email: `${unique('assigned')}@example.test`, phone: '4165550000',
      });
      const id = (res.body as { id: number }).id;
      created.push(id);

      const users = await apiGet(admin, '/api/users');
      const rows = (Array.isArray(users.body) ? users.body : []) as { id: number; email: string }[];
      const agentId = rows.find((u) => String(u.email).startsWith('agent@'))!.id;
      await apiSend(admin, 'PUT', `/api/leads/${id}`, { assigned_to: agentId });

      await signIn(page, 'agent');

      // The DETAIL page locks it.
      await page.goto(`/crm/lead/${id}`);
      await page.waitForLoadState('networkidle');
      await page.getByRole('button', { name: 'Edit Lead' }).click();
      await expect(page.locator('.modal').first()).toBeVisible();
      await expect(page.getByText(/The brokerage assigned this lead to you/i)).toBeVisible();
      await page.locator('.modal').first().getByRole('button', { name: 'Close' }).click();

      // And so does the LIST, which opens the same modal from the other screen. Both paths are
      // checked because the divergence this replaced was invisible from either one alone.
      await page.goto(`/crm/lead?search=${encodeURIComponent(name)}`);
      await page.waitForLoadState('networkidle');
      await page.locator('tbody tr').first().getByRole('button', { name: 'Edit' }).click();
      await expect(page.locator('.modal').first()).toBeVisible();
      await expect(page.getByText(/The brokerage assigned this lead to you/i)).toBeVisible();

      /*
       * THE BOUNDARY THAT ACTUALLY HOLDS. Whatever the screen offers, the API refuses to let an
       * agent rewrite the identity of a lead they do not own. If this ever starts succeeding, the
       * inconsistency above has stopped being cosmetic and has become a real hole.
       */
      const attempt = await apiSend(page, 'PUT', `/api/leads/${id}`, {
        name, email: `hijacked-${unique('x')}@example.test`,
      });
      expect([400, 403, 422]).toContain(attempt.status);

      const after = await apiGet(admin, `/api/leads/${id}`);
      expect((after.body as { email: string }).email).not.toContain('hijacked');
    } finally {
      await adminCtx.close();
    }
  });
});
