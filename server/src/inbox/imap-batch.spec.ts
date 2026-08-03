import { selectSyncBatch } from './imap-sync.service';

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
