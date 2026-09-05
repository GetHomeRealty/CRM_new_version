import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * TD-006 — the Inbox tells you to set your mailbox up on a screen you can open, and calls it one
 * thing.
 *
 * THE DEFECT. Two sentences on the same screen gave two different instructions: the header said to
 * mark a primary mailbox "in Integrations", the empty state said to connect IMAP "under My
 * Settings". Integrations is a TAB INSIDE SETTINGS, and an agent opening Settings is answered "No
 * access - You don't have permission to view this screen." So the half of the page an agent with no
 * mailbox reads first pointed them at a door that does not open for them.
 *
 * WHY MY SETTINGS IS THE RIGHT NAME rather than fixing the permission: the screen is registered
 * `open: true` in the router, every role reaches it, and it carries the same controls - the account
 * list, Make primary (`setMyDefaultMailAccount`), Test, Sync. Integrations is the same card shown to
 * the people who can also administer the brokerage. Nobody needs Settings to do what these two
 * sentences ask, so the instruction should not have named it.
 *
 * Read off the client, which is where the words are, and asserted on the file rather than through a
 * browser: the fault was in what the sentences SAY.
 */

const CLIENT = join(__dirname, '..', '..', '..', 'client', 'src');
const inbox = readFileSync(join(CLIENT, 'desk', 'InboxPage.tsx'), 'utf8');
const app = readFileSync(join(CLIENT, 'App.tsx'), 'utf8');
const account = readFileSync(join(CLIENT, 'desk', 'AccountSettingsPage.tsx'), 'utf8');

/** The sentences a person with no mailbox actually reads, without the comments around them. */
const prose = inbox
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ');

describe('the Inbox names one screen, and one that opens (TD-006)', () => {
  it('sends the reader to My Settings for the primary mailbox', () => {
    expect(prose).toContain('mark one primary in');
    expect(prose).toContain('My Settings');
  });

  it('no longer names Integrations, which is a Settings tab an agent cannot reach', () => {
    expect(prose).not.toContain('Integrations');
  });

  it('says the same thing in both places, and links both', () => {
    // The empty state already linked; the header was plain text naming a different screen.
    const links = prose.match(/navigate\(link\('account'\)\)/g) ?? [];
    expect(links.length).toBeGreaterThanOrEqual(2);
    expect(prose).toContain('Connect an email account with IMAP under');
  });

  it('points at a screen every role can open', () => {
    // `open: true` is what makes this true for an agent — the reason the old instruction failed.
    expect(app).toContain("{ screen: 'account', paths: [''], element: () => <AccountSettingsPage />, open: true }");
  });

  it('points at a screen that can actually do what the sentence asks', () => {
    // Naming a reachable screen that lacks the control would be the same defect, moved.
    expect(account).toContain('setMyDefaultMailAccount');
  });
});
