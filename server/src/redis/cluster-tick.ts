import { Logger } from '@nestjs/common';
import { trackedTick } from '../observability/worker-health';
import type { CacheService } from './cache.service';
import type { RedisService } from './redis.service';

const log = new Logger('ClusterTick');

/**
 * Run a scheduled sweep on ONE process only.
 *
 * THE PROBLEM THIS SOLVES IS ALREADY WRITTEN DOWN, in `common/schedulers.ts`:
 *
 *   "They are plain timers, not distributed jobs, so there is nothing to stop two processes running
 *    the same one: pm2 in cluster mode, or a second container, means two IMAP syncs racing on one
 *    mailbox and two copies of every reminder email arriving at a real client. Nothing in the
 *    application would report that; it would simply be happening."
 *
 * The workaround until now was `RUN_SCHEDULERS=false` on every process but one — correct, but it
 * means the extra processes serve requests while one carries all the background work, and getting
 * the flag wrong is silent in exactly the way described above.
 *
 * A short-lived Redis lock replaces that convention with a guarantee: whichever process wins the
 * `SET NX` runs the sweep, the rest skip that pass.
 *
 * WHAT HAPPENS WITHOUT REDIS, and this is the important half. The tick RUNS. Falling back to
 * "skip" would mean that installing this module silently stopped every scheduled job on every
 * deployment that has no Redis — which is all of them today. No Redis means no coordination is
 * possible, so the existing single-instance assumption applies exactly as it did before, and
 * behaviour is unchanged.
 *
 * DROP-IN: same shape as `trackedTick`, so a scheduler adopts it by changing one line and keeps its
 * worker-health reporting.
 */
export function clusterTick(
  deps: { redis: RedisService; cache: CacheService },
  name: string,
  fn: () => Promise<unknown>,
  options: { lockTtlSeconds?: number } = {},
): () => void {
  /*
   * The lock must outlive a normal run and expire well before the next one is due, so a process
   * that dies mid-sweep does not hold it for ever. It is a lease, not a mutex: if the holder
   * vanishes, the next tick takes over once the TTL lapses.
   */
  const ttl = Math.max(5, Math.floor(options.lockTtlSeconds ?? 300));

  return trackedTick(name, async () => {
    // No Redis configured: nothing to coordinate with, so behave exactly as before.
    if (!deps.redis.enabled()) return fn();

    const held = await deps.cache.acquireLock(`sweep:${name}`, ttl);
    if (!held) {
      // Another process is running this pass — or Redis is unreachable, in which case
      // `acquireLock` reports false and this process stands down rather than risking a duplicate.
      log.debug(`"${name}" is being handled by another process this pass.`);
      return undefined;
    }

    try {
      return await fn();
    } finally {
      /*
       * Released as soon as the work finishes rather than waiting for the TTL, so the next tick is
       * not blocked by a lease held long after it was needed. A crash before this line is exactly
       * what the TTL covers.
       */
      await deps.cache.releaseLock(`sweep:${name}`);
    }
  });
}
