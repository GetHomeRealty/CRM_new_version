import { firstValueFrom, take, toArray } from 'rxjs';
import { NotificationEventsService } from './notification-events.service';

/**
 * The live stream that replaces waiting for the next poll.
 *
 * TWO PROPERTIES CARRY THE WHOLE DESIGN, and both are asserted here.
 *
 * ROUTING IS AUTHORIZATION. The stream is filtered by user id inside the service, at the single
 * point every subscriber passes through — not in the controller, where the next endpoint wanting a
 * stream could forget it. A subscriber must receive an event if and only if it names them.
 *
 * THE EVENT IS A NUDGE, NOT A RECORD. It carries no notification content and creates nothing; the
 * browser refetches through the ordinary endpoint, which already applies every ownership rule. That
 * is what makes SSE incapable of duplicating anything — a reconnect, a repeated event and the
 * fallback poll all resolve to the same refetch of the same rows.
 */

describe('who receives a notification event', () => {
  it('delivers to the user it names', async () => {
    const events = new NotificationEventsService();
    const received = firstValueFrom(events.stream(7).pipe(take(1)));

    events.raised(7, 'lead_assigned');

    const e = await received;
    expect(e.type).toBe('notification');
    expect(JSON.parse(e.data).category).toBe('lead_assigned');
  });

  it('does NOT deliver another user\'s event', async () => {
    const events = new NotificationEventsService();
    const seen: unknown[] = [];
    const sub = events.stream(7).subscribe((e) => seen.push(e));

    // User 8's notification must not reach user 7's stream. This is the cross-user check.
    events.raised(8, 'lead_assigned');
    events.raised(9, 'campaign_completed');
    await new Promise((r) => setTimeout(r, 10));

    expect(seen).toEqual([]);
    sub.unsubscribe();
  });

  it('gives each user only their own events when both are listening', async () => {
    const events = new NotificationEventsService();
    const mine: string[] = [];
    const theirs: string[] = [];
    const a = events.stream(7).subscribe((e) => mine.push(JSON.parse(e.data).category));
    const b = events.stream(8).subscribe((e) => theirs.push(JSON.parse(e.data).category));

    events.raised(7, 'lead_assigned');
    events.raised(8, 'task_assigned');
    events.raised(7, 'showing_created');
    await new Promise((r) => setTimeout(r, 10));

    expect(mine).toEqual(['lead_assigned', 'showing_created']);
    expect(theirs).toEqual(['task_assigned']);
    a.unsubscribe(); b.unsubscribe();
  });

  it('drops an event with no recipient rather than broadcasting it', async () => {
    const events = new NotificationEventsService();
    const seen: unknown[] = [];
    const sub = events.stream(7).subscribe((e) => seen.push(e));

    // A brokerage-owned record has no user to tell. Dropped in the service so no caller can forget.
    events.raised(null, 'lead_new');
    events.raised(undefined, 'lead_new');
    events.raised(0, 'lead_new');
    await new Promise((r) => setTimeout(r, 10));

    expect(seen).toEqual([]);
    sub.unsubscribe();
  });
});

describe('the payload', () => {
  it('carries no notification content — only a category and a time', async () => {
    /*
     * Deliberate: if the stream carried titles or bodies it would become a second way to read
     * somebody's notifications, with its own authorization to get wrong. The browser refetches
     * through the endpoint that already has those rules.
     */
    const events = new NotificationEventsService();
    const received = firstValueFrom(events.stream(7).pipe(take(1)));
    events.raised(7, 'lead_assigned');

    const payload = JSON.parse((await received).data) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['at', 'category']);
    expect(payload).not.toHaveProperty('title');
    expect(payload).not.toHaveProperty('body');
  });
});

describe('reconnecting', () => {
  it('a new stream receives later events, and the old one stops', async () => {
    // What EventSource does on a dropped connection: unsubscribe, resubscribe. Neither the service
    // nor the database keeps per-connection state, so a reconnect replays nothing and loses nothing
    // beyond the gap — which the browser's fallback poll covers.
    const events = new NotificationEventsService();
    const before: string[] = [];
    const first = events.stream(7).subscribe((e) => before.push(JSON.parse(e.data).category));

    events.raised(7, 'one');
    await new Promise((r) => setTimeout(r, 5));
    first.unsubscribe();

    events.raised(7, 'missed-while-disconnected');

    const after = firstValueFrom(events.stream(7).pipe(take(1)));
    events.raised(7, 'two');

    expect(before).toEqual(['one']);
    expect(JSON.parse((await after).data).category).toBe('two');
  });

  it('counts open streams up and down, so a leak would be visible', async () => {
    const events = new NotificationEventsService();
    expect(events.openStreams()).toBe(0);

    const sub = events.stream(7).subscribe();
    expect(events.openStreams()).toBe(1);

    sub.unsubscribe();
    expect(events.openStreams()).toBe(0);
  });

  it('one subscriber unsubscribing does not disturb another', async () => {
    const events = new NotificationEventsService();
    const kept: string[] = [];
    const a = events.stream(7).subscribe();
    const b = events.stream(7).subscribe((e) => kept.push(JSON.parse(e.data).category));

    a.unsubscribe();
    events.raised(7, 'still-listening');
    await new Promise((r) => setTimeout(r, 10));

    expect(kept).toEqual(['still-listening']);
    b.unsubscribe();
  });
});

describe('duplicate events', () => {
  it('are delivered as-is and cannot create rows — the browser refetches either way', async () => {
    /*
     * The same occurrence arriving twice (a retried job, a reconnect, a poll landing together with
     * an event) produces two nudges and one refetch result. Nothing here writes, so there is no
     * second record to create — which is why SSE and the fallback poll cannot double up.
     */
    const events = new NotificationEventsService();
    const got = firstValueFrom(events.stream(7).pipe(take(2), toArray()));

    events.raised(7, 'lead_assigned');
    events.raised(7, 'lead_assigned');

    const both = await got;
    expect(both).toHaveLength(2);
    expect(both.every((e) => e.type === 'notification')).toBe(true);
  });
});
