import { createShutdown } from './shutdown';

/**
 * The signal itself cannot be exercised on Windows — it terminates a Node process outright
 * instead of delivering SIGTERM — so what the signal triggers is tested directly here. These are
 * the properties that decide whether a deploy is a clean stop or a hang the supervisor has to
 * SIGKILL.
 */
describe('graceful shutdown', () => {
  const silent = { log: () => undefined, error: () => undefined } as never;

  const harness = (over: { appClose?: () => Promise<unknown>; poolEnd?: () => Promise<unknown> } = {}) => {
    const order: string[] = [];
    const exits: number[] = [];
    const app = { close: over.appClose ?? (async () => { order.push('app.close'); }) };
    const pool = { end: over.poolEnd ?? (async () => { order.push('pool.end'); }) };
    const shutdown = createShutdown(app, pool, { log: silent, exit: (c) => { exits.push(c); } });
    return { shutdown, order, exits };
  };

  it('closes the application before the session pool', async () => {
    const h = harness();
    await h.shutdown('SIGTERM');
    // app.close() runs the module destroy hooks that clear the poll timers and disconnect
    // Prisma; ending the pool first would pull the database out from under them.
    expect(h.order).toEqual(['app.close', 'pool.end']);
  });

  it('exits 0 on a clean stop', async () => {
    const h = harness();
    await h.shutdown('SIGTERM');
    expect(h.exits).toEqual([0]);
  });

  it('still ends the pool when the application fails to close', async () => {
    // Independent resources: skipping the pool because the app threw would leave the process
    // alive with open database connections, turning an error into a hang.
    const order: string[] = [];
    const h = harness({
      appClose: async () => { order.push('app.close'); throw new Error('boom'); },
      poolEnd: async () => { order.push('pool.end'); },
    });
    await h.shutdown('SIGTERM');
    expect(order).toEqual(['app.close', 'pool.end']);
  });

  it('reports a non-zero exit when teardown failed', async () => {
    const h = harness({ appClose: async () => { throw new Error('boom'); } });
    await h.shutdown('SIGTERM');
    expect(h.exits).toEqual([1]);
  });

  it('preserves an explicit exit code, as used for an uncaught exception', async () => {
    const h = harness();
    await h.shutdown('uncaughtException', 1);
    expect(h.exits).toEqual([1]);
  });

  it('ignores a second signal, so two Ctrl-Cs cannot race the first teardown', async () => {
    const h = harness();
    await Promise.all([h.shutdown('SIGINT'), h.shutdown('SIGINT'), h.shutdown('SIGTERM')]);
    expect(h.order).toEqual(['app.close', 'pool.end']); // exactly once
    expect(h.exits).toEqual([0]);                        // exits once
  });

  it('waits for a slow close rather than exiting underneath it', async () => {
    const order: string[] = [];
    const h = harness({
      appClose: async () => { await new Promise((r) => setTimeout(r, 60)); order.push('app.close'); },
      poolEnd: async () => { order.push('pool.end'); },
    });
    await h.shutdown('SIGTERM');
    expect(order).toEqual(['app.close', 'pool.end']);
  });
});
