import { test, expect, type Page } from '@playwright/test';
import { signIn, apiGet } from './helpers';

/**
 * Notification Preferences — now a matrix of category × channel.
 *
 * The behaviour worth protecting is the honesty of the screen: a route nothing sends must not
 * present a working switch, one that does must actually persist, and — new with the channel
 * dimension — muting one route must leave the others alone. The old model stored a single boolean
 * per category which meant PUSH, so that last property could not be expressed at all and the page
 * had to explain it in prose.
 *
 * These counts are asserted exactly rather than as "more than none". When a sender is built its
 * cell must move from Soon to switchable, and this file should fail until it does.
 */

/**
 * Every (category, channel) pair that has a sender today.
 *
 * Was 9. Three moved when calendar reminders gained an in-app copy and the listing-expiry and
 * lawyer-detail sweeps gained push — all three through `NotificationDispatcher`. This number going
 * up is what "wiring a sender" looks like from the outside, and this file failing is the reminder to
 * move it.
 */
/**
 * THESE COUNTS ARE PER AREA NOW. Five categories describe things that only happen on a transaction
 * — a listing expiring, lawyer details missing, a document review, an approval, a mention in a
 * deal's chat — and are no longer offered on the CRM's screen, where none of them can occur. The
 * preferences themselves are untouched and every sender still honours them; only the screen split.
 *
 * DERIVED FROM THE LISTS BELOW, NOT WRITTEN OUT, and that is a repair rather than a tidy-up. Both
 * figures were literals — 38 for the Desk, and eight shared categories for the CRM — and the
 * registry grew past them: `task_assigned` and `showing_created` arrived carrying no `areas` key,
 * which means BOTH screens. The CRM assertion then expected 23 checkboxes against 29 rendered, and
 * the Desk assertion was wrong in the same way and never evaluated, because the CRM one failed
 * first.
 *
 * A literal cannot fail loudly when the thing it describes changes; it just stops being true. These
 * now move with the lists, so adding a category to a list is enough, and adding one to the REGISTRY
 * without adding it here fails the count — which is the gate this file's header says it means to be.
 */
/**
 * None. Every category now has a sender on every channel it supports.
 *
 * Kept as a constant rather than deleted so this file stays the gate it has been throughout: adding
 * a category, or a channel to an existing one, fails here until something actually sends it.
 */
const PENDING_PAIRS = 0;
/** Pairs that make no sense at all: emailing somebody to say they have an email. */
const UNSUPPORTED_PAIRS = 1;

/** Only ever raised by a transaction, so offered only on the Transaction Desk's screen. */
const DESK_ONLY = [
  'Listing expiry reminders', 'Lawyer detail reminders', 'Document review updates',
  'Transaction approvals', 'Team chat mentions',
];

/** Shown on both screens — nothing here is tied to one side of the product. */
const SHARED = [
  'Calendar reminders', 'New inbox emails',
  // The CRM lead and campaign events.
  'New leads', 'Leads assigned to you', 'Facebook leads', 'Follow-ups falling due',
  // Assignment and booking, which are their own events on purpose: muting the due reminder must
  // not also silence the handover.
  'Tasks assigned to you', 'Showings scheduled for you',
  'Campaign finished', 'Campaign problems',
];

const CATEGORIES = [...SHARED, ...DESK_ONLY];
/** CRM: every shared category on three channels, less the one unsupported pair. */
const CRM_LIVE_PAIRS = SHARED.length * 3 - UNSUPPORTED_PAIRS;
/** Transaction Desk: every category, shared and its own, on the same three channels. */
const LIVE_PAIRS = CATEGORIES.length * 3 - UNSUPPORTED_PAIRS;

/**
 * One cell of the matrix.
 *
 * Matched on a PREFIX rather than an exact name, because a cell with no sender carries a longer
 * label — "… — coming soon, nothing sends this yet" — which is deliberate (a screen reader should
 * say why the control is inert) and which an exact match silently never finds. An earlier version
 * of this helper used `exact: true` and reported a disabled cell as "element not found", which
 * reads like a missing control rather than a mismatched selector.
 */
const cell = (page: Page, category: string, channel: string) =>
  // No escaping needed: every category and channel name here is plain words and spaces.
  page.getByRole('checkbox', { name: new RegExp(`^${category} by ${channel}(\\s|$)`) });

/**
 * Put every switchable cell back on before each test.
 *
 * These tests store real opt-outs, and an opt-out outlives the test that made it — without this the
 * second run fails on assertions that passed the first, which reads as a broken application rather
 * than a dirty database. Done through the UI on purpose: it is the same path a person takes, so the
 * reset cannot pass while the feature it relies on is broken.
 */
async function resetPreferences(page: Page): Promise<void> {
  await page.goto('/crm/notifications');
  const switchable = page.locator('table input[type="checkbox"]:not([disabled])');
  await expect(switchable.first()).toBeVisible();

  let changed = false;
  for (let i = 0; i < await switchable.count(); i += 1) {
    if (!(await switchable.nth(i).isChecked())) { await switchable.nth(i).check(); changed = true; }
  }
  if (changed) {
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText(/saved/i)).toBeVisible({ timeout: 10_000 });
    await page.reload();
  }
}

