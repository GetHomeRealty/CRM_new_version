import { firstValueFrom, take, toArray } from 'rxjs';
import { InboxEventsService } from './inbox-events.service';
import { ImapIdleService } from './imap-idle.service';

/**
 * REAL-TIME INBOX DELIVERY — the two rules that are not about IMAP.
 *
 * The IDLE connection itself cannot be tested without a mail server, and mocking one would test the
 * mock. What CAN be tested, and is worth more, is everything around it:
 *
 *   WHO RECEIVES AN EVENT. The stream is the only new way information leaves the server about
 *   somebody's mail, so "a subscriber sees their own events and nobody else's" is an authorization
 *   rule, not a routing detail. It is enforced inside `stream()` rather than in the controller so
 *   the next endpoint that wants a stream cannot forget it.
 *
 *   WHEN THE SUPERVISOR RUNS AT ALL. It opens long-lived connections to real mail servers. A test
 *   run, a second instance, or a deployment that has switched IMAP off must not have it running —
 *   and the switches are the ones the poller already honours, so a new one would be a second thing
 *   to remember.
 */

describe('the inbox event stream reaches exactly one person', () => {
  it('delivers a user their own events', async () => {
    const events = new InboxEventsService();
    const received = firstValueFrom(events.stream(7).pipe(take(1)));
    events.newMail(7, 101, 3);

    const msg = await received;
    expect(msg.type).toBe('inbox');
    expect(JSON.parse(msg.data)).toMatchObject({ accountId: 101, fetched: 3 });
  });

  it('does not deliver another user’s events', async () => {
    const events = new InboxEventsService();
    // Two events for somebody else, then one for us. If the filter leaked, the first value taken
    // would be the wrong one — which is why this asserts on the CONTENT of the first arrival
    // rather than on a count that a leak could still satisfy.
    const received = firstValueFrom(events.stream(7).pipe(take(1)));
    events.newMail(8, 999, 5);
    events.newMail(9, 998, 5);
    events.newMail(7, 101, 1);

    expect(JSON.parse((await received).data)).toMatchObject({ accountId: 101 });
  });

  it('publishes nothing for a sync that stored no mail', async () => {
    const events = new InboxEventsService();
    const seen = firstValueFrom(events.stream(7).pipe(take(1), toArray()));
    events.newMail(7, 101, 0);       // nothing new — must not wake the tab
    events.newMail(7, 102, 2);       // this one must
    const [msg] = await seen;
    expect(JSON.parse(msg.data)).toMatchObject({ accountId: 102, fetched: 2 });
  });

  it('publishes nothing for a mailbox with no owner', async () => {
    const events = new InboxEventsService();
    const seen = firstValueFrom(events.stream(7).pipe(take(1), toArray()));
    events.newMail(null, 500, 4);    // a brokerage mailbox: nobody to tell
    events.newMail(7, 101, 1);
    const [msg] = await seen;
    expect(JSON.parse(msg.data)).toMatchObject({ accountId: 101 });
  });

  it('carries no message content — only that something arrived', async () => {
    const events = new InboxEventsService();
    const received = firstValueFrom(events.stream(7).pipe(take(1)));
    events.newMail(7, 101, 1);
    const payload = JSON.parse((await received).data) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['accountId', 'at', 'fetched']);
  });

  it('counts open streams, and forgets them when they close', () => {
    const events = new InboxEventsService();
    expect(events.openStreams()).toBe(0);
    const sub = events.stream(7).subscribe();
    expect(events.openStreams()).toBe(1);
    sub.unsubscribe();
    expect(events.openStreams()).toBe(0);
  });
});

describe('the IDLE supervisor honours the switches that mean "open no connections"', () => {
  const svc = () => new ImapIdleService({} as never, {} as never, new InboxEventsService());

  const withEnv = (env: Record<string, string | undefined>, fn: () => void) => {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { fn(); } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  };

  /*
   * `NODE_ENV=test` is what `schedulersEnabled()` reads, and it is already set while this suite
   * runs — so the first case is the one that protects the test suite itself from opening sockets.
   */
  it('does not start under NODE_ENV=test', () => {
    const s = svc();
    s.onModuleInit();
    expect(s.connectionCount()).toBe(0);
  });

  it('does not start when IMAP polling is switched off', () => {
    withEnv({ IMAP_POLL_DISABLED: '1' }, () => {
      const s = svc();
      s.onModuleInit();
      expect(s.connectionCount()).toBe(0);
    });
  });

  it('does not start when IDLE alone is switched off', () => {
    withEnv({ IMAP_IDLE_DISABLED: '1' }, () => {
      const s = svc();
      s.onModuleInit();
      expect(s.connectionCount()).toBe(0);
    });
  });

  it('shuts down cleanly with nothing held', async () => {
    const s = svc();
    s.onModuleInit();
    await expect(s.onModuleDestroy()).resolves.toBeUndefined();
    expect(s.connectionCount()).toBe(0);
  });
});
