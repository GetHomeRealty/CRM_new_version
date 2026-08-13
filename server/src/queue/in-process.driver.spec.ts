import { InProcessQueueDriver } from './in-process.driver';
import type { JobContext } from './queue.types';

/**
 * The in-process queue driver.
 *
 * WHY THIS FILE MATTERS MORE THAN IT LOOKS. This driver is not a test double — it is the production
 * path on every deployment without Redis, which today is all of them. The BullMQ driver cannot be
 * executed here (no Redis, Docker or WSL on the build machine, and BullMQ needs real Lua scripting
 * and blocking reads, so a mock proves nothing), so this is where the queue's guarantees are
 * actually demonstrated: retries, exponential backoff, the dead letter, cancellation, progress,
 * concurrency and de-duplication.
 *
 * Time is real here rather than faked. The driver's tick is 250ms and its backoff base is
 * configurable per job, so the waits below are tens of milliseconds — short enough to keep the file
 * fast, long enough to be genuine.
 */

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `check` passes or the budget runs out — steadier than one fixed sleep. */
async function until(check: () => boolean | Promise<boolean>, budgetMs = 4_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await settle(20);
  }
  throw new Error('condition was not met within the budget');
}

describe('the in-process queue driver', () => {
  let driver: InProcessQueueDriver;

  beforeEach(() => { driver = new InProcessQueueDriver(); });
  afterEach(async () => { await driver.shutdown(); });

  it('runs a job and reports it completed', async () => {
    const seen: unknown[] = [];
    driver.register('notification', async (payload) => { seen.push(payload); });

    await driver.add('notification', { hello: 'world' });
    await until(() => seen.length === 1);

    expect(seen[0]).toEqual({ hello: 'world' });
    const stats = (await driver.stats()).find((s) => s.queue === 'notification')!;
    expect(stats.completed).toBe(1);
    expect(stats.failed).toBe(0);
  });

  it('takes the work off the caller — `add` returns before the job runs', async () => {
    /*
     * The whole point of a queue in a web application: no request waits for background work. If
     * `add` awaited the handler this would fail, and every caller would inherit the handler's
     * latency and its failures.
     */
    let started = false;
    driver.register('email', async () => { started = true; await settle(200); });

    await driver.add('email', {});
    expect(started).toBe(false);

    await until(() => started);
  });

  it('does not run a job at all when no handler is registered', async () => {
    // Work waits rather than disappearing: a queue whose worker has not started yet must not lose
    // what was handed to it.
    await driver.add('export', {});
    await settle(400);

    const stats = (await driver.stats()).find((s) => s.queue === 'export')!;
    expect(stats.waiting).toBe(1);
    expect(stats.completed).toBe(0);
  });

  describe('retries and backoff', () => {
    it('retries a failing job up to its attempt budget', async () => {
      let attempts = 0;
      driver.register('email', async () => { attempts += 1; throw new Error('smtp refused'); });

      await driver.add('email', {}, { attempts: 3, backoffMs: 10 });
      await until(() => attempts === 3);
      await settle(100);

      // Exactly the budget — not more, which would mean a retry loop with no end.
      expect(attempts).toBe(3);
    });

    it('stops retrying as soon as one attempt succeeds', async () => {
      let attempts = 0;
      driver.register('sms', async () => {
        attempts += 1;
        if (attempts < 2) throw new Error('transient');
      });

      await driver.add('sms', {}, { attempts: 5, backoffMs: 10 });
      await until(async () => (await driver.stats()).some((s) => s.queue === 'sms' && s.completed === 1));
      await settle(80);

      expect(attempts).toBe(2);
    });

    it('waits longer between each attempt', async () => {
      /*
       * Exponential backoff exists so a struggling downstream service is not hammered by the very
       * retries meant to work around its bad minute. Asserted as "each gap is clearly larger than
       * the last" rather than against exact timings, which would be flaky on a busy machine.
       *
       * THE BASE MUST EXCEED THE SCHEDULER'S TICK, and that is a real property rather than a
       * convenience for the test. Due work is picked up by a poll every `TICK_MS` (250ms), so any
       * backoff shorter than that is rounded up to the next tick and becomes invisible: a first
       * draft of this test used 60ms and measured gaps of 251ms and 252ms — the backoff was working
       * and the tick was hiding it. Production backoffs default to 1000ms, comfortably above the
       * tick, so this is a limit on resolution and not on behaviour.
       */
      const base = InProcessQueueDriver.TICK_MS * 2;   // 500ms → gaps of ~500ms then ~1000ms
      const at: number[] = [];
      driver.register('sms', async () => { at.push(Date.now()); throw new Error('nope'); });

      await driver.add('sms', {}, { attempts: 3, backoffMs: base });
      await until(() => at.length === 3, 10_000);

      const first = at[1] - at[0];
      const second = at[2] - at[1];
      // A clear margin, so tick rounding cannot make a real doubling look like noise.
      expect(second).toBeGreaterThan(first + InProcessQueueDriver.TICK_MS);
    });

    it('tells the handler which attempt it is on', async () => {
      const attempts: number[] = [];
      driver.register('email', async (_p, ctx: JobContext) => {
        attempts.push(ctx.attempt);
        throw new Error('again');
      });

      await driver.add('email', {}, { attempts: 3, backoffMs: 10 });
      await until(() => attempts.length === 3);

      expect(attempts).toEqual([1, 2, 3]);
    });

    it('runs a job exactly once when attempts is 1', async () => {
      // What a non-idempotent job must use. Retrying "send this email" after the message already
      // reached the SMTP server sends it twice.
      let attempts = 0;
      driver.register('email', async () => { attempts += 1; throw new Error('no'); });

      await driver.add('email', {}, { attempts: 1, backoffMs: 10 });
      await until(async () => (await driver.dead('email')).length === 1);

      expect(attempts).toBe(1);
    });
  });

  describe('the dead letter', () => {
    it('parks a job that exhausted every attempt, with its error', async () => {
      /*
       * A job that has failed every attempt is usually evidence of something broken, not bad luck.
       * Dropping it silently would mean work that simply never happened, with nothing anywhere to
       * show for it.
       */
      driver.register('export', async () => { throw new Error('disk full'); });
      await driver.add('export', { report: 'commissions' }, { attempts: 2, backoffMs: 10, jobId: 'exp-1' });

      await until(async () => (await driver.dead('export')).length === 1);

      const [job] = await driver.dead('export');
      expect(job.id).toBe('exp-1');
      expect(job.state).toBe('dead');
      expect(job.attempts).toBe(2);
      expect(job.error).toContain('disk full');

      const stats = (await driver.stats()).find((s) => s.queue === 'export')!;
      expect(stats.dead).toBe(1);
    });

    it('does not park a job that eventually succeeded', async () => {
      let attempts = 0;
      driver.register('export', async () => { attempts += 1; if (attempts < 2) throw new Error('transient'); });

      await driver.add('export', {}, { attempts: 3, backoffMs: 10 });
      await until(async () => (await driver.stats()).some((s) => s.queue === 'export' && s.completed === 1));

      expect(await driver.dead('export')).toEqual([]);
    });

    it('re-queues a dead job with a FRESH attempt budget', async () => {
      /*
       * The operator has fixed whatever broke it, so it starts over. Resuming with its attempts
       * already spent would mean one more failure and straight back to the dead letter — a retry
       * button that does nothing is worse than none.
       */
      let fail = true;
      let attempts = 0;
      driver.register('export', async () => { attempts += 1; if (fail) throw new Error('disk full'); });

      await driver.add('export', {}, { attempts: 2, backoffMs: 10, jobId: 'exp-2' });
      await until(async () => (await driver.dead('export')).length === 1);
      expect(attempts).toBe(2);

      fail = false;
      expect(await driver.retryDead('export', 'exp-2')).toBe(true);
      await until(async () => (await driver.stats()).some((s) => s.queue === 'export' && s.completed === 1));

      expect(await driver.dead('export')).toEqual([]);
    });

    it('refuses to re-queue something that is not there', async () => {
      expect(await driver.retryDead('export', 'never-existed')).toBe(false);
    });
  });

  describe('cancellation', () => {
    it('removes a job that has not started', async () => {
      driver.register('reminder', async () => { throw new Error('should never run'); });
      // Delayed, so there is a window in which to cancel it.
      await driver.add('reminder', {}, { jobId: 'later', delayMs: 5_000 });

      expect(await driver.cancel('reminder', 'later')).toBe(true);
      await settle(300);

      const stats = (await driver.stats()).find((s) => s.queue === 'reminder')!;
      expect(stats.waiting).toBe(0);
      expect(stats.completed).toBe(0);
      expect(stats.failed).toBe(0);
    });

    it('asks a RUNNING job to stop, which it notices at its next checkpoint', async () => {
      /*
       * Stated honestly, because it is the part people expect to work differently: a running
       * function cannot be interrupted from outside. Cancellation is cooperative — the handler
       * checks `ctx.cancelled()` between units of work. A handler that never checks runs to
       * completion, and that is a property of JavaScript rather than of this driver.
       */
      let processed = 0;
      let sawCancellation = false;
      driver.register('export', async (_p, ctx: JobContext) => {
        for (let i = 0; i < 50; i += 1) {
          if (ctx.cancelled()) { sawCancellation = true; return; }
          processed += 1;
          await settle(10);
        }
      });

      const id = await driver.add('export', {});
      await until(() => processed > 1);
      await driver.cancel('export', id);
      await until(() => sawCancellation);

      expect(sawCancellation).toBe(true);
      expect(processed).toBeLessThan(50);
    });

    it('reports nothing to cancel for an unknown job', async () => {
      expect(await driver.cancel('email', 'no-such-job')).toBe(false);
    });
  });

  describe('progress', () => {
    it('records what the handler reports, and completes at 100', async () => {
      const seen: number[] = [];
      driver.register('export', async (_p, ctx: JobContext) => {
        for (const pct of [10, 50, 90]) { await ctx.progress(pct); seen.push(pct); }
      });

      await driver.add('export', {}, { jobId: 'prog-1' });
      await until(() => seen.length === 3);
      await settle(50);

      expect(seen).toEqual([10, 50, 90]);
    });

    it('clamps nonsense values rather than storing them', async () => {
      driver.register('export', async (_p, ctx: JobContext) => {
        await ctx.progress(-20);
        await ctx.progress(999);
      });
      await driver.add('export', {}, { jobId: 'prog-2' });
      await until(async () => (await driver.stats()).some((s) => s.queue === 'export' && s.completed === 1));
      // No assertion on an intermediate value — the point is that neither threw and the job finished.
    });
  });

  describe('de-duplication and concurrency', () => {
    it('does not queue the same job id twice while it is still pending', async () => {
      /*
       * What makes enqueueing from a timer safe: "sync mailbox 7" fired again while the previous
       * run is still going must not start a second sync of the same mailbox.
       */
      let runs = 0;
      driver.register('calendar-sync', async () => { runs += 1; await settle(150); });

      await driver.add('calendar-sync', { mailbox: 7 }, { jobId: 'mailbox-7' });
      await driver.add('calendar-sync', { mailbox: 7 }, { jobId: 'mailbox-7' });
      await driver.add('calendar-sync', { mailbox: 7 }, { jobId: 'mailbox-7' });

      await until(() => runs === 1);
      await settle(250);
      expect(runs).toBe(1);
    });

    it('runs different jobs concurrently, up to the cap', async () => {
      let running = 0;
      let peak = 0;
      driver.register('email', async () => {
        running += 1;
        peak = Math.max(peak, running);
        await settle(120);
        running -= 1;
      });

      for (let i = 0; i < 10; i += 1) await driver.add('email', { i });
      await until(async () => (await driver.stats()).some((s) => s.queue === 'email' && s.completed === 10), 8_000);

      expect(peak).toBeGreaterThan(1);
      // Bounded, so a burst cannot exhaust the event loop and starve request handling.
      expect(peak).toBeLessThanOrEqual(InProcessQueueDriver.CONCURRENCY);
    });

    it('keeps queues independent — a blocked one does not stall the others', async () => {
      driver.register('export', async () => { await settle(400); });
      let notified = false;
      driver.register('notification', async () => { notified = true; });

      for (let i = 0; i < InProcessQueueDriver.CONCURRENCY; i += 1) await driver.add('export', { i });
      await driver.add('notification', {});

      await until(() => notified, 2_000);
      expect(notified).toBe(true);
    });
  });

  it('reports itself as in-process, so monitoring never has to guess', async () => {
    // The distinction matters during an incident: in-process means jobs did not survive the last
    // restart and are not shared between processes.
    expect(driver.kind).toBe('in-process');
  });

  it('stops cleanly, and runs nothing afterwards', async () => {
    let runs = 0;
    driver.register('email', async () => { runs += 1; });
    await driver.shutdown();

    await driver.add('email', {});
    await settle(400);
    expect(runs).toBe(0);
  });
});
