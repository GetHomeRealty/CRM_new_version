import { test, expect, type Page } from '@playwright/test';
import { signIn, apiGet, apiSend } from './helpers';

/**
 * The four cards under "Interviews and what is due" open exactly what they counted.
 *
 * WHY A BROWSER TEST AND NOT A UNIT TEST. The claim is not "a function returns the right filter".
 * It is: a figure read off a card, clicked, lands on a list of that many rows, all of which match
 * what the card described — across two tabs, two endpoints and the URL in between. Every part of
 * that can be individually correct while the journey is wrong, which is the failure a person would
 * actually hit.
 *
 * THE COUNT AND THE LIST COME FROM DIFFERENT ENDPOINTS. The card reads `/stats`; the list it opens
 * is fetched from `/interviews` or `/candidates` with a query. Nothing makes those agree by
 * construction — they agree only while the filter asks the same question the count asked. So every
 * case below asserts the number on the card against the rows actually rendered, not against a
 * figure the test worked out for itself.
 *
 * "SCHEDULED INTERVIEWS" AND "CANDIDATES AT INTERVIEW STAGE" ARE DIFFERENT QUESTIONS. One candidate
 * may be booked twice, and a candidate moved on to Approved keeps the interview that got them
 * there. The fixture creates both of those on purpose, and one test asserts the distinction
 * directly rather than relying on two totals happening to differ.
 */

const unique = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const DAY = 86_400_000;

/**
 * By the `title` the card sets for itself, NOT by its text.
 *
 * The grid above the tabs carries "Interviews Scheduled" and "Completed Interviews", both of which
 * contain the labels used here — so matching on text would silently test the wrong card and pass,
 * since those cards drill down to the same place. The title is exact.
 */
const card = (page: Page, label: string) =>
  page.locator(`.meta-stat[title="Show ${label}"]`);

/** The figure printed on a card. */
async function cardValue(page: Page, label: string): Promise<number> {
  const text = await card(page, label).locator('.meta-stat-n').innerText();
  return Number(text.trim());
}

const interviewRows = (page: Page) =>
  page.locator('.list-table').first().locator('tbody tr');

/** The Interviews tab renders two tables; the follow-ups one is the second. */
const followupRows = (page: Page) =>
  page.locator('.list-table').nth(1).locator('tbody tr');

const candidateRows = (page: Page) => page.locator('.list-table').first().locator('tbody tr');

type Made = { candidates: number[] };

/**
 * A new candidate, moved straight to Contacted.
 *
 * NOT A CONVENIENCE — booking an interview only advances a candidate from a status where that is a
 * step forward, and `new -> interview` is not one of them. A candidate left at `new` therefore keeps
 * that status when an interview is booked, which is correct and was enough to make an earlier
 * version of this fixture seed four candidates and nought at interview stage.
 */
async function newCandidate(page: Page, made: Made, name: string): Promise<number> {
  const res = await apiSend(page, 'POST', '/api/recruitment/candidates', {
    name, email: `${name.toLowerCase()}@probe.test`,
  });
  const id = (res.body as { data: { id: number } }).data.id;
  made.candidates.push(id);
  await apiSend(page, 'POST', `/api/recruitment/candidates/${id}/status`, { status: 'contacted' });
  return id;
}

/** Books an interview, which also moves the candidate to Interview — that is what booking means. */
async function book(page: Page, id: number, when: Date): Promise<number> {
  const res = await apiSend(page, 'POST', `/api/recruitment/candidates/${id}/interviews`, {
    scheduled_at: when.toISOString(),
  });
  return (res.body as { data: { id: number } }).data.id;
}

async function cleanUp(page: Page, made: Made): Promise<void> {
  for (const id of made.candidates) {
    await apiSend(page, 'DELETE', `/api/recruitment/candidates/${id}`).catch(() => undefined);
  }
  made.candidates = [];
}

