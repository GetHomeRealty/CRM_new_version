import { Injectable } from '@nestjs/common';
import { Observable, Subject, filter, map } from 'rxjs';

/**
 * "Something changed in your Inbox" — delivered to the browser as it happens.
 *
 * WHY THIS EXISTS. The Inbox was refreshed by two polls stacked on top of each other: the server
 * polled IMAP every sixty seconds, and the browser polled the API on its own timer. A message could
 * therefore sit unseen for the sum of the two. `ImapIdleService` removes the first delay by holding
 * an IMAP connection open; this removes the second by telling the browser rather than waiting to be
 * asked.
 *
 * SERVER-SENT EVENTS, NOT A WEBSOCKET, and the choice is not incidental. This traffic is entirely
 * one-way — the server says "new mail", the browser refetches through the API it already uses — so a
 * bidirectional protocol would be machinery without a purpose. SSE is plain HTTP: it needs no
 * upgrade handshake, no proxy configuration, no second authentication path (the session cookie
 * applies as it does everywhere else), and `EventSource` reconnects by itself when a connection
 * drops, which on a laptop that sleeps is the common case rather than the exception.
 *
 * ================================================================================================
 * IN-PROCESS ONLY, DELIBERATELY.
 *
 * There is no Redis in this deployment — `RedisService.enabled()` is false in production — so this
 * is a plain in-memory Subject. On a single instance that is complete: the process that syncs the
 * mailbox is the process holding the browser's connection.
 *
 * ON SEVERAL INSTANCES a client connected to instance A would not hear an event raised on instance
 * B. That is survivable and not silent: the browser keeps its own polling timer as a fallback, so
 * the worst case is the delay it has today. Making it exact across instances means a Redis pub/sub
 * fan-out, which is a change to make when there IS a Redis, not before — the same reasoning
 * `RedisService` itself is built on.
 * ================================================================================================
 *
 * EVENTS CARRY NO MAIL. Only a user id, an account id and a count. The browser refetches through
 * the normal Inbox endpoint, which already applies every ownership rule — so this channel cannot
 * become a second way to read a message, and a subscriber who should not see a mailbox learns
 * nothing from an event about it beyond the fact that they were never sent one.
 */

/** What the browser receives. `type` is the SSE event name; the rest is the payload. */
export interface InboxEvent {
  userId: number;
  accountId: number;
  /** How many messages the sync stored. Zero is not published — see `newMail`. */
  fetched: number;
  at: string;
}

@Injectable()
export class InboxEventsService {
  /**
   * One Subject for every subscriber, rather than one per user.
   *
   * A user may have the Inbox open in several tabs, and each needs its own stream — a shared
   * Subject would be fine for that, but the per-subscriber filter below is what keeps the routing
   * decision in one place: a subscriber receives an event if and only if the event names them.
   */
  private readonly bus = new Subject<InboxEvent>();

  /** How many streams are open. Exposed for the health endpoint rather than for logic. */
  private open = 0;

  /**
   * The stream for one user, as the SSE endpoint returns it.
   *
   * FILTERED BY USER ID HERE, at the one point every subscriber passes through. The alternative —
   * letting the controller decide — would mean the authorization lived beside the transport and
   * could be forgotten by the next endpoint that wanted a stream.
   */
  stream(userId: number): Observable<{ type: string; data: string }> {
    this.open += 1;
    return new Observable<{ type: string; data: string }>((subscriber) => {
      const sub = this.bus
        .pipe(
          filter((e) => e.userId === userId),
          map((e) => ({ type: 'inbox', data: JSON.stringify({ accountId: e.accountId, fetched: e.fetched, at: e.at }) })),
        )
        .subscribe(subscriber);

      return () => {
        this.open = Math.max(0, this.open - 1);
        sub.unsubscribe();
      };
    });
  }

  /**
   * Announce that a sync stored new mail for somebody.
   *
   * NOTHING IS PUBLISHED FOR AN EMPTY SYNC. A poll that finds nothing is the overwhelmingly common
   * case, and an event for it would wake every open tab to refetch a list that has not changed —
   * which is the cost this whole mechanism exists to avoid, reintroduced from the other end.
   *
   * A brokerage mailbox has no owner (`user_id` null) and therefore no one to tell; those are
   * dropped here rather than at the call site, so a future caller cannot forget.
   */
  newMail(userId: number | null, accountId: number, fetched: number): void {
    if (!userId || fetched <= 0) return;
    this.bus.next({ userId, accountId, fetched, at: new Date().toISOString() });
  }

  /** Open stream count, for `/api/health`. */
  openStreams(): number {
    return this.open;
  }
}
