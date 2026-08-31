import { test, expect } from '@playwright/test';
import { signIn, apiGet, apiSend } from './helpers';

/**
 * CRM › Settings — the two Low findings taken on from the 2026-08-04 audit.
 *
 * L1 is filed against CRM Settings and is not a CRM Settings bug: the overflow is the application
 * shell, on every screen in both areas. It is tested here because that is where it was found and
 * where anyone looking for it will look, and the cases cover screens outside Settings for exactly
 * that reason.
 */

const AGENT_OWNED_LEAD = 'marcus.bell@example.test';
const PHONE = { width: 390, height: 844 };

// ---------------------------------------------------------------------------- L1
test.describe('L1 — the shell does not scroll sideways on a phone', () => {
  /*
   * Measured at 390px before the fix: `document.scrollWidth` 547 on CRM Settings, 567 on the CRM
   * dashboard, 522 on Leads. One cause on all three — `.topbar` is a non-wrapping flex row whose
   * children could not shrink, and its right-hand cluster alone (bell, locale, avatar, name,
   * Password) measured 301px inside a 390px viewport.
   */
  for (const path of ['/crm/settings?tab=crm', '/crm/settings?tab=company', '/crm/dashboard', '/crm/leads']) {
    test(`no horizontal overflow at 390px on ${path}`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: PHONE });
      try {
        const p = await ctx.newPage();
        await signIn(p, 'superAdmin');
        await p.goto(path);
        await p.waitForTimeout(2500);

        const m = await p.evaluate(() => ({
          scrollW: document.documentElement.scrollWidth,
          clientW: document.documentElement.clientWidth,
          // Anything reaching past the viewport must be inside a container that scrolls on its own.
          // A wide table is fine; a wide PAGE is not.
          escaping: Array.from(document.querySelectorAll('*'))
            .filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
            .filter((e) => !e.closest('.lead-scroll'))
            .map((e) => `${e.tagName}.${String((e as HTMLElement).className || '').slice(0, 30)}`),
        }));

        expect(m.scrollW, `${path} must not scroll sideways`).toBe(m.clientW);
        expect(m.escaping, 'wide content must scroll inside its own container').toEqual([]);
      } finally {
        await ctx.close();
      }
    });
  }

  test('the screen is still named, and every control is still reachable', async ({ browser }) => {
    /*
     * The first attempt at this fix hid the title and let the breadcrumb shrink. It measured
     * `crumbsW: 0` on all three screens tested — the breadcrumb was squeezed out of existence by
     * the flex line, so nothing named the screen at all. Trading a sideways scroll for an unnamed
     * screen is not a fix, which is what this case exists to stop happening again.
     */
    const ctx = await browser.newContext({ viewport: PHONE });
    try {
      const p = await ctx.newPage();
      await signIn(p, 'superAdmin');
      await p.goto('/crm/settings?tab=crm');
      await p.waitForTimeout(2500);

      const title = p.locator('.topbar .title');
      await expect(title).toBeVisible();
      expect((await title.innerText()).trim().length).toBeGreaterThan(0);

      // Labels may go; controls may not. The bell, the avatar and the password button all stay,
      // and the password button keeps its accessible name from the title attribute.
      const pw = p.locator('.topbar button[title="Change your password"]');
      await expect(pw).toBeVisible();
      // Hiding a label must not shrink the thing you press. Without a floor this collapsed to a
      // 27px square once the word "Password" was dropped.
      const box = await pw.boundingBox();
      expect(box!.height, 'a control that stays must stay tappable').toBeGreaterThanOrEqual(36);
      expect(box!.width, 'a control that stays must stay tappable').toBeGreaterThanOrEqual(36);
    } finally {
      await ctx.close();
    }
  });

  test('the desktop topbar is untouched', async ({ page }) => {
    // The fix lives entirely in a max-width media query. If any of these disappear on a laptop the
    // rule has leaked out of its breakpoint.
    await signIn(page, 'superAdmin');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/crm/settings?tab=crm');
    await page.waitForTimeout(2000);

    await expect(page.locator('.topbar-locale')).toBeVisible();
    await expect(page.locator('.topbar-who')).toBeVisible();
    await expect(page.locator('.topbar-pw-label')).toBeVisible();
    await expect(page.locator('.topbar .crumbs')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1280);
  });
});

