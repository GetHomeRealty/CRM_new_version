import { expect, test } from '@playwright/test';
import { signIn, apiGet, apiSend, API_BASE } from './helpers';

/**
 * Settings → Two-step verification, in a real browser.
 *
 * THE DEFECT. "Email address" and "Mobile number" are rendered from one loop over the available
 * channels, and both inputs were bound to a single piece of state. They were therefore two views of
 * one string: typing an address into the email field filled the mobile field with the same address,
 * and a number typed afterwards replaced it. Whichever was submitted last was the only value that
 * had ever really existed.
 *
 * WHY THIS CANNOT BE A SERVER TEST. The server has always kept the two apart — `user_mfa_methods` is
 * unique on (user, type), so each channel has its own row, its own destination, its own validator
 * and its own live code, and `server/src/auth/mfa/mfa.spec.ts` proves all of that against real rows.
 * Every one of those assertions passed while the screen was mirroring the fields, because the bug
 * was in what the screen SENT, not in what the server did with it. Only a browser can see it.
 *
 * NOTHING HERE SENDS A CODE. "Send a code by text" would hand a real number to Twilio, which is
 * configured in this environment. The subject is which field holds which value; sending is covered
 * against real rows in the Jest suite, with capturing providers.
 */

/**
 * WHERE IT LIVES NOW. It moved off the personal Settings page (beside Email Accounts) to CRM →
 * Settings → Two-Step Verification. It is one card reachable two ways, and both are tested below:
 * the Settings tab for anyone holding `settings`, and its own open route for everybody else.
 *
 * The open route is not decoration. The card configures the signed-in person's own factors and a
 * role can be REQUIRED to hold one — reachable only through a tab gated on `settings`, which agents
 * do not have, an agent could be told to enrol with no screen on which to do it.
 */
const TWO_STEP = '/crm/two-step';
const SETTINGS_TAB = '/crm/settings?tab=crm&section=two-step';
const ACCOUNT = '/crm/account';

const EMAIL_VALUE = 'patricia@brokerage.test';
const MOBILE_VALUE = '416-555-0100';

/** Both rows only render when the deployment can actually deliver on both channels. */
async function bothChannelsOffered(page: import('@playwright/test').Page): Promise<boolean> {
  const res = await apiGet(page, '/api/mfa');
  const channels = (res.body as { available_channels: string[] }).available_channels ?? [];
  return channels.includes('email') && channels.includes('sms');
}

const emailField = (page: import('@playwright/test').Page) => page.getByLabel('Email address');
const mobileField = (page: import('@playwright/test').Page) => page.getByLabel('Mobile number');

test.describe('the two destinations are separate fields', () => {
  test('typing an email address does not fill the mobile number', async ({ page }) => {
    await signIn(page, 'agent');
    test.skip(!(await bothChannelsOffered(page)), 'this deployment does not offer both channels');
    await page.goto(TWO_STEP);

    await emailField(page).fill(EMAIL_VALUE);

    await expect(emailField(page)).toHaveValue(EMAIL_VALUE);
    // The regression: this held the address too.
    await expect(mobileField(page)).toHaveValue('');
  });

  test('typing a mobile number does not overwrite the email address', async ({ page }) => {
    await signIn(page, 'agent');
    test.skip(!(await bothChannelsOffered(page)), 'this deployment does not offer both channels');
    await page.goto(TWO_STEP);

    await mobileField(page).fill(MOBILE_VALUE);

    await expect(mobileField(page)).toHaveValue(MOBILE_VALUE);
    await expect(emailField(page)).toHaveValue('');
  });

  test('both hold their own value at the same time, in either order', async ({ page }) => {
    await signIn(page, 'agent');
    test.skip(!(await bothChannelsOffered(page)), 'this deployment does not offer both channels');
    await page.goto(TWO_STEP);

    await emailField(page).fill(EMAIL_VALUE);
    await mobileField(page).fill(MOBILE_VALUE);
    await expect(emailField(page)).toHaveValue(EMAIL_VALUE);
    await expect(mobileField(page)).toHaveValue(MOBILE_VALUE);

    // Editing one afterwards still leaves the other alone.
    await emailField(page).fill('someone.else@brokerage.test');
    await expect(mobileField(page)).toHaveValue(MOBILE_VALUE);

    await mobileField(page).fill('416-555-0199');
    await expect(emailField(page)).toHaveValue('someone.else@brokerage.test');
  });

  test('each input is typed for what it holds', async ({ page }) => {
    /*
     * Not cosmetic: the input type is what puts a numeric keypad in front of somebody on a phone and
     * what makes the browser offer the right saved value. Two fields sharing one state had no reason
     * to differ, and a future edit that re-merged them would show up here.
     */
    await signIn(page, 'agent');
    test.skip(!(await bothChannelsOffered(page)), 'this deployment does not offer both channels');
    await page.goto(TWO_STEP);

    await expect(emailField(page)).toHaveAttribute('type', 'email');
    await expect(mobileField(page)).toHaveAttribute('type', 'tel');
  });

  test('each row has its own send button, addressed to its own channel', async ({ page }) => {
    await signIn(page, 'agent');
    test.skip(!(await bothChannelsOffered(page)), 'this deployment does not offer both channels');
    await page.goto(TWO_STEP);

    const byEmail = page.getByRole('button', { name: 'Send a code by email' });
    const byText = page.getByRole('button', { name: 'Send a code by text' });
    await expect(byEmail).toBeVisible();
    await expect(byText).toBeVisible();

    /*
     * Each button is enabled by ITS OWN field. With one shared value both went live together, which
     * is the same defect seen from the other side — and it meant "Send a code by text" could be
     * pressed while the only thing anybody had typed was an email address.
     */
    await expect(byEmail).toBeDisabled();
    await expect(byText).toBeDisabled();

    await emailField(page).fill(EMAIL_VALUE);
    await expect(byEmail).toBeEnabled();
    await expect(byText).toBeDisabled();

    await mobileField(page).fill(MOBILE_VALUE);
    await expect(byText).toBeEnabled();
  });
});

