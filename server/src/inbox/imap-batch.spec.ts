import { newMailLink, selectSyncBatch, shouldNotifyNewMail } from './imap-sync.service';

/**
 * The batch a poll pulls from a mailbox.
 *
 * This exists because of a silent data-loss bug. The cap used to be `uids.slice(-MAX)` — the
 * NEWEST messages — while `last_uid` was then advanced to the highest UID handled. Every message
 * below that window was skipped permanently: the next poll searches from `last_uid + 1` and never
 * looks down again. Nothing was logged and no sync_error was recorded, so an account reported a
 * clean sync while a client's email was quietly dropped. The first sync of an account reaches back
 * two weeks, so any mailbox averaging four messages a day hit it immediately.
 *
 * The whole suite passed with that bug in place. These are the assertions that would not have.
 */
describe('selectSyncBatch', () => {
  const MAX = 50;

  it('takes the OLDEST of a backlog, so later polls can collect the rest', () => {
    const uids = Array.from({ length: 200 }, (_, i) => 1000 + i); // 1000..1199

    const batch = selectSyncBatch(uids, null, MAX);

    expect(batch).toHaveLength(MAX);
    expect(batch[0]).toBe(1000);              // starts at the oldest unseen message
    expect(batch[batch.length - 1]).toBe(1049);
    // The regression itself: the newest-first version returned 1150..1199 and stranded 1000..1149.
    expect(batch).not.toContain(1199);
  });

  it('drains a backlog across successive polls without skipping anything', () => {
    const all = Array.from({ length: 120 }, (_, i) => 1 + i); // 1..120
    const seen: number[] = [];
    let lastUid: number | null = null;

    // Each poll takes a batch and advances last_uid to the end of what it handled.
    for (let poll = 0; poll < 10; poll += 1) {
      const batch = selectSyncBatch(all, lastUid, MAX);
      if (batch.length === 0) break;
      seen.push(...batch);
      lastUid = batch[batch.length - 1];
    }

    // Every message arrives exactly once. Under the old behaviour `seen` held only the newest 50.
    expect(seen).toEqual(all);
    expect(new Set(seen).size).toBe(all.length);
  });

  it('ignores anything at or below last_uid', () => {
    expect(selectSyncBatch([1, 2, 3, 4, 5], 3, MAX)).toEqual([4, 5]);
    expect(selectSyncBatch([1, 2, 3], 3, MAX)).toEqual([]);
  });

  it('sorts a server response that comes back out of order', () => {
    // IMAP does not promise ordering, and slicing an unsorted list would take arbitrary messages.
    expect(selectSyncBatch([9, 3, 7, 1, 5], null, 3)).toEqual([1, 3, 5]);
  });

  it('handles an empty, null or undefined SEARCH result', () => {
    expect(selectSyncBatch([], null, MAX)).toEqual([]);
    expect(selectSyncBatch(null, null, MAX)).toEqual([]);
    expect(selectSyncBatch(undefined, 10, MAX)).toEqual([]);
  });

  it('returns everything when the backlog is smaller than the cap', () => {
    expect(selectSyncBatch([4, 5, 6], 3, MAX)).toEqual([4, 5, 6]);
  });
});

/**
 * Which completed syncs are worth telling somebody about.
 *
 * The rule is a single boolean inside a method that cannot run without a live IMAP server, so it is
 * exported and tested here instead — the same reason `selectSyncBatch` above is. Without this, the
 * only thing standing between a person and a notification per mailbox would be an untested `&&`.
 */
describe('shouldNotifyNewMail', () => {
  const box = (over: Partial<{ user_id: number | null; is_default: boolean }> = {}) =>
    ({ user_id: 7, is_default: true, ...over });

  it('notifies for the primary mailbox when mail actually arrived', () => {
    expect(shouldNotifyNewMail(box(), 1)).toBe(true);
    expect(shouldNotifyNewMail(box(), 40)).toBe(true);
  });

  it('says nothing for a mailbox that is not the primary one', () => {
    // THE REGRESSION. A person with a working address, a shared enquiries box and an archive
    // address got three notifications a poll; the one that mattered was the hardest to find.
    expect(shouldNotifyNewMail(box({ is_default: false }), 12)).toBe(false);
  });

  it('says nothing when the poll found nothing', () => {
    expect(shouldNotifyNewMail(box(), 0)).toBe(false);
    // Not even for the primary mailbox — an empty poll is not news.
    expect(shouldNotifyNewMail(box({ is_default: true }), 0)).toBe(false);
  });

  it('says nothing for a brokerage mailbox, which belongs to no one to tell', () => {
    expect(shouldNotifyNewMail(box({ user_id: null }), 5)).toBe(false);
    expect(shouldNotifyNewMail(box({ user_id: null, is_default: true }), 5)).toBe(false);
  });

  it('treats user 0 as a real owner rather than as absent', () => {
    // `account.user_id &&` was the previous shape, and it would have dropped this one silently.
    expect(shouldNotifyNewMail(box({ user_id: 0 }), 3)).toBe(true);
  });
});

describe('where the new-mail notification points', () => {
  /**
   * It pointed at `/crm/inbox` and stopped there, so following a notification meant opening the
   * mailbox and then hunting for the message it was about.
   */
  it('links to the message itself when exactly one arrived', () => {
    expect(newMailLink(1, 4821)).toBe('/crm/inbox?message=4821');
  });

  it('links to the mailbox for a batch, because there is no single message to open', () => {
    // "You have 3 new emails" — choosing one of the three would be a guess dressed as a destination.
    expect(newMailLink(3, 4821)).toBe('/crm/inbox');
    expect(newMailLink(12, 99)).toBe('/crm/inbox');
  });

  it('falls back to the mailbox when no id was captured', () => {
    // A concurrent poll can win the insert, leaving a count with no row of this run's own.
    expect(newMailLink(1, null)).toBe('/crm/inbox');
  });

  it('refuses a nonsensical id rather than building a link that cannot resolve', () => {
    expect(newMailLink(1, 0)).toBe('/crm/inbox');
    expect(newMailLink(1, -5)).toBe('/crm/inbox');
    expect(newMailLink(1, 1.5)).toBe('/crm/inbox');
  });

  it('never produces a link for a run that stored nothing', () => {
    expect(newMailLink(0, null)).toBe('/crm/inbox');
  });
});
