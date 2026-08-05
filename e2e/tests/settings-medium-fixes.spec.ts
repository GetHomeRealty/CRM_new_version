import { test, expect } from '@playwright/test';
import { signIn, apiGet, apiSend } from './helpers';

/**
 * CRM › Settings — the Medium band of the 2026-08-04 audit.
 *
 * Same convention as `settings-high-fixes.spec.ts`: each case is written as the failure it caught,
 * with the measured numbers in the comment, so a regression is recognisable rather than merely red.
 */

const AGENT_OWNED_LEAD = 'marcus.bell@example.test';

/**
 * Restore whatever a case changed, so ordering never decides an outcome.
 *
 * The restore names the fields it puts back rather than echoing the whole loaded row. Echoing
 * everything is what the SCREEN does, and it is fine there — but a test that does it will also put
 * back whatever the previous case left behind, which is how a 5,000-character note from the length
 * case ended up failing an unrelated concurrency case.
 */
const RESTORABLE = [
  'name', 'address', 'phone', 'email', 'hst_number', 'bank_beneficiary', 'bank_name', 'transit_no',
  'account_no', 'institution_no', 'currency', 'default_tax_rate', 'invoice_prefix',
  'next_invoice_no', 'default_terms', 'thank_you_note', 'deposit_heading',
] as const;

async function withCompanySettings(page: any, fn: (before: Record<string, unknown>) => Promise<void>) {
  const before = (await apiGet(page, '/api/company-settings')).body as Record<string, unknown>;
  try {
    await fn(before);
  } finally {
    const restore: Record<string, unknown> = {};
    for (const k of RESTORABLE) if (k in before) restore[k] = before[k];
    await apiSend(page, 'PUT', '/api/company-settings', restore);
  }
}

// ---------------------------------------------------------------- M1 / M2 / M3
test.describe('M1–M3 — the inert controls are gone from the screen', () => {
  /*
   * Fourteen controls on this screen were saved, acknowledged, and read by nothing: five
   * Preferences (theme saved as `dark`, page stayed light — no `data-theme`, no stylesheet
   * consulting it), six Notification switches (while a working notification screen exists two menu
   * items away), the auto-responder and the forwarding address.
   */
  test('Preferences, Notification Settings, auto-responder and forwarding address are not offered', async ({ page }) => {
    await signIn(page, 'superAdmin');
    await page.goto('/crm/settings?tab=crm');
    await expect(page.getByRole('heading', { name: 'Email Campaigns' })).toBeVisible();

    for (const gone of ['Save Preferences', 'Save Notification Settings']) {
      await expect(page.getByRole('button', { name: gone })).toHaveCount(0);
    }
    for (const gone of ['Time Zone', 'Date Format', 'Auto-responder Message', 'Forwarding Address', 'Market Updates']) {
      await expect(page.getByText(gone, { exact: true })).toHaveCount(0);
    }
    // The one field in that card that DOES something is still there.
    await expect(page.getByLabel('Signature')).toBeVisible();
  });

  test('the screen points at the notification preferences that do work', async ({ page }) => {
    // The harm was never the wasted pixels — it was that somebody muted an alert here, kept
    // receiving it, and had no reason to look for the real screen.
    await signIn(page, 'superAdmin');
    await page.goto('/crm/settings?tab=crm');
    const link = page.getByRole('link', { name: /Notification Preferences/i });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', /notifications/);
  });

  test('the API still round-trips the stored values, so nothing was destroyed', async ({ page }) => {
    // Removed from the screen, not from the record: the columns are untouched and can be dropped
    // with a migration when one is due.
    await signIn(page, 'superAdmin');
    const res = await apiGet(page, '/api/crm-settings');
    expect((res.body as any)?.preferences).toBeTruthy();
    expect((res.body as any)?.notifications).toBeTruthy();
  });
});

