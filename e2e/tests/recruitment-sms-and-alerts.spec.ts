import { test, expect, type Page } from '@playwright/test';
import { signIn, apiGet, apiSend } from './helpers';

/**
 * Recruitment texting consent, Send Mail and interview alerts, through a real browser.
 *
 * Send Mail replaced Send Text on the candidate page (2c210cc). The texting-consent controls are
 * unchanged and still covered here; the composer tests now cover Send Mail.
 *
 * ================================================================================================
 * NO REAL EMAIL CAN BE SENT FROM THIS FILE, and that is arranged rather than assumed.
 *
 * Every test that presses Send installs `interceptMail` first: the POST to the send endpoint is
 * answered inside the browser and never reaches the server, so the mailer and SMTP are never
 * involved. The composer's own GET and the server-built preview still go through for real, so what
 * the screen shows is what the server said.
 *
 * That is asserted rather than trusted. `expectNoEmail` checks afterwards that the candidate has no
 * `recruitment_emails` row at all — a real attempt, sent or failed, always leaves one. If the
 * interception ever broke, that assertion fails and the test says so.
 *
 * The REAL send path — what is sent, what is recorded, failures, a reply lost after the server took
 * the message — is covered at the service level in `recruitment-email.spec.ts` and, through the
 * actual mailer and a local SMTP server, in `recruitment-email-transport.spec.ts`. What is tested
 * here is the part only a browser can answer: what a person sees and can press.
 * ================================================================================================
 */

const unique = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const DAY = 86_400_000;

type Made = { candidates: number[] };

async function newCandidate(page: Page, made: Made, name: string, over: Record<string, unknown> = {}) {
  const res = await apiSend(page, 'POST', '/api/recruitment/candidates', {
    name, email: `${name.toLowerCase()}@probe.test`, phone: '416-555-0188', ...over,
  });
  const id = (res.body as { data: { id: number } }).data.id;
  made.candidates.push(id);
  return id;
}

async function cleanUp(page: Page, made: Made) {
  for (const id of made.candidates) {
    await apiSend(page, 'DELETE', `/api/recruitment/candidates/${id}`).catch(() => undefined);
  }
  made.candidates = [];
}

/**
 * Answers the Send Mail endpoint in the browser and keeps what was posted, so the test can check
 * exactly what the composer sent while no message reaches the server, the mailer or SMTP. Only the
 * POST to `/email` itself: the composer's GET and the server-built preview go through for real.
 */
async function interceptMail(page: Page, candidateId: number): Promise<Record<string, unknown>[]> {
  const posted: Record<string, unknown>[] = [];
  await page.route(`**/api/recruitment/candidates/${candidateId}/email`, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    posted.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { id: 1, status: 'sent', kind: 'manual', subject: 'intercepted' } }),
    });
  });
  return posted;
}

/** Proves no email was attempted: any real send, failed or not, leaves a row in the history. */
async function expectNoEmail(page: Page, candidateId: number) {
  const r = await apiGet(page, `/api/recruitment/candidates/${candidateId}/emails`);
  expect(r.status).toBe(200);
  expect((r.body as { data: unknown[] }).data).toHaveLength(0);
}