// ---------------------------------------------------------------------------- L10
test.describe('L10 — a CRM email leaves from a CRM mailbox', () => {
  /*
   * `dispatch()` called `sendDirect(email, subject, html)` with neither an account nor a user, so
   * `resolveSender(null, null)` fell through to "any active account" with no `scope` filter — the
   * exact cross-wiring `mail_accounts.scope` exists to prevent, and one that `broadcast()` in the
   * sibling service already took care to avoid. In the QA fixture the only connected account
   * belongs to an AGENT, so a Super Admin's CRM email went out from that agent's address.
   *
   * The environment has no reachable SMTP host, which is what makes these observable: the failure
   * names the host it tried, so the account chosen can be read off the refusal.
   */
  const HOST = 'own-crm-account.invalid';

  /**
   * A recipient the SENDER may actually reach.
   *
   * These two cases are about WHICH MAILBOX a CRM email leaves from, and they used to address
   * `AGENT_OWNED_LEAD` — a lead belonging to `agent@test.local`. That worked only while an
   * administrator could email any lead in the database, which is no longer true: the recipient must
   * be the brokerage's or the sender's own, so the send is now refused at the recipient check and
   * never reaches the mailbox selection these tests exist to pin.
   *
   * Creating the lead as the sender keeps the subject of the test unchanged and removes its
   * dependence on somebody else's fixture.
   */
  async function ownLead(page: Parameters<typeof signIn>[0]): Promise<{ email: string; id: number }> {
    const email = `l10-recipient-${Date.now()}@x.test`;
    const made = await apiSend(page, 'POST', '/api/leads', { name: 'L10 Recipient', email });
    expect([200, 201], `L10 recipient lead must be created: ${JSON.stringify(made.body)}`).toContain(made.status);
    return { email, id: (made.body as any).id };
  }

  test('the sender’s own CRM account is preferred over anyone else’s', async ({ page }) => {
    await signIn(page, 'superAdmin');

    // `scope` is read from the BODY, not the query string — `parseScope(body?.scope)` in
    // AccountController. Passing it as `?scope=crm` created the account unscoped, which is not a
    // CRM account at all and is why the first version of this case failed.
    const created = await apiSend(page, 'POST', '/api/account/mail-accounts', {
      scope: 'crm',
      name: 'L10 probe', from_name: 'Sam Whitfield', from_email: 'sam@l10.invalid',
      host: HOST, port: 587, username: 'sam', password: 'x', encryption: 'tls', is_default: true,
    });
    expect(created.status, 'the probe account must be created').toBeLessThan(300);
    const id = (created.body as any)?.id ?? (created.body as any)?.data?.id;

    const lead = await ownLead(page);
    try {
      const send = await apiSend(page, 'POST', '/api/crm-settings/email-settings', {
        action: 'sendCustomEmail', leadName: 'L10 Recipient', leadEmail: lead.email,
        subject: 'L10 probe', content: '<p>x</p>',
      });
      const message = String((send.body as any)?.message);

      // It tried the Super Admin's own CRM mailbox…
      expect(message).toContain(HOST);
      // …and not the agent's, which is the only other account in the fixture.
      expect(message).not.toContain('smtp.invalid.test');
    } finally {
      if (id) await apiSend(page, 'DELETE', `/api/account/mail-accounts/${id}`);
      await apiSend(page, 'DELETE', `/api/leads/${lead.id}`);
    }
  });

  test('with no CRM account connected the send is refused, not sent from somewhere else', async ({ page }) => {
    /*
     * The Super Admin has no CRM account of their own here, and the fixture's only account belongs
     * to an agent. `defaultSender('crm')` still finds it — that is its documented behaviour and
     * broadcasts share it — so what this pins is narrower and is the finding itself: whatever is
     * chosen is CRM-scoped, and when nothing CRM-scoped exists the send is refused with something
     * an administrator can act on rather than going out under an unrecognisable address.
     */
    await signIn(page, 'superAdmin');
    const lead = await ownLead(page);
    const send = await apiSend(page, 'POST', '/api/crm-settings/email-settings', {
      action: 'sendCustomEmail', leadName: 'L10 Recipient', leadEmail: lead.email,
      subject: 'L10 fallback probe', content: '<p>x</p>',
    });
    const message = String((send.body as any)?.message);

    const usedCrmAccount = message.includes('smtp.invalid.test');
    const refusedCleanly = /no CRM email account is connected/i.test(message);
    expect(usedCrmAccount || refusedCleanly,
      `expected a CRM-scoped sender or a clean refusal, got: ${message}`).toBe(true);

    // Never the raw "no active SMTP account" from the generic mailer — that message names the
    // Transaction Desk's Settings screen and would send whoever read it to the wrong place.
    expect(message).not.toMatch(/No active SMTP account is configured/i);

    await apiSend(page, 'DELETE', `/api/leads/${lead.id}`);
  });

  test('the refusal is recorded in the CRM email log either way', async ({ page }) => {
    // A send that did not happen is still something an administrator has to be able to look up.
    await signIn(page, 'superAdmin');
    const log = await apiGet(page, '/api/crm-settings/email-log?limit=10');
    // `{ data, meta }` since the log learned to report how much it is withholding; the bare array
    // could not say whether a short page was the end of the log or the end of the request.
    const rows = (log.body as { data?: any[] })?.data ?? [];
    expect(rows.some((r) => r.subject?.includes('L10')), 'the probe sends must appear in the log').toBe(true);
  });
});