// ---------------------------------------------------------------- M4
test('M4 — over-length SMTP fields are refused, not crashed on', async ({ page }) => {
  // Measured: 400 characters into smtpHost or smtpUser, and a 306-character adminEmail (which
  // passes the email shape and fails the VarChar(255) column), each returned a bare
  // 500 "Internal server error" from a form an administrator types into.
  await signIn(page, 'superAdmin');
  for (const [field, value] of [
    ['smtpHost', 'h'.repeat(400)],
    ['smtpUser', 'u'.repeat(400)],
    ['adminEmail', `${'a'.repeat(300)}@x.com`],
  ] as [string, string][]) {
    const res = await apiSend(page, 'PUT', '/api/crm-settings/email-settings', {
      [field]: value, smtpPort: '587', autoSendEnabled: true, emailTemplates: {},
    });
    expect(res.status, field).toBe(400);
    expect((res.body as any)?.errors?.[field], field).toBeTruthy();
  }
});

// ---------------------------------------------------------------- M5
test.describe('M5 — referral codes are real codes', () => {
  test('a code that was never issued is refused', async ({ page }) => {
    // Measured: `GHR-NEVERISSUED`, expired in 2020, carrying a 99% discount, was accepted and sent
    // over the brokerage's signature telling the recipient it was worth 99% off.
    await signIn(page, 'superAdmin');
    const res = await apiSend(page, 'POST', '/api/crm-settings/email-settings', {
      action: 'sendReferralEmail', leadName: 'Marcus', leadEmail: AGENT_OWNED_LEAD,
      referralCode: { code: 'GHR-NEVERISSUED', discount: 99, validUntil: '2020-01-01', usageCount: 0, maxUsage: 1 },
    });
    expect(res.status).toBe(400);
    expect(String((res.body as any)?.message)).toMatch(/has been issued/i);
  });

  test('sending an issued code records the use', async ({ page }) => {
    // `usage_count` was written once as 0 and incremented by nothing anywhere, so "Used 0 / 5" was
    // decorative and `max_usage` was unenforceable.
    await signIn(page, 'superAdmin');
    const gen = await apiSend(page, 'POST', '/api/crm-settings/email-settings', {
      action: 'generateReferralCode', discount: 15, validDays: 30, maxUsage: 3,
    });
    const code = (gen.body as any)?.data?.code as string;
    expect(code).toBeTruthy();

    const send = await apiSend(page, 'POST', '/api/crm-settings/email-settings', {
      action: 'sendReferralEmail', leadName: 'Marcus', leadEmail: AGENT_OWNED_LEAD,
      referralCode: { code },
    });

    const list = await apiGet(page, '/api/crm-settings/referral-codes');
    const row = ((list.body as any[]) ?? []).find((r) => r.code === code);
    expect(row, 'the generated code must be listed').toBeTruthy();
    // This environment has no reachable SMTP host, so the send fails at the mailer and the use is
    // correctly NOT counted — a code is spent when the email goes, not when it is attempted.
    const delivered = (send.body as any)?.success === true;
    expect(row.usageCount).toBe(delivered ? 1 : 0);
  });
});

// ---------------------------------------------------------------- M6
test('M6 — a broadcast interrupted by a restart is closed out, not left "sending" for ever', async ({ page }) => {
  /*
   * `deliverBroadcast` runs detached, so a deploy or a crash mid-loop left the row saying `sending`
   * with nothing alive to finish or correct it — six of eight rows in the QA database, the oldest
   * two days old. The Broadcasts list is the only place an administrator learns whether staff were
   * emailed, and for most rows it said "still going" indefinitely.
   *
   * The sweep runs at boot and only touches rows older than five minutes, so a send genuinely in
   * flight during a fast restart is not wrongly marked finished. This asserts the outcome that
   * matters: nothing OLD is still claiming to be in flight.
   */
  await signIn(page, 'superAdmin');
  const list = await apiGet(page, '/api/crm-settings/broadcasts?limit=100');
  const rows = ((list.body as any[]) ?? []);
  const stale = rows.filter((r) => r.status === 'sending'
    && Date.now() - new Date(r.created_at).getTime() > 10 * 60 * 1000);
  expect(stale.map((r) => r.id), 'no broadcast older than ten minutes may still read "sending"').toEqual([]);
});

