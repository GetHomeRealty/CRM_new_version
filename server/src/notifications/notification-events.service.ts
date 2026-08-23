import { Injectable } from '@nestjs/common';
import { Observable, Subject, filter, map } from 'rxjs';

/**
 * "You have a new notification" — pushed to the browser instead of waited for.
 *
 * WHY THIS EXISTS. The Notification Centre and the bell both polled on a sixty-second timer, so a
 * lead assigned at 10:00:05 could sit unseen until 10:01:05. The row was in the database the whole
 * time; nothing told the browser.
 *
 * MODELLED ON `InboxEventsService`, deliberately and almost line for line. That mechanism is
 * already proven in this deployment, its reconnect behaviour is understood, and a second transport
 * with different semantics would be two things to reason about instead of one. Server-Sent Events
 * rather than a WebSocket for the same reasons recorded there: the traffic is one-way, it is plain
 * HTTP so the session cookie authenticates it exactly as it does every other endpoint, and
 * `EventSource` reconnects by itself when a laptop wakes.
 *
 * ================================================================================================
 * THE EVENT CARRIES NO NOTIFICATION CONTENT. Only a user id, a category and a timestamp. The
 * browser refetches through `GET /api/notifications`, which already applies every ownership rule —
 * so this channel cannot become a second way to read somebody's notifications, and a subscriber
 * learns nothing from an event they were not sent.
 *
 * THAT IS ALSO WHY IT CANNOT DUPLICATE ANYTHING. The event is a nudge, not a record: it creates no
 * row, and the list the browser draws is always the API's answer. A reconnect, a duplicate event or
 * a polling tick landing on the same moment all produce the same refetch of the same rows, so SSE
 * and the fallback poll cannot disagree or double up.
 * ================================================================================================
 *
 * IN-PROCESS. One instance is complete: the process that dispatches the notification is the process
 * holding the browser's connection. Across several instances a client on A would not hear an event
 * raised on B — survivable, and not silent, because the browser keeps its polling timer as a
 * fallback and the worst case is the delay it has today. Making it exact across instances is a
 * Redis pub/sub fan-out, which is the same trade `InboxEventsService` records.
 */

/** What the browser receives. `type` is the SSE event name; the rest is the payload. */
export interface NotificationEvent {
  userId: number;
  /** The category key, so a client can decide whether it cares without refetching. */
  category: string;
  at: string;
}

@Injectable()
export class NotificationEventsService {
  private readonly bus = new Subject<NotificationEvent>();

  /** How many streams are open. For the health endpoint rather than for logic. */
  private open = 0;

  /**
   * The stream for one user, as the SSE endpoint returns it.
   *
   * FILTERED BY USER ID HERE, at the single point every subscriber passes through. Letting the
   * controller decide would put the authorization beside the transport, where the next endpoint
   * that wants a stream can forget it.
   */
  stream(userId: number): Observable<{ type: string; data: string }> {
    this.open += 1;
    return new Observable<{ type: string; data: string }>((subscriber) => {
      const sub = this.bus
        .pipe(
          filter((e) => e.userId === userId),
          map((e) => ({ type: 'notification', data: JSON.stringify({ category: e.category, at: e.at }) })),
        )
        .subscribe(subscriber);

      return () => {
        this.open = Math.max(0, this.open - 1);
        sub.unsubscribe();
      };
    });
  }

  /** Open stream count, for the health endpoint. */
  openStreams(): number {
    return this.open;
  }

  /**
   * Announce that somebody has a new in-app notification.
   *
   * Called from the dispatcher AFTER the row is committed, never before: an event that arrives
   * ahead of its row makes the browser refetch and find nothing, then sit on the stale list until
   * the next poll — the exact delay this removes, reintroduced.
   *
   * A request with no recipient is dropped here rather than at the call site, so a future caller
   * cannot forget.
   */
  raised(userId: number | null | undefined, category: string): void {
    if (!userId) return;
    this.bus.next({ userId, category, at: new Date().toISOString() });
  }
}