test.describe('recording permission to text a candidate', () => {
  test('three states, shown as three, and recorded with a name', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const made: Made = { candidates: [] };
    try {
      const id = await newCandidate(page, made, unique('ZZSMSA'));
      await page.goto(`/crm/recruitment/${id}`);

      /*
       * A brand-new candidate has NO recorded answer, and the screen must say exactly that. "Not
       * recorded" and "declined" lead to different actions, so showing null as "No" would send a
       * recruiter off to have a conversation that already happened the other way.
       */
      // By the Texting field's own wording: "Not recorded" alone also matches the Source field.
      await expect(page.getByText('Not recorded — ask before texting')).toBeVisible();

      await page.getByRole('button', { name: 'They agreed' }).click();
      await expect(page.locator('dd').filter({ hasText: /Agreed/ })).toBeVisible();
      await expect(page.locator('dd').filter({ hasText: /recorded by/ })).toBeVisible();

      // The API agrees with the screen, and carries who recorded it.
      const after = await apiGet(page, `/api/recruitment/candidates/${id}`);
      const c = (after.body as { candidate: Record<string, unknown> }).candidate;
      expect(c.sms_consent).toBe(true);
      expect(c.sms_consent_by).toBeTruthy();
      expect(c.sms_consent_at).toBeTruthy();
    } finally {
      await cleanUp(page, made);
    }
  });

  test('withdrawing records a refusal rather than clearing the answer', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const made: Made = { candidates: [] };
    try {
      const id = await newCandidate(page, made, unique('ZZSMSB'));
      await page.goto(`/crm/recruitment/${id}`);
      await page.getByRole('button', { name: 'They agreed' }).click();
      await expect(page.locator('dd').filter({ hasText: /Agreed/ })).toBeVisible();

      await page.getByRole('button', { name: 'They declined' }).click();
      await expect(page.locator('dd').filter({ hasText: 'Asked not to be texted' })).toBeVisible();

      /*
       * `false`, not back to null. Clearing it would say nobody ever asked — which is untrue, and
       * loses the one fact that matters most here.
       */
      const after = await apiGet(page, `/api/recruitment/candidates/${id}`);
      expect((after.body as { candidate: { sms_consent: unknown } }).candidate.sms_consent).toBe(false);
    } finally {
      await cleanUp(page, made);
    }
  });
});