// ---------------------------------------------------------------- M7
test('M7 — the same broadcast cannot be sent twice by accident', async ({ page }) => {
  // Two identical POSTs at the same moment both returned 201 and both fanned out to all seven
  // staff. The button's `disabled` guard covers a double click and nothing else — not a retry, not
  // a second tab, not an impatient reload — and there is no undo on a sent broadcast.
  await signIn(page, 'superAdmin');
  const message = `M7 duplicate guard ${Date.now()}`;
  const [a, b] = await Promise.all([
    apiSend(page, 'POST', '/api/crm-settings/broadcasts', { message, type: 'info' }),
    apiSend(page, 'POST', '/api/crm-settings/broadcasts', { message, type: 'info' }),
  ]);
  const statuses = [a.status, b.status].sort();
  expect(statuses, 'exactly one of the two must be accepted').toEqual([201, 400]);

  const refused = a.status === 400 ? a : b;
  expect(String((refused.body as any)?.message)).toMatch(/already sent/i);
});

test('M7 — the send is confirmed before it goes', async ({ page }) => {
  await signIn(page, 'superAdmin');
  await page.goto('/crm/settings?tab=crm');
  await page.getByLabel('Message', { exact: true }).fill('M7 confirmation probe — not sent');
  await page.getByRole('button', { name: 'Send to All Users' }).click();
  // Nothing has been sent yet: a dialog stands between the button and every inbox in the brokerage.
  await expect(page.getByText('Email everyone?')).toBeVisible();
  await expect(page.getByText('It cannot be recalled', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '✕' }).click();
  await expect(page.getByText('Email everyone?')).toHaveCount(0);
});

// ---------------------------------------------------------------- M8
test('M8 — a stale Company Settings save is refused instead of overwriting', async ({ page, browser }) => {
  // Two administrators holding the same loaded row both saved, both got 200, and the second
  // silently discarded the first's work with neither told.
  await signIn(page, 'superAdmin');
  await withCompanySettings(page, async (before) => {
    const stale = before.updated_at as string;

    const first = await apiSend(page, 'PUT', '/api/company-settings', {
      ...before, phone: '905-555-0001', expected_updated_at: stale,
    });
    expect(first.status).toBe(200);

    // The second editor is still holding the version from before that write.
    const ctx = await browser.newContext();
    const two = await ctx.newPage();
    await signIn(two, 'superAdmin');
    const second = await apiSend(two, 'PUT', '/api/company-settings', {
      ...before, phone: '905-555-0002', expected_updated_at: stale,
    });
    await ctx.close();

    expect(second.status, 'the stale save must be refused').toBe(409);
    expect(String((second.body as any)?.message)).toMatch(/changed by somebody else/i);

    const after = (await apiGet(page, '/api/company-settings')).body as Record<string, unknown>;
    expect(after.phone, 'the first writer’s value must survive').toBe('905-555-0001');
  });
});