test.describe('the Interviews-tab cards open what they count', () => {
  test('each card lands on a list matching its figure and its filter', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const made: Made = { candidates: [] };

    try {
      // -------------------------------------------------------------- the fixture
      const a = await newCandidate(page, made, unique('ZZCARDA'));
      const b = await newCandidate(page, made, unique('ZZCARDB'));
      const c = await newCandidate(page, made, unique('ZZCARDC'));
      const d = await newCandidate(page, made, unique('ZZCARDD'));

      await book(page, a, new Date(Date.now() + DAY));
      // B is booked TWICE: two scheduled interviews, still one candidate at interview stage.
      await book(page, b, new Date(Date.now() + 2 * DAY));
      await book(page, b, new Date(Date.now() + 3 * DAY));
      // C's interview is completed; C stays at interview stage.
      const cIv = await book(page, c, new Date(Date.now() - DAY));
      await apiSend(page, 'PUT', `/api/recruitment/candidates/${c}/interviews/${cIv}`, { status: 'completed' });
      // D keeps a scheduled interview but is moved on, so D is NOT at interview stage.
      await book(page, d, new Date(Date.now() + 4 * DAY));
      await apiSend(page, 'POST', `/api/recruitment/candidates/${d}/status`, { status: 'approved' });

      await apiSend(page, 'POST', `/api/recruitment/candidates/${a}/followups`, {
        title: 'ZZ overdue one', due_at: new Date(Date.now() - 2 * DAY).toISOString(),
      });
      await apiSend(page, 'POST', `/api/recruitment/candidates/${b}/followups`, {
        title: 'ZZ overdue two', due_at: new Date(Date.now() - DAY).toISOString(),
      });
      await apiSend(page, 'POST', `/api/recruitment/candidates/${c}/followups`, {
        title: 'ZZ not yet due', due_at: new Date(Date.now() + 5 * DAY).toISOString(),
      });

      // -------------------------------------------------------------- card 1: Scheduled
      await page.goto('/crm/recruitment?tab=interviews');
      await expect(card(page, 'Scheduled')).toBeVisible();
      const scheduled = await cardValue(page, 'Scheduled');
      /*
       * GUARDS AGAINST A VACUOUS PASS. Every assertion below compares a list against a figure, and
       * nought equals nought however wrong the filter is — an earlier fixture left its candidates at
       * `new`, so "at interview stage" was 0, the list was empty, and the comparison held while
       * proving nothing. The fixture seeds at least these, so a zero here is a broken fixture.
       */
      expect(scheduled, 'the fixture should have seeded scheduled interviews').toBeGreaterThanOrEqual(4);

      await card(page, 'Scheduled').click();
      await expect(page).toHaveURL(/tab=interviews/);
      await expect(page).toHaveURL(/istatus=scheduled/);
      await expect(interviewRows(page)).toHaveCount(scheduled);
      // Every row says Scheduled — the list is filtered, not merely shortened.
      const statuses = await interviewRows(page).locator('td:nth-child(5)').allInnerTexts();
      expect(new Set(statuses.map((s) => s.trim()))).toEqual(new Set(['Scheduled']));

      // -------------------------------------------------------------- card 2: Completed
      await page.goto('/crm/recruitment?tab=interviews');
      const completed = await cardValue(page, 'Completed');
      expect(completed, 'the fixture should have seeded a completed interview').toBeGreaterThanOrEqual(1);
      await card(page, 'Completed').click();
      await expect(page).toHaveURL(/istatus=completed/);
      await expect(interviewRows(page)).toHaveCount(completed);
      const done = await interviewRows(page).locator('td:nth-child(5)').allInnerTexts();
      expect(new Set(done.map((s) => s.trim()))).toEqual(new Set(['Completed']));

      // -------------------------------------------------------------- card 3: At interview stage
      await page.goto('/crm/recruitment?tab=interviews');
      const atStage = await cardValue(page, 'At interview stage');
      expect(atStage, 'the fixture should have seeded candidates at interview stage').toBeGreaterThanOrEqual(3);
      // And the two really are different questions, which is only visible when they differ.
      expect(scheduled).not.toBe(atStage);
      await card(page, 'At interview stage').click();
      // A CANDIDATE status, so this leaves for the Candidates tab.
      await expect(page).toHaveURL(/tab=candidates/);
      await expect(page).toHaveURL(/status=interview/);
      /*
       * Against the total the screen prints, not the rows visible on this page: the candidates list
       * is paginated, so counting rows would quietly pass on a short page and start failing only
       * once the brokerage had fifty candidates at interview stage.
       */
      await expect(page.getByTestId('candidate-total')).toHaveText(new RegExp(`^${atStage} candidate`));
      await expect(candidateRows(page)).toHaveCount(Math.min(atStage, 50));

      /*
       * The distinction, asserted directly. D has a scheduled interview and is NOT at interview
       * stage, so D must be in the first list and absent from this one. Comparing the two totals
       * would prove nothing on a database that happened to make them equal.
       */
      const dName = (await apiGet(page, `/api/recruitment/candidates/${d}`)).body as { candidate: { name: string } };
      await expect(page.locator('.list-table').first()).not.toContainText(dName.candidate.name);
      await page.goto('/crm/recruitment?tab=interviews&istatus=scheduled');
      await expect(page.locator('.list-table').first()).toContainText(dName.candidate.name);

      // -------------------------------------------------------------- card 4: Follow-ups overdue
      await page.goto('/crm/recruitment?tab=interviews');
      const overdue = await cardValue(page, 'Follow-ups overdue');
      expect(overdue).toBeGreaterThanOrEqual(2);   // the two just seeded, at least

      await card(page, 'Follow-ups overdue').click();
      await expect(page).toHaveURL(/due=overdue/);
      await expect(followupRows(page)).toHaveCount(overdue);
      // Every row carries the Overdue pill; nothing merely pending slipped in.
      await expect(followupRows(page).locator('.pill.bad')).toHaveCount(overdue);
      await expect(page.locator('.list-table').nth(1)).not.toContainText('ZZ not yet due');
    } finally {
      await cleanUp(page, made);
    }
  });

  test('a card works from the keyboard as well as the mouse', async ({ page }) => {
    /*
     * The cards are divs, not links, so keyboard support is something the component has to do
     * rather than something it gets. A figure that can only be followed with a mouse is not
     * navigation for everybody.
     */
    await signIn(page, 'superAdmin');
    await page.goto('/crm/recruitment?tab=interviews');

    const target = card(page, 'Completed');
    await expect(target).toHaveAttribute('role', 'link');
    await expect(target).toHaveAttribute('tabindex', '0');

    await target.focus();
    await expect(target).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/istatus=completed/);

    // Space is the other key a person expects on something focusable.
    await page.goto('/crm/recruitment?tab=interviews');
    await card(page, 'Scheduled').focus();
    await page.keyboard.press(' ');
    await expect(page).toHaveURL(/istatus=scheduled/);
  });

  test('the filter survives a refresh and Back undoes the drill-down', async ({ page }) => {
    await signIn(page, 'superAdmin');
    await page.goto('/crm/recruitment?tab=interviews');

    await card(page, 'Scheduled').click();
    await expect(page).toHaveURL(/istatus=scheduled/);

    // Refresh: the state is in the URL, so it comes back.
    await page.reload();
    await expect(page).toHaveURL(/istatus=scheduled/);
    await expect(page.locator('select[aria-label="Interview status"]')).toHaveValue('scheduled');

    /*
     * Back returns to the overview the card was read from. These four cards PUSH rather than
     * replace, because somebody who clicked a figure to look into it needs a way back to the
     * figures; replacing the history entry sends Back out of Recruitment altogether.
     */
    await page.goBack();
    await expect(page).toHaveURL(/tab=interviews/);
    await expect(page).not.toHaveURL(/istatus=scheduled/);
    await expect(card(page, 'Scheduled')).toBeVisible();
  });

  test('a card with nothing to show is still clickable and says so', async ({ page }) => {
    await signIn(page, 'superAdmin');
    await page.goto('/crm/recruitment?tab=interviews');

    /*
     * Zero is a real answer and must be reachable. A card that goes dead at zero is the one case
     * where somebody most wants confirmation that the list really is empty rather than broken.
     */
    for (const label of ['Scheduled', 'Completed', 'At interview stage', 'Follow-ups overdue']) {
      await expect(card(page, label)).toHaveAttribute('role', 'link');
      await expect(card(page, label)).toHaveAttribute('tabindex', '0');
    }

    const overdue = await cardValue(page, 'Follow-ups overdue');
    await card(page, 'Follow-ups overdue').click();
    await expect(page).toHaveURL(/due=overdue/);

    if (overdue === 0) {
      await expect(page.getByText(/Nothing is overdue/i)).toBeVisible();
    } else {
      // Not empty here, so prove the empty state another way: clear it and the heading changes back.
      await expect(page.getByRole('button', { name: /Show all pending/i })).toBeVisible();
      await page.getByRole('button', { name: /Show all pending/i }).click();
      await expect(page).not.toHaveURL(/due=overdue/);
      await expect(page.getByText('Follow-ups due')).toBeVisible();
    }
  });

  test('the overdue view names itself, so missing rows are explained', async ({ page }) => {
    // A section that quietly shows fewer rows than a moment ago reads as rows having gone missing.
    await signIn(page, 'superAdmin');
    await page.goto('/crm/recruitment?tab=interviews&due=overdue');
    await expect(page.getByText(/Follow-ups overdue \(\d+\)/)).toBeVisible();
  });
});