test.describe('the Send Mail composer', () => {
  test('will not preview or send an incomplete email, and says why', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const made: Made = { candidates: [] };
    try {
      const id = await newCandidate(page, made, unique('ZZSMSC'));
      await page.goto(`/crm/recruitment/${id}`);
      await page.getByRole('button', { name: 'Send Mail' }).click();
      const modal = page.locator('.modal');
      await expect(modal.locator('.modal-h')).toHaveText('Send mail');

      const subject = modal.locator('.field').filter({ hasText: 'Subject' }).locator('input');
      const message = modal.locator('textarea');

      // No subject: nothing to preview, and the reason is on screen.
      await subject.fill('');
      await expect(modal.getByRole('button', { name: 'Preview' })).toBeDisabled();
      await expect(modal.getByText('The email needs a subject.')).toBeVisible();

      // A subject but a blank message: still refused, with that reason instead.
      await subject.fill('Your application');
      await message.fill('   ');
      await expect(modal.getByRole('button', { name: 'Preview' })).toBeDisabled();
      await expect(modal.getByText('The email needs a message.')).toBeVisible();

      // Send does not exist before a preview.
      await expect(modal.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0);

      // The server holds the same line if asked directly, and records nothing for a refusal.
      const direct = await apiSend(page, 'POST', `/api/recruitment/candidates/${id}/email`, { subject: '', message: 'x' });
      expect(direct.status).toBe(400);
      await expectNoEmail(page, id);
    } finally {
      await cleanUp(page, made);
    }
  });

  test('shows the address it will send to, previews exactly what goes, and sends on the second press', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const made: Made = { candidates: [] };
    try {
      const name = unique('ZZSMSD');
      const id = await newCandidate(page, made, name);
      const email = `${name.toLowerCase()}@probe.test`;
      const posted = await interceptMail(page, id);

      await page.goto(`/crm/recruitment/${id}`);
      await page.getByRole('button', { name: 'Send Mail' }).click();
      const modal = page.locator('.modal');

      /*
       * THE ADDRESS IS THE SERVER'S — the candidate's saved email, shown so the sender can see where
       * it is going; the request never tells the server where to send. The From line is the CRM
       * mail account the server resolved.
       */
      const composer = await apiGet(page, `/api/recruitment/candidates/${id}/email`);
      const from = (composer.body as { from: { email: string } | null }).from;
      await expect(modal.locator('dd').first()).toContainText(name);
      await expect(modal.locator('dd').first()).toContainText(email);
      if (from) await expect(modal.locator('dd').nth(1)).toContainText(from.email);

      const subject = modal.locator('.field').filter({ hasText: 'Subject' }).locator('input');
      const message = modal.locator('textarea');
      // Opens with a starting point already in both boxes.
      await expect(subject).not.toHaveValue('');
      await expect(message).toHaveValue(/^Hi /);

      await subject.fill('Interview on Tuesday <confirmed>');
      await message.fill('Hi there,\n\nConfirming your interview on Tuesday at <b>10</b>.');
      await expect(modal.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0);

      // The preview is what the server built: escaped, so markup typed into the message stays text.
      await modal.getByRole('button', { name: 'Preview' }).click();
      await expect(modal.getByText(`This is exactly what will be sent to ${email}.`)).toBeVisible();
      const preview = modal.locator('.card');
      await expect(preview).toContainText('Interview on Tuesday <confirmed>');
      await expect(preview).toContainText('Confirming your interview on Tuesday at <b>10</b>.');
      await expect(preview.locator('b')).toHaveCount(0);

      // Back to editing keeps what was written, rather than starting again.
      await modal.getByRole('button', { name: 'Back to editing' }).click();
      await expect(subject).toHaveValue('Interview on Tuesday <confirmed>');
      await expect(message).toHaveValue('Hi there,\n\nConfirming your interview on Tuesday at <b>10</b>.');

      await modal.getByRole('button', { name: 'Preview' }).click();
      await modal.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.locator('.modal')).toHaveCount(0);
      await expect(page.getByText('Email sent.')).toBeVisible();

      // Exactly one request, carrying exactly what was written — and no recipient of its own.
      expect(posted).toEqual([{ subject: 'Interview on Tuesday <confirmed>', message: 'Hi there,\n\nConfirming your interview on Tuesday at <b>10</b>.' }]);
      // The interception held: the server never sent or recorded anything.
      await expectNoEmail(page, id);
    } finally {
      await cleanUp(page, made);
    }
  });

  test('texting consent plays no part: a candidate who declined texts can still be emailed', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const made: Made = { candidates: [] };
    try {
      const id = await newCandidate(page, made, unique('ZZSMSE'));
      const consent = await apiSend(page, 'POST', `/api/recruitment/candidates/${id}/sms-consent`, { consent: false });
      expect(consent.status).toBe(200);
      const posted = await interceptMail(page, id);

      await page.goto(`/crm/recruitment/${id}`);
      await expect(page.locator('dd').filter({ hasText: 'Asked not to be texted' })).toBeVisible();

      await page.getByRole('button', { name: 'Send Mail' }).click();
      const modal = page.locator('.modal');
      // No texting refusal in the email composer, and nothing standing in the way of sending.
      await expect(modal.getByText(/texted/i)).toHaveCount(0);
      await modal.locator('textarea').fill('Hi, a quick note about your application.');
      await expect(modal.getByRole('button', { name: 'Preview' })).toBeEnabled();
      await modal.getByRole('button', { name: 'Preview' }).click();
      await modal.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.locator('.modal')).toHaveCount(0);
      expect(posted).toHaveLength(1);

      // And the refusal to be texted is still on record, untouched by emailing.
      const after = await apiGet(page, `/api/recruitment/candidates/${id}`);
      expect((after.body as { candidate: { sms_consent: unknown } }).candidate.sms_consent).toBe(false);
      await expectNoEmail(page, id);
    } finally {
      await cleanUp(page, made);
    }
  });
});

