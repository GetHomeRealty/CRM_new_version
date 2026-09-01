import { readFileSync } from 'fs';
import { join } from 'path';
import { EventEmitter } from 'events';
import { Pool } from 'pg';

/**
 * A Postgres hiccup must not restart the API.
 *
 * THE DEFECT. `main.ts` built the session store's `pg.Pool` and never listened for its `error`
 * event. That pool emits on behalf of IDLE clients — a Postgres restart or failover, an admin
 * `pg_terminate_backend`, an `idle_in_transaction_session_timeout`, a network blip. There is no
 * query in flight to reject and no `await` anywhere to catch it, so the event has nowhere to go.
 *
 * EventEmitter THROWS an `error` event that has no listener. That lands in the `uncaughtException`
 * handler, which shuts the process down with code 1 — correct in general, since an uncaught throw
 * means unknown state — and the supervisor starts a new one. So a healthy API was being recycled
 * by an event it had already recovered from: the pool simply discards the dead client and opens
 * another on the next request.
 *
 * These tests pin the mechanism rather than the symptom, because the symptom is a restart count and
 * a restart count proves nothing about why.
 */

describe('an idle-client error from the session pool', () => {
  it('THROWS when nothing is listening — the crash being fixed', () => {
    // The plain EventEmitter contract, shown directly, because everything below depends on it.
    const bare = new EventEmitter();
    expect(() => bare.emit('error', new Error('terminating connection due to administrator command')))
      .toThrow('terminating connection due to administrator command');
  });

  it('is contained once a listener is attached', () => {
    const bare = new EventEmitter();
    const seen: string[] = [];
    bare.on('error', (e: Error) => seen.push(e.message));

    expect(() => bare.emit('error', new Error('connection terminated unexpectedly'))).not.toThrow();
    expect(seen).toEqual(['connection terminated unexpectedly']);
  });

  it('holds for a real pg.Pool, which is where it actually happens', () => {
    /*
     * Constructed but never connected: `new Pool()` opens nothing on its own, so this touches no
     * database. What matters is that a Pool IS an EventEmitter and inherits the throw-if-unheard
     * rule — the reason an unlistened pool can take the process down.
     */
    const pool = new Pool({ connectionString: 'postgresql://unused:unused@127.0.0.1:1/none' });
    try {
      expect(pool).toBeInstanceOf(EventEmitter);
      expect(pool.listenerCount('error')).toBe(0);
      expect(() => pool.emit('error', new Error('idle client died'))).toThrow('idle client died');

      const caught: string[] = [];
      pool.on('error', (e: Error) => caught.push(e.message));
      expect(() => pool.emit('error', new Error('idle client died'))).not.toThrow();
      expect(caught).toEqual(['idle client died']);
    } finally {
      void pool.end().catch(() => undefined);
    }
  });
});

describe('main.ts registers the listener', () => {
  const main = readFileSync(join(__dirname, '..', 'main.ts'), 'utf8');

  /*
   * Read from the source because the pool is created inside `bootstrap()`, which cannot be invoked
   * in a unit test without standing up the entire application, a port and a database. The tests
   * above prove what the listener does; this one proves it is there — which is the part a future
   * edit could silently remove, since nothing fails until Postgres next drops a connection.
   */
  it('attaches an error handler to the session pool', () => {
    expect(main).toMatch(/sessionPool\.on\(\s*'error'/);
  });

  it('attaches it before the pool is handed to the session middleware', () => {
    // Ordering matters: between construction and the first use there must be no window in which
    // the pool is live and unlistened.
    const attached = main.indexOf("sessionPool.on('error'");
    const handedOver = main.indexOf('new PgStore({ pool: sessionPool');
    expect(attached).toBeGreaterThan(-1);
    expect(handedOver).toBeGreaterThan(-1);
    expect(attached).toBeLessThan(handedOver);
  });

  it('logs the error rather than discarding it', () => {
    // Silence would trade a restart loop for an invisible database problem. A real outage must
    // still be loud in the log.
    const block = main.slice(main.indexOf("sessionPool.on('error'"), main.indexOf("sessionPool.on('error'") + 400);
    expect(block).toMatch(/poolLog\.error|logger\.error|\.error\(/);
  });

  it('does not exit or rethrow from the handler', () => {
    const block = main.slice(main.indexOf("sessionPool.on('error'"), main.indexOf("sessionPool.on('error'") + 400);
    expect(block).not.toMatch(/process\.exit|throw /);
  });
});
