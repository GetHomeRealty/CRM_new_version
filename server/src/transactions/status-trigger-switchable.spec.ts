import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAIL_EVENTS } from '../email/mail-event-registry';
import { NOTIFICATION_CATEGORIES } from '../notifications/notification-preference.service';

/**
 * TD-009 — the status-change trigger can be found and switched off.
 *
 * A trigger that cannot be turned off is TD-141's defect, and this one was heading for it. The
 * Triggers screen builds its Message triggers list by matching an event key against a set of
 * PREFIXES — `invoice.`, `document.`, `notice_of_sale.` and so on — and `transaction.status_changed`
 * matched none of them. It would have sent for ever, with no row on the page whose whole purpose is
 * turning things off, and QA's 2026-09-06 inventory of the live Triggers page duly lists every
 * message trigger except this one.
 *
 * `transaction.` COULD NOT SIMPLY BE ADDED as a prefix. Most keys under it are the nightly sweeps —
 * closing dates, condition deadlines, listing expiry, the lawyer chase — which the Scheduled section
 * describes in prose with no switch, deliberately, because each is governed per person in
 * Notification preferences. Admitting the prefix would list every one of them a second time as a
 * switch contradicting the paragraph above it. So the one reactive event under that prefix is named.
 *
 * THE TEMPLATE ROW NEEDS NO SEEDING, which is worth recording because it looks like it would:
 * `EmailTemplateService.index()` creates any registry event missing from the table before it lists
 * them, so opening the screen materialises the row.
 */

const PANEL = readFileSync(
  join(__dirname, '..', '..', '..', 'client', 'src', 'desk', 'DeskTriggersPanel.tsx'),
  'utf8',
).replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the status-change trigger appears on the Triggers screen (TD-009)', () => {
  it('is recognised as a Desk message trigger', () => {
    expect(PANEL).toContain("DESK_MESSAGE_EVENTS = new Set(['transaction.status_changed'])");
    expect(PANEL).toMatch(/DESK_MESSAGE_EVENTS\.has\(key\)/);
  });

  it('says when it fires, rather than falling back to the module name', () => {
    expect(PANEL).toContain("'transaction.status_changed': 'when a deal becomes firm, or ends'");
  });

  it('does not admit the scheduled sweeps as switches beside their own descriptions', () => {
    /*
     * The Scheduled section already describes closing dates and condition deadlines and states that
     * they carry no switch. Listing them again as switchable rows would contradict it on the same
     * page — so the prefix list must stay closed and the reactive events be named individually.
     */
    expect(PANEL).not.toContain("'transaction.'");
    for (const scheduled of [
      'transaction.closing_reminder',
      'transaction.condition_deadline_reminder',
      'transaction.listing_expiry_reminder',
    ]) {
      expect([scheduled, PANEL.includes(`'${scheduled}'`)]).toEqual([scheduled, false]);
    }
  });

  it('names an event the registry actually defines', () => {
    // A key that matched nothing would produce a filter that silently never matches — the failure
    // this test exists to prevent, in a different spelling.
    expect(Object.keys(MAIL_EVENTS)).toContain('transaction.status_changed');
  });

  it('is switchable per person as well, through its own notification category', () => {
    // Two independent switches, and both must exist: the brokerage-wide one on this screen, and the
    // per-agent one in Notification preferences.
    const category = NOTIFICATION_CATEGORIES.find((c) => c.key === 'status_change');
    expect(category).toBeDefined();
    expect(category?.channels).toEqual({ in_app: 'live', email: 'live', push: 'live' });
  });
});
