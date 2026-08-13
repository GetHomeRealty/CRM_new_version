import { clusterTick } from './cluster-tick';
import { registerWorker, resetWorkers, workerSnapshot } from '../observability/worker-health';
import type { CacheService } from './cache.service';
import type { RedisService } from './redis.service';

/**
 * Running a scheduled sweep on one process only.
 *
 * THE MOST IMPORTANT TEST IN THIS FILE IS THE FALLBACK ONE. Every deployment today has no Redis, so
 * if `clusterTick` skipped when it could not coordinate, adopting it would have silently stopped
 * every scheduled job everywhere — reminders never sent, mailboxes never polled, and nothing in the
 * application reporting it. The rule is: no Redis means no coordination is possible, so the existing
 * single-instance assumption applies and the tick RUNS.
 */

const settle = () => new Promise((r) => setTimeout(r, 20));

/** Redis absent, exactly as production is today. */
const noRedis = { enabled: () => false } as unknown as RedisService;
/** Redis present and answering. */
const withRedis = { enabled: () => true } as unknown as RedisService;

function lockThatGrants(): CacheService & { released: number } {
  let released = 0;
  const cache = {
    acquireLock: async () => true,
    releaseLock: async () => { released += 1; },
    get released() { return released; },
  };
  return cache as unknown as CacheService & { released: number };
}

const lockThatRefuses = {
  acquireLock: async () => false,
  releaseLock: async () => {},
} as unknown as CacheService;

beforeEach(() => { resetWorkers(); });

describe('without Redis', () => {
  it('RUNS the sweep — the behaviour every current deployment depends on', async () => {
    let runs = 0;
    const tick = clusterTick({ redis: noRedis, cache: lockThatRefuses }, 'probe-sweep', async () => { runs += 1; });

    tick();
    await settle();

    expect(runs).toBe(1);
  });

  it('never asks for a lock it cannot get', async () => {
    // Calling `acquireLock` with no Redis would answer false, and treating that as "somebody else
    // has it" is precisely the bug that would stop every job on every deployment.
    let asked = 0;
    const cache = { acquireLock: async () => { asked += 1; return false; }, releaseLock: async () => {} } as unknown as CacheService;

    clusterTick({ redis: noRedis, cache }, 'probe-sweep', async () => {})();
    await settle();

    expect(asked).toBe(0);
  });
});

describe('with Redis', () => {
  it('runs when it wins the lock, and releases it afterwards', async () => {
    const cache = lockThatGrants();
    let runs = 0;
    clusterTick({ redis: withRedis, cache }, 'probe-sweep', async () => { runs += 1; })();
    await settle();

    expect(runs).toBe(1);
    expect(cache.released).toBe(1);
  });

  it('SKIPS when another process holds the lock', async () => {
    /*
     * The whole point. `common/schedulers.ts` describes what happens without this: "two IMAP syncs
     * racing on one mailbox and two copies of every reminder email arriving at a real client."
     */
    let runs = 0;
    clusterTick({ redis: withRedis, cache: lockThatRefuses }, 'probe-sweep', async () => { runs += 1; })();
    await settle();

    expect(runs).toBe(0);
  });

  it('releases the lock even when the sweep throws', async () => {
    // Otherwise one failure would block the sweep on every process until the TTL lapsed — turning a
    // transient error into an outage of that job.
    const cache = lockThatGrants();
    clusterTick({ redis: withRedis, cache }, 'probe-sweep', async () => { throw new Error('sweep failed'); })();
    await settle();

    expect(cache.released).toBe(1);
  });

  it('stands down when Redis is unreachable rather than risking a duplicate', async () => {
    /*
     * `acquireLock` reports false both for "somebody else has it" and for "Redis did not answer".
     * Skipping is the safe reading: a missed pass is picked up by the next tick minutes later,
     * whereas a duplicate pass sends somebody a second copy of a real email that cannot be recalled.
     */
    let runs = 0;
    clusterTick({ redis: withRedis, cache: lockThatRefuses }, 'probe-sweep', async () => { runs += 1; })();
    await settle();

    expect(runs).toBe(0);
  });
});

describe('worker health reporting', () => {
  /*
   * Registered first, exactly as a real scheduler does in `onModuleInit`. `workerStarted`,
   * `workerFinished` and `workerFailed` are deliberate no-ops for an unregistered name — the
   * registry treats "declared" and "ran" as different things, so that a scheduler switched off on
   * this process is simply absent rather than permanently stale. Omitting this made the first
   * version of these tests look like a reporting bug when it was a missing fixture.
   */
  beforeEach(() => { registerWorker('probe-sweep', 60_000); });

  it('still records the run, so /health/workers is unchanged', async () => {
    // `clusterTick` wraps `trackedTick`, so adopting it must not cost a scheduler its monitoring.
    clusterTick({ redis: noRedis, cache: lockThatRefuses }, 'probe-sweep', async () => {})();
    await settle();

    const entry = workerSnapshot().find((w) => w.name === 'probe-sweep');
    expect(entry).toBeDefined();
    expect(entry!.lastError).toBeFalsy();
  });

  it('records a failure rather than letting it escape the timer', async () => {
    /*
     * An unhandled rejection from a timer callback ends the process on current Node. `trackedTick`
     * is what prevents that, and this confirms wrapping it did not lose the property.
     */
    clusterTick({ redis: noRedis, cache: lockThatRefuses }, 'probe-sweep', async () => { throw new Error('boom'); })();
    await settle();

    const entry = workerSnapshot().find((w) => w.name === 'probe-sweep');
    expect(entry?.lastError).toContain('boom');
  });

  it('a skipped pass is not recorded as a failure', async () => {
    // Standing down is normal operation on a second process, not an error — reporting it as one
    // would make a correctly-behaving cluster look permanently broken.
    clusterTick({ redis: withRedis, cache: lockThatRefuses }, 'probe-sweep', async () => {})();
    await settle();

    const entry = workerSnapshot().find((w) => w.name === 'probe-sweep');
    expect(entry?.lastError).toBeFalsy();
  });
});