test.beforeEach(async ({ page }) => {
  await signIn(page, 'agent');
  await resetPreferences(page);
});

test('the CRM shows only what the CRM can raise', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Notification Preferences' })).toBeVisible();
  for (const label of SHARED) {
    await expect(page.getByRole('row').filter({ hasText: label })).toHaveCount(1);
  }
  // The five transaction-only ones must NOT be offered here. A switch for an event that cannot
  // reach you on this side of the product is a puzzle, not a preference.
  for (const label of DESK_ONLY) {
    await expect(page.getByRole('row').filter({ hasText: label })).toHaveCount(0);
  }
  for (const channel of ['In-app', 'Email', 'Push']) {
    await expect(page.getByRole('columnheader', { name: channel })).toBeVisible();
  }
});

test('the Transaction Desk shows every category, including its own five', async ({ page }) => {
  await page.goto('/desk/notifications');
  await expect(page.getByRole('heading', { name: 'Notification Preferences' })).toBeVisible();
  for (const label of CATEGORIES) {
    await expect(page.getByRole('row').filter({ hasText: label })).toHaveCount(1);
  }
});

test('everything that can be switched starts on', async ({ page }) => {
  // Absence of a stored row means enabled. Nobody's notifications may go quiet because this
  // feature shipped.
  // Counted on the CRM screen, which `beforeEach` opens — so the expected number is the CRM's.
  // An unsupported pair renders no control at all, only the reason, so it is not in this count.
  const boxes = page.locator('table input[type="checkbox"]');
  await expect(boxes).toHaveCount(CRM_LIVE_PAIRS + PENDING_PAIRS);

  const switchable = page.locator('table input[type="checkbox"]:not([disabled])');
  await expect(switchable).toHaveCount(CRM_LIVE_PAIRS);
  for (let i = 0; i < CRM_LIVE_PAIRS; i += 1) await expect(switchable.nth(i)).toBeChecked();

  // And the Desk screen still offers the full set, so nothing was lost by the split.
  await page.goto('/desk/notifications');
  await expect(page.locator('table input[type="checkbox"]:not([disabled])')).toHaveCount(LIVE_PAIRS);
});

test('nothing is badged Soon any more — every route has a sender', async ({ page }) => {
  /*
   * The end state. A control that moves implies it did something, so while a route had no sender its
   * switch was genuinely inoperable and said why. There are none left: the last three were the chat
   * mentions, which needed the mention feature built before there was an event to send.
   */
  await expect(page.locator('table input[type="checkbox"][disabled]')).toHaveCount(PENDING_PAIRS);
  await expect(page.locator('table').getByText('Soon', { exact: true })).toHaveCount(PENDING_PAIRS);
});

test('a route that makes no sense is not offered at all', async ({ page }) => {
  // Emailing somebody to tell them they have an email. Shown as a dash, with no control.
  await expect(cell(page, 'New inbox emails', 'Email')).toHaveCount(0);
  await expect(page.locator('table td').filter({ hasText: /^—$/ })).toHaveCount(UNSUPPORTED_PAIRS);
});

test('calendar reminders can be changed on every channel', async ({ page }) => {
  // All three now: email and push have long-standing senders, and in-app arrived with the dispatcher.
  for (const channel of ['In-app', 'Email', 'Push']) {
    await expect(cell(page, 'Calendar reminders', channel)).toBeEnabled();
  }
});

test('muting one channel survives a reload AND leaves the others alone', async ({ page }) => {
  /*
   * THE PROPERTY THE MIGRATION EXISTS FOR. Before the channel dimension, one switch meant push and
   * there was no way to say "email yes, push no".
   */
  await cell(page, 'Calendar reminders', 'Push').uncheck();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/saved/i)).toBeVisible({ timeout: 10_000 });

  await page.reload();
  await expect(cell(page, 'Calendar reminders', 'Push')).not.toBeChecked();
  await expect(cell(page, 'Calendar reminders', 'Email')).toBeChecked();

  // And the server agrees — the screen is not merely remembering its own state.
  const res = await apiGet(page, '/api/account/notification-preferences');
  const cats = (res.body as { categories: { key: string; enabled: Record<string, boolean> }[] }).categories;
  const calendar = cats.find((c) => c.key === 'calendar_reminders');
  expect(calendar?.enabled.push).toBe(false);
  expect(calendar?.enabled.email).toBe(true);

  // Put it back, so the suite can be run repeatedly without hand-resetting the database.
  await cell(page, 'Calendar reminders', 'Push').check();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/saved/i)).toBeVisible({ timeout: 10_000 });
});

test('one person’s choices do not reach another’s', async ({ page, context }) => {
  await cell(page, 'Calendar reminders', 'Push').uncheck();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/saved/i)).toBeVisible({ timeout: 10_000 });

  await context.clearCookies();
  await signIn(page, 'agent2');
  const res = await apiGet(page, '/api/account/notification-preferences');
  const cats = (res.body as { categories: { key: string; channels: Record<string, string>; enabled: Record<string, boolean> }[] }).categories;

  // Every deliverable route is still on for the other person.
  for (const c of cats) {
    for (const [channel, readiness] of Object.entries(c.channels)) {
      if (readiness !== 'unsupported') expect(c.enabled[channel]).toBe(true);
    }
  }
});