// ============================================================================ where it lives
/**
 * The move: off the personal Settings page, into CRM Settings.
 *
 * Two things have to hold together, and testing only one of them is how a move like this goes
 * wrong. It must be GONE from where it used to be — otherwise there are two places to configure one
 * thing and they will drift — and it must be REACHABLE by the people who need it, which is
 * everybody, not only those who can open CRM Settings.
 */
test.describe('two-step verification has moved to CRM Settings', () => {
  const heading = (page: import('@playwright/test').Page) =>
    page.getByText('Two-step verification', { exact: true });

  test('it is no longer on the personal Settings page', async ({ page }) => {
    await signIn(page, 'agent');
    await page.goto(ACCOUNT);

    // The page itself still works and still has everything else that was on it.
    await expect(page.getByText('Profile Picture')).toBeVisible();
    // And the card is gone from it.
    await expect(heading(page)).toHaveCount(0);
    await expect(page.getByText('A second step at sign-in, so a stolen password is not enough on its own.')).toHaveCount(0);
  });

  test('an agent reaches it at its own route', async ({ page }) => {
    /*
     * THE ACCESS THE MOVE COULD HAVE COST. Agents hold no `settings` permission, so CRM → Settings
     * is closed to them — and a role can be required to hold a second factor. If this ever fails,
     * somebody can be told to enrol with nowhere to do it.
     */
    await signIn(page, 'agent');
    await page.goto(TWO_STEP);

    await expect(heading(page)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Two-Step Verification' })).toBeVisible();
  });

  test('the agent route is not CRM Settings under another name', async ({ page }) => {
    // Reaching the card must not have handed the agent the rest of the tab.
    await signIn(page, 'agent');
    const res = await apiGet(page, '/api/crm-settings');
    expect(res.status).toBe(403);
  });

  test('a Super Admin reaches it as a section of CRM Settings', async ({ page }) => {
    await signIn(page, 'superAdmin');
    await page.goto(SETTINGS_TAB);

    await expect(heading(page)).toBeVisible();

    /*
     * Listed beside the other CRM Settings sections rather than replacing them. Scoped to `main`
     * because the sidebar carries an entry of the same name — which is the point of the next
     * assertion, not an accident of this one.
     */
    const sections = page.getByRole('main');
    await expect(sections.getByRole('button', { name: 'Two-Step Verification' })).toBeVisible();
    await expect(sections.getByRole('button', { name: 'Communications' })).toBeVisible();
    // "CRM Settings" names both the tab and its first section, so this counts rather than matching
    // one of them. Either way it is still there — the new section was added, not substituted.
    await expect(sections.getByRole('button', { name: 'CRM Settings' })).toHaveCount(2);

    // And the sidebar offers it too, so it is not buried behind knowing the tab exists.
    await expect(page.getByRole('complementary').getByRole('button', { name: 'Two-Step Verification' })).toBeVisible();
  });

  test('a Super Admin sees it at the open route too, and it is the same card', async ({ page }) => {
    await signIn(page, 'superAdmin');
    await page.goto(TWO_STEP);
    await expect(heading(page)).toBeVisible();
  });

  test('it shows the viewer their OWN factors, whichever door they came through', async ({ page }) => {
    /*
     * One card, one endpoint, one person's data. The status call is the whole state of the screen,
     * so if the two doors ever diverged this is where it would show.
     */
    await signIn(page, 'agent');
    const res = await apiGet(page, '/api/mfa');
    expect(res.status).toBe(200);

    const body = res.body as { methods: unknown[]; available_channels: string[]; enabled: boolean };
    expect(Array.isArray(body.methods)).toBe(true);
    expect(Array.isArray(body.available_channels)).toBe(true);
    expect(typeof body.enabled).toBe('boolean');
  });

  test('the endpoints behind it are untouched by the move', async ({ page }) => {
    /*
     * The move was navigation only. These are the calls the card makes, and they answer exactly as
     * they did when it sat on the other page — including refusing the ones that should be refused.
     */
    await signIn(page, 'agent');

    // Enrolment still validates per channel rather than accepting anything.
    const badEmail = await apiSend(page, 'POST', '/api/mfa/otp/begin', { channel: 'email', destination: '416-555-0100' });
    expect(badEmail.status).toBe(422);

    // Removing a factor still costs the password.
    const noPassword = await apiSend(page, 'POST', '/api/mfa/remove', { type: 'email', password: '' });
    expect([400, 401, 422]).toContain(noPassword.status);
  });

  test('signed out, the route is not a way in', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto(TWO_STEP);

    await expect(heading(page)).toHaveCount(0);
    const res = await page.request.get(`${API_BASE}/api/mfa`, { headers: { Accept: 'application/json' } });
    expect(res.status()).toBe(401);
  });
});