test.describe('interviews', () => {
  test('an alert link opens the candidate at their interviews', async ({ page }) => {
    /*
     * The destination an interview notification carries. The link itself is asserted in
     * `recruitment-interview-alerts.spec.ts`; what a browser adds is whether arriving there puts
     * the interview in front of the reader rather than somewhere below the fold.
     */
    await signIn(page, 'superAdmin');
    const made: Made = { candidates: [] };
    try {
      const id = await newCandidate(page, made, unique('ZZSMSF'));
      await apiSend(page, 'POST', `/api/recruitment/candidates/${id}/status`, { status: 'contacted' });
      await apiSend(page, 'POST', `/api/recruitment/candidates/${id}/interviews`, {
        scheduled_at: new Date(Date.now() + 2 * DAY).toISOString(),
      });

      await page.goto(`/crm/recruitment/${id}?focus=interviews`);

      const card = page.locator('.card').filter({ has: page.getByText('Interviews', { exact: true }) }).first();
      await expect(card).toBeVisible();
      await expect(card).toBeInViewport({ timeout: 10_000 });
    } finally {
      await cleanUp(page, made);
    }
  });

  test('cancelling asks first, then marks it cancelled', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const made: Made = { candidates: [] };
    try {
      const id = await newCandidate(page, made, unique('ZZSMSG'));
      await apiSend(page, 'POST', `/api/recruitment/candidates/${id}/status`, { status: 'contacted' });
      await apiSend(page, 'POST', `/api/recruitment/candidates/${id}/interviews`, {
        scheduled_at: new Date(Date.now() + 2 * DAY).toISOString(),
      });

      await page.goto(`/crm/recruitment/${id}?focus=interviews`);
      await page.getByRole('button', { name: 'Cancel interview' }).click();

      // Confirmed, because it tells two other people the interview is off and stops its reminders.
      await expect(page.getByText(/Everyone who was told about it is told it is off/i)).toBeVisible();
      await page.locator('.modal').getByRole('button', { name: /^Cancel interview$/ }).click();

      await expect(page.getByText('Cancelled').first()).toBeVisible();
      const after = await apiGet(page, `/api/recruitment/candidates/${id}`);
      const interviews = (after.body as { interviews: { status: string }[] }).interviews;
      expect(interviews[0].status).toBe('cancelled');
    } finally {
      await cleanUp(page, made);
    }
  });
});

test.describe('who may reach any of this', () => {
  test('an agent is refused Recruitment outright, texting included', async ({ page }) => {
    /*
     * `RecruitmentNoAgentsGuard` refuses agents every route on the controller whatever the
     * permission matrix says. Asserted through the API because that is what actually holds — the
     * screen not drawing a button is a courtesy, not a control.
     */
    await signIn(page, 'agent');

    const list = await apiGet(page, '/api/recruitment/candidates');
    expect(list.status).toBe(403);

    const composer = await apiGet(page, '/api/recruitment/candidates/1/sms');
    expect(composer.status).toBe(403);

    const send = await apiSend(page, 'POST', '/api/recruitment/candidates/1/sms', { body: 'Hello.' });
    expect(send.status).toBe(403);

    const consent = await apiSend(page, 'POST', '/api/recruitment/candidates/1/sms-consent', { consent: true });
    expect(consent.status).toBe(403);
  });

  test('a candidate outside your scope is not found, rather than merely hidden', async ({ page }) => {
    // Created by an administrator and assigned to nobody the CRM user carries.
    const made: Made = { candidates: [] };
    await signIn(page, 'superAdmin');
    const id = await newCandidate(page, made, unique('ZZSMSH'), { assigned_recruiter_id: 999_001 });

    try {
      await signIn(page, 'crm');
      const detail = await apiGet(page, `/api/recruitment/candidates/${id}`);
      const composer = await apiGet(page, `/api/recruitment/candidates/${id}/sms`);
      // 404 or 403 — the point is that it is refused, and that nothing is leaked either way.
      expect([403, 404]).toContain(detail.status);
      expect([403, 404]).toContain(composer.status);
      expect(JSON.stringify(detail.body ?? {})).not.toContain('416-555-0188');
    } finally {
      await signIn(page, 'superAdmin');
      await cleanUp(page, made);
    }
  });
});
