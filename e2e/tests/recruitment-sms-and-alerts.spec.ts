import { test, expect, type Page } from '@playwright/test';
import { signIn, apiGet, apiSend } from './helpers';

/**
 * Recruitment texting and interview alerts, through a real browser.
 *
 * ================================================================================================
 * NO LIVE TEXT CAN BE SENT FROM THIS FILE, and that needed arranging rather than assuming.
 *
 * `server/.env` carries REAL Twilio credentials, and the e2e API inherits the environment — so a
 * browser pressing Send would reach Twilio and a real handset would ring. Every test that presses
 * Send therefore installs `page.route` on the send endpoint first: the request is answered inside
 * the browser and never reaches the server, so the server never calls the gateway.
 *
 * That is asserted rather than trusted. `expectNothingSent` checks afterwards that the candidate
 * has no `recruitment_messages` row at all — which is only true if the server was genuinely never
 * asked to send. If the interception ever broke, that assertion fails and the test says so.
 *
 * The SUCCESSFUL send path — what is dialled, what is recorded, what the failures look like — is
 * covered at the service level in `recruitment-sms.spec.ts`, against a stubbed gateway. What is
 * tested here is the part only a browser can answer: what a person sees and can press.
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

/** Answers the send endpoint in the browser, so the server — and Twilio — never see it. */
async function interceptSend(page: Page, candidateId: number) {
  await page.route(`**/api/recruitment/candidates/${candidateId}/sms`, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { id: 1, status: 'queued', body: 'intercepted', phone: '+14165550188' } }),
    });
  });
}

/** Proves the interception held: a real send would have left a row behind. */
async function expectNothingSent(page: Page, candidateId: number) {
  const r = await apiGet(page, `/api/recruitment/candidates/${candidateId}/messages`);
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

test.describe('the Send Text composer', () => {
  test('refuses to send to somebody nobody has asked, and says why', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const made: Made = { candidates: [] };
    try {
      const id = await newCandidate(page, made, unique('ZZSMSC'));
      await page.goto(`/crm/recruitment/${id}`);
      await page.getByRole('button', { name: 'Send Text' }).click();

      await expect(page.getByText(/no record of .* agreeing to be texted/i)).toBeVisible();
      // Preview is unreachable: there is nothing to preview if it cannot go.
      await expect(page.getByRole('button', { name: 'Preview' })).toBeDisabled();
      await expectNothingSent(page, id);
    } finally {
      await cleanUp(page, made);
    }
  });

  test('shows the number it will dial, previews exactly what goes, and sends on the second press', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const made: Made = { candidates: [] };
    try {
      const id = await newCandidate(page, made, unique('ZZSMSD'));
      await apiSend(page, 'POST', `/api/recruitment/candidates/${id}/sms-consent`, { consent: true });
      await interceptSend(page, id);

      await page.goto(`/crm/recruitment/${id}`);
      await page.getByRole('button', { name: 'Send Text' }).click();

      /*
       * THE NUMBER IS THE SERVER'S, IN THE FORM IT WILL BE DIALLED. The composer shows it so the
       * sender can see where it is going; it never tells the server where to send.
       */
      await expect(page.getByText('+14165550188')).toBeVisible();

      const box = page.locator('.modal textarea');
      await box.fill('Confirming your interview on Tuesday.');

      /*
       * Writing and sending are separated by a deliberate press — an SMS cannot be recalled. Matched
       * EXACTLY: "Send Text" on the page behind also contains the word Send.
       */
      await expect(page.locator('.modal').getByRole('button', { name: 'Send', exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: 'Preview' }).click();
      await expect(page.getByText('Confirming your interview on Tuesday.')).toBeVisible();
      await expect(page.getByText(/cannot be recalled/i)).toBeVisible();

      // Back to editing keeps what was written, rather than starting again.
      await page.getByRole('button', { name: 'Back to editing' }).click();
      await expect(box).toHaveValue('Confirming your interview on Tuesday.');

      await page.getByRole('button', { name: 'Preview' }).click();
      await page.locator('.modal').getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.locator('.modal')).toHaveCount(0);

      // The interception held — the server was never asked, so nothing was recorded or dialled.
      await expectNothingSent(page, id);
    } finally {
      await cleanUp(page, made);
    }
  });

  test('offers to record the agreement where the refusal appears', async ({ page }) => {
    // Somebody finds out consent is missing at the moment they try to text. Asking them to go
    // elsewhere to record it is how it ends up never being recorded.
    await signIn(page, 'superAdmin');
    const made: Made = { candidates: [] };
    try {
      const id = await newCandidate(page, made, unique('ZZSMSE'));
      await page.goto(`/crm/recruitment/${id}`);
      await page.getByRole('button', { name: 'Send Text' }).click();

      await page.getByRole('button', { name: 'They agreed to be texted' }).click();
      await expect(page.getByText(/Agreed to be texted — recorded by/i)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Preview' })).toBeEnabled();
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