test('M8 — a caller that sends no version is unaffected', async ({ page }) => {
  // This is the screen's protection, not a new requirement on the API.
  await signIn(page, 'superAdmin');
  await withCompanySettings(page, async (before) => {
    const res = await apiSend(page, 'PUT', '/api/company-settings', { ...before, phone: '905-555-0003' });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------- M9
test('M9 — the invoice counter cannot be rewound onto issued numbers, or overflowed', async ({ page }) => {
  // `next_invoice_no = 1` was accepted with 200, rewinding a live counter from 601107 onto six
  // hundred thousand already-issued numbers; 2147483648 overflowed the int4 column into a bare 500.
  await signIn(page, 'superAdmin');
  await withCompanySettings(page, async (before) => {
    const overflow = await apiSend(page, 'PUT', '/api/company-settings', {
      name: before.name, next_invoice_no: 2147483648,
    });
    expect(overflow.status, 'must be a validation error, not a crash').toBe(422);

    const rewind = await apiSend(page, 'PUT', '/api/company-settings', {
      name: before.name, next_invoice_no: 1,
    });
    // 409 when invoices exist to protect; 200 on a database with none issued under this prefix,
    // which is legitimate — there is nothing to re-issue. Never a 500, and never a silent rewind
    // past a real invoice.
    expect([200, 409]).toContain(rewind.status);
    if (rewind.status === 409) {
      expect(String((rewind.body as any)?.message)).toMatch(/already been issued/i);
    }

    // Advancing is always allowed.
    const forward = await apiSend(page, 'PUT', '/api/company-settings', {
      name: before.name, next_invoice_no: Number(before.next_invoice_no) + 10,
    });
    expect(forward.status).toBe(200);
  });
});

// ---------------------------------------------------------------- M10
test('M10 — the currency printed on invoices must be a currency', async ({ page }) => {
  // `@MaxLength(8)` and nothing else: BITCOIN!, 𝔘𝔫𝔦 and an empty string were all accepted with 200,
  // on the field printed on every Invoice, Deposit Receipt and commission statement — while the CRM
  // Settings currency *preference*, read by nothing, was correctly allow-listed.
  await signIn(page, 'superAdmin');
  await withCompanySettings(page, async (before) => {
    for (const bad of ['BITCOIN!', '𝔘𝔫𝔦', 'xx']) {
      const res = await apiSend(page, 'PUT', '/api/company-settings', { name: before.name, currency: bad });
      expect(res.status, `currency=${bad}`).toBe(422);
    }
    const ok = await apiSend(page, 'PUT', '/api/company-settings', { name: before.name, currency: 'USD' });
    expect(ok.status).toBe(200);
    expect((ok.body as any)?.currency).toBe('USD');
  });
});

test('M10 — the two free-text invoice notes are bounded', async ({ page }) => {
  // 100,000 characters were accepted with 200, against a field printed on an invoice.
  await signIn(page, 'superAdmin');
  await withCompanySettings(page, async (before) => {
    const res = await apiSend(page, 'PUT', '/api/company-settings', {
      name: before.name, thank_you_note: 'x'.repeat(5000),
    });
    expect(res.status).toBe(400);
    expect((res.body as any)?.errors?.thank_you_note).toBeTruthy();

    // …but an over-long value that is already stored must not block saving anything else. The
    // limit was a DTO rule to begin with, and that version bricked the whole form for any
    // deployment carrying a long note from before the field was bounded.
    const unchanged = await apiSend(page, 'PUT', '/api/company-settings', {
      name: before.name, thank_you_note: before.thank_you_note, phone: '905-555-0009',
    });
    expect(unchanged.status, 'echoing back an unchanged note must not fail the save').toBe(200);
  });
});

// ---------------------------------------------------------------- M11
test.describe('M11 — the brand logo has to be an image', () => {
  test.afterEach(async ({ page }) => {
    await signIn(page, 'superAdmin');
    await apiSend(page, 'DELETE', '/api/company-settings/logo');
  });

  test('bytes that are not the format the extension claims are refused', async ({ page }) => {
    // 22 bytes reading "MZ  not a PNG at all" were accepted, stored, and served back as image/png —
    // and that file is the letterhead of every Invoice, Deposit Receipt and Lawyer Statement.
    await signIn(page, 'superAdmin');
    const res = await apiSend(page, 'POST', '/api/company-settings/logo', {
      file_name: 'payload.png', content: Buffer.from('MZ  not a PNG at all').toString('base64'),
    });
    expect(res.status).toBe(400);
    expect(String((res.body as any)?.message)).toMatch(/not a valid PNG/i);
  });

  test('a real PNG is still accepted', async ({ page }) => {
    // The check must not reject the thing it exists to protect.
    await signIn(page, 'superAdmin');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const res = await apiSend(page, 'POST', '/api/company-settings/logo', {
      file_name: 'brand.png', content: png.toString('base64'),
    });
    expect(res.status).toBe(200);
    expect((res.body as any)?.logo_path).toMatch(/\.png$/);
  });

  test('an SVG is stored with its scripts stripped', async ({ page }) => {
    /*
     * The stored file carried <script> and onload= intact and was served from the API origin as
     * image/svg+xml. It did NOT execute — helmet sets script-src 'self'; script-src-attr 'none',
     * and Chromium refused it (verified 2026-08-04) — so this is defence in depth, not a live hole.
     * Stripping at upload means the bytes on disk are safe whatever serves them later.
     */
    await signIn(page, 'superAdmin');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40" onload="alert(1)">'
      + '<script>alert(document.domain)</script><text y="20">LOGO</text></svg>';
    const up = await apiSend(page, 'POST', '/api/company-settings/logo', {
      file_name: 'brand.svg', content: Buffer.from(svg).toString('base64'),
    });
    expect(up.status).toBe(200);

    const served = await page.request.get('http://localhost:8100/api/company-settings/logo');
    const body = await served.text();
    expect(body).not.toContain('<script');
    expect(body).not.toContain('onload');
    expect(body, 'the drawing itself must survive').toContain('LOGO');
  });
});

// ---------------------------------------------------------------- M12
test('M12 — every form control on the screen has a programmatic label', async ({ page }) => {
  // Measured: 26 of 41 controls had no label[for], no wrapping <label> and no aria-label, and the
  // whole 6,491-pixel screen exposed one heading — so a screen-reader user had neither field names
  // nor a way to move between sections.
  await signIn(page, 'superAdmin');
  await page.goto('/crm/settings?tab=crm');
  await expect(page.getByRole('heading', { name: 'Email Campaigns' })).toBeVisible();

  const audit = await page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll('.card input, .card textarea, .card select'));
    const unlabelled: string[] = [];
    for (const el of controls) {
      const id = el.getAttribute('id');
      const hasFor = id ? !!document.querySelector(`label[for="${CSS.escape(id)}"]`) : false;
      if (!hasFor && !el.closest('label') && !el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby')) {
        unlabelled.push(el.getAttribute('id') ?? (el as HTMLInputElement).name ?? el.tagName);
      }
    }
    return {
      total: controls.length,
      unlabelled,
      headings: Array.from(document.querySelectorAll('h1,h2,h3,h4')).length,
    };
  });

  expect(audit.unlabelled).toEqual([]);
  expect(audit.total, 'the screen must still have its controls').toBeGreaterThan(10);
  expect(audit.headings, 'each card needs a heading to navigate by').toBeGreaterThan(5);
});

// ---------------------------------------------------------------- M13
test('M13 — a withheld field is shown as withheld, not as blank and editable', async ({ page, browser }) => {
  /*
   * `GET /api/company-settings` correctly strips `hst_number` below rank `accounting` — and the
   * screen rendered the absent key as an ordinary empty, enabled input. It told that reader the
   * brokerage has no HST registration and offered them a box in which to type one they were never
   * allowed to see.
   */
  await signIn(page, 'superAdmin');
  const roles = await apiGet(page, '/api/roles');
  const crmRole = ((roles.body as any[]) ?? []).find((r) => r.key === 'crm');
  expect(crmRole).toBeTruthy();
  const original = { ...(crmRole.permissions as Record<string, string>) };
  const real = (await apiGet(page, '/api/company-settings')).body as Record<string, unknown>;

  await apiSend(page, 'PUT', `/api/roles/${crmRole.id}/permissions`, {
    permissions: { ...original, settings: 'edit' },
  });

  const ctx = await browser.newContext();
  try {
    const asCrm = await ctx.newPage();
    await signIn(asCrm, 'crm');
    await asCrm.goto('/crm/settings?tab=company');

    const hst = asCrm.getByLabel('HST / Tax Number');
    await expect(hst).toBeVisible();
    await expect(hst, 'a value you may not read is not a value you may overwrite').toBeDisabled();
    await expect(hst).toHaveAttribute('placeholder', /Hidden/i);
    await expect(asCrm.getByText('Withheld.', { exact: false })).toBeVisible();

    // Editable fields on the same card are still editable — this is one field, not a read-only page.
    await expect(asCrm.getByLabel('Company Name')).toBeEnabled();
  } finally {
    await ctx.close();
    await apiSend(page, 'PUT', `/api/roles/${crmRole.id}/permissions`, { permissions: original });
  }

  // And the stored value was never at risk.
  const after = (await apiGet(page, '/api/company-settings')).body as Record<string, unknown>;
  expect(after.hst_number).toBe(real.hst_number);
});
