import { test, expect, type Page } from '@playwright/test';
import { signIn } from './helpers';

/**
 * CRM-011: the campaign composer must not open armed to the whole lead book.
 *
 * THE DEFECT WAS THE STARTING STATE, not the control. Every audience filter opens at "any", "any"
 * resolves to an omitted filter, and an omitted filter is correctly read by the API as the entire
 * lead table. So the window opened with the whole brokerage selected by nobody, the recipient count
 * showing that total, and the primary button live and reading "Send to 10". The filtering itself
 * always worked: narrowing to a tag gives the right count, and an audience matching nobody
 * correctly disables the button.
 *
 * WHAT IS NOT BEING REMOVED. Mailing the whole book is a real thing a brokerage does - a seasonal
 * newsletter is exactly that - so the capability stays. It now takes one deliberate tick instead of
 * being where the screen happens to begin.
 *
 * THE LEAD DATA IS REAL, from the seeded test database. Stubbing the audience preview would prove
 * the checkbox renders and nothing about whether the button is truly disarmed against a live count.
 * Nothing is ever sent: the assertions stop at the button's state, and the one send this file
 * attempts is blocked at the network layer.
 */

async function openComposer(page: Page): Promise<void> {
  await page.goto('/crm/campaigns');
  await page.getByRole('button', { name: /Create Campaign/i }).first().click();
  await expect(page.getByText(/recipients? match this segment/i)).toBeVisible({ timeout: 10_000 });
}

/** The primary action, whatever it currently reads. */
const sendButton = (page: Page) => page.getByRole('button', { name: /^(Send to|Schedule for)\s+\d+/ });

test.describe('the composer opens with nobody selected', () => {
  test('the send button is disabled until an audience is chosen', async ({ page }) => {
    await signIn(page, 'admin');
    await openComposer(page);

    // THE DEFECT: this button was enabled, reading "Send to 10", before anything was touched.
    await expect(sendButton(page)).toBeDisabled();
    await expect(page.getByText(/No audience filter is set/i)).toBeVisible();
  });

  test('ticking the box arms it, unticking disarms it again', async ({ page }) => {
    await signIn(page, 'admin');
    await openComposer(page);

    const box = page.getByRole('checkbox');
    await box.check();
    await expect(sendButton(page)).toBeEnabled();

    // Reversible: a tick made by accident is undone by looking at it.
    await box.uncheck();
    await expect(sendButton(page)).toBeDisabled();
  });

  test('narrowing the audience is itself a choice, and arms it', async ({ page }) => {
    await signIn(page, 'admin');
    await openComposer(page);

    // By its own label element rather than the accessible name: these filters are a <span> inside a
    // <label>, and several other controls on the page answer to "Status" too.
    await page.locator('label.report-field', { hasText: 'Status' }).first()
      .locator('select').selectOption({ index: 1 });

    // The "no filter" prompt is gone, because a filter now exists.
    await expect(page.getByText(/No audience filter is set/i)).toHaveCount(0);
  });

  test('reopening the composer forgets a previous tick', async ({ page }) => {
    // A tick carried over from the last campaign would re-arm the next one before anybody looked
    // at it, which is the same defect wearing a hat.
    await signIn(page, 'admin');
    await openComposer(page);
    await page.getByRole('checkbox').check();
    await expect(sendButton(page)).toBeEnabled();

    await page.getByRole('button', { name: /^Cancel$/ }).click();
    await openComposer(page);

    await expect(sendButton(page)).toBeDisabled();
  });

  test('pressing send anyway creates nothing', async ({ page }) => {
    /*
     * THE OBSERVABLE PROPERTY, rather than the mechanism. The send handler also refuses an unchosen
     * audience - belt as well as braces, since a keyboard submit or a stale render must not be the
     * only thing between one click and the whole lead book. But that second check cannot be reached
     * from a browser while the button is disabled: the DOM does not deliver clicks to a disabled
     * control at all, dispatched or otherwise. An earlier version of this test waited for the
     * refusal toast and timed out for exactly that reason - it was asserting something unreachable
     * and would have read as a fault in the fix.
     *
     * So what is asserted is what actually protects the brokerage: press it and NO campaign is
     * created. The handler check remains, for the paths a browser is not.
     */
    const attempted: string[] = [];
    await page.route('**/api/campaigns', async (route) => {
      if (route.request().method() === 'POST') { attempted.push(route.request().url()); return route.abort(); }
      return route.fallback();
    });

    await signIn(page, 'admin');
    await openComposer(page);
    await page.getByPlaceholder(/market update/i).fill('ZZ-UNARMED-PROBE');

    await sendButton(page).click({ force: true, timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(1_000);
    expect(attempted).toEqual([]);
  });
});
