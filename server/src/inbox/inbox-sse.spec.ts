import { Controller, INestApplication, Sse } from '@nestjs/common';
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import * as http from 'node:http';
import { Observable } from 'rxjs';
import { RequestLogInterceptor } from '../observability/request-log.interceptor';
import { InboxEventsService } from './inbox-events.service';

/**
 * SERVER-SENT EVENTS SURVIVE THE GLOBAL REQUEST-LOG INTERCEPTOR.
 *
 * ================================================================================================
 * THE BUG THIS EXISTS FOR. Nest wraps the interceptor chain in rxjs `defer()`, so an interceptor's
 * body runs when the returned observable is SUBSCRIBED, not when the route is invoked. For an
 * ordinary route that is immediately and the distinction never shows. For an SSE route Nest does:
 *
 *     stream.pipe(res);        // writeHead(200) + flushHeaders() -- headers are SENT
 *     result.subscribe(...);   // <- only now does the interceptor body run
 *
 * `RequestLogInterceptor` called `res.setHeader('X-Request-Id', ...)` in that body. It therefore
 * threw ERR_HTTP_HEADERS_SENT, rxjs delivered it as the stream's error, and Nest wrote
 * `event: error / data: Cannot set headers after they are sent to the client` and closed the
 * connection. EVERY SSE ENDPOINT WAS DEAD ON ARRIVAL, and the message named the symptom.
 *
 * No unit test could have caught it: the failure needs Nest's real HTTP pipeline with a global
 * interceptor registered. So this test boots one.
 * ================================================================================================
 *
 * IT ASSERTS THE PROPERTY, NOT THE FIX. What matters is that a stream opens, stays open, and
 * delivers events — a future interceptor that touches the response late would fail here for its own
 * reasons, which is the point of testing through the real pipeline rather than mocking it.
 */

/** A stand-in for the Inbox controller's route: the same decorator, the same event service. */
@Controller('probe')
class ProbeController {
  constructor(private readonly events: InboxEventsService) {}

  /** Fixed to user 7 — authentication is not what this file tests. See `inbox-realtime.spec.ts`. */
  @Sse('stream')
  stream(): Observable<{ type: string; data: string }> {
    return this.events.stream(7);
  }
}

/** Read an SSE response, splitting on the blank line that separates frames. */
function readStream(url: string, onFrame: (frame: string) => void): { close: () => void; opened: Promise<number> } {
  let resolveOpened: (n: number) => void = () => {};
  const opened = new Promise<number>((r) => { resolveOpened = r; });
  const req = http.get(url, { headers: { Accept: 'text/event-stream' } }, (res) => {
    resolveOpened(res.statusCode ?? 0);
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i).trim();
        buf = buf.slice(i + 2);
        if (frame) onFrame(frame);
      }
    });
  });
  req.on('error', () => { /* closing the socket is how this test ends a stream */ });
  return { close: () => req.destroy(), opened };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('an SSE endpoint works with the global request-log interceptor registered', () => {
  jest.setTimeout(30_000);

  let app: INestApplication;
  let events: InboxEventsService;
  let base: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        InboxEventsService,
        Reflector,
        // The whole point: registered globally, exactly as `AppModule` registers it.
        { provide: APP_INTERCEPTOR, useClass: RequestLogInterceptor },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
    events = app.get(InboxEventsService);
    base = await app.getUrl();
    // `getUrl` reports the v6 wildcard on some hosts; the loopback literal is what connects.
    base = base.replace('[::1]', '127.0.0.1').replace('0.0.0.0', '127.0.0.1');
  });

  afterAll(async () => { await app?.close(); });

  it('opens, stays open, and never sends an error frame', async () => {
    const frames: string[] = [];
    const s = readStream(`${base}/probe/stream`, (f) => frames.push(f));
    expect(await s.opened).toBe(200);

    await wait(1500);
    // The regression this file is named for produced exactly one frame: `event: error`.
    expect(frames.filter((f) => f.includes('event: error'))).toEqual([]);
    s.close();
  });

  it('delivers an event to the subscriber it names', async () => {
    const frames: string[] = [];
    const s = readStream(`${base}/probe/stream`, (f) => frames.push(f));
    expect(await s.opened).toBe(200);
    await wait(300);

    events.newMail(7, 4242, 2);
    await wait(800);

    const inbox = frames.filter((f) => f.includes('event: inbox'));
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toContain('"accountId":4242');
    expect(inbox[0]).toContain('"fetched":2');
    s.close();
  });

  it('delivers nothing for another user, and nothing for an empty sync', async () => {
    const frames: string[] = [];
    const s = readStream(`${base}/probe/stream`, (f) => frames.push(f));
    expect(await s.opened).toBe(200);
    await wait(300);

    events.newMail(8, 1, 5);      // somebody else
    events.newMail(null, 2, 5);   // a mailbox with no owner
    events.newMail(7, 3, 0);      // this user, but nothing arrived
    await wait(800);

    expect(frames.filter((f) => f.includes('event: inbox'))).toEqual([]);
    s.close();
  });

  /**
   * ONE EVENT, ONE FRAME PER OPEN STREAM — not one per event per reconnect.
   *
   * A stream that replayed history on reconnect would show the same message twice in the Inbox
   * list, which is the "no duplicate messages" property stated as something a test can fail on.
   */
  it('sends each event exactly once, and replays nothing to a reconnecting client', async () => {
    const first: string[] = [];
    const a = readStream(`${base}/probe/stream`, (f) => first.push(f));
    expect(await a.opened).toBe(200);
    await wait(300);

    events.newMail(7, 100, 1);
    await wait(600);
    expect(first.filter((f) => f.includes('event: inbox'))).toHaveLength(1);

    // The client goes away and comes back, as EventSource does after a network drop.
    a.close();
    await wait(300);

    const second: string[] = [];
    const b = readStream(`${base}/probe/stream`, (f) => second.push(f));
    expect(await b.opened).toBe(200);
    await wait(800);

    // Nothing is replayed: the event that fired while it was disconnected is gone, which is what
    // makes the browser's own refetch — not this channel — the source of truth for the list.
    expect(second.filter((f) => f.includes('event: inbox'))).toEqual([]);

    // And the reconnected stream is live: a NEW event reaches it.
    events.newMail(7, 101, 1);
    await wait(600);
    expect(second.filter((f) => f.includes('event: inbox'))).toHaveLength(1);
    b.close();
  });

  it('serves two subscribers of the same user independently', async () => {
    const one: string[] = [];
    const two: string[] = [];
    const a = readStream(`${base}/probe/stream`, (f) => one.push(f));
    const b = readStream(`${base}/probe/stream`, (f) => two.push(f));
    expect(await a.opened).toBe(200);
    expect(await b.opened).toBe(200);
    await wait(300);

    events.newMail(7, 55, 3);
    await wait(800);

    // Two tabs, one event each — not one tab getting both.
    expect(one.filter((f) => f.includes('event: inbox'))).toHaveLength(1);
    expect(two.filter((f) => f.includes('event: inbox'))).toHaveLength(1);
    a.close(); b.close();
  });
});
