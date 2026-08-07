import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from './redis.service';

/**
 * Namespaced, TTL'd caching over Redis — with the cache miss and the cache-unavailable case
 * deliberately made indistinguishable to every caller.
 *
 * THE ONE RULE THIS FILE ENFORCES: a cache may only ever make an answer FASTER, never different.
 * Every method degrades to "not cached" when Redis is absent or unreachable, and `remember()` calls
 * the loader in that case, so a caller cannot tell whether Redis exists. That is what makes it safe
 * to cache on a deployment that has no Redis at all, and safe for Redis to fail at any moment.
 *
 * WHAT MAY BE CACHED HERE. Things Postgres already holds and can regenerate: permission maps, module
 * access, API responses, notification counts. Nothing whose only copy would be the cached one, and
 * nothing a security decision is made from without a TTL short enough to make a revoked permission
 * take effect quickly — see `TTL.permissions`.
 */
@Injectable()
export class CacheService {
  private readonly log = new Logger(CacheService.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Lifetimes, in seconds, in one place so they can be reasoned about together.
   *
   * `permissions` is deliberately the shortest. It backs an authorization decision, and a cached
   * permission map is a window in which a right that has just been revoked still works. Sixty
   * seconds is short enough that removing somebody's access is effectively immediate to a person,
   * and long enough to absorb the repeated reads a page load makes.
   */
  static readonly TTL = {
    permissions: 60,
    moduleAccess: 60,
    api: 30,
    /*
     * The CRM dashboard's twelve aggregates. Short on purpose, and for two separate reasons.
     *
     * It is a summary screen, so a figure that is twenty seconds behind is indistinguishable from
     * one that is current — nobody reconciles a tile against a list to the second. And because the
     * entry is scoped to one person's book, the lifetime is also the window in which a scope change
     * has not yet taken effect. Twenty seconds is well inside `permissions` above, so the cached
     * dashboard can never outlive the permission map it was computed under.
     */
    dashboard: 20,
    notifications: 15,
    calendarSync: 300,
    exportProgress: 3_600,
    oauthState: 600,
  } as const;

  /** Cached value, or null for a miss — and for a Redis that is not there. */
  async get<T>(namespace: string, key: string): Promise<T | null> {
    if (!this.redis.ready()) return null;
    try {
      // Every command is raced against a deadline. `ready()` can be true and the connection drop
      // a millisecond later, and `maxRetriesPerRequest: null` means such a command never settles.
      const raw = await this.redis.withTimeout(this.redis.raw()!.get(this.redis.key(namespace, key)), null);
      return raw === null ? null : (JSON.parse(raw) as T);
    } catch (err) {
      // A corrupt entry must not become an exception on a request path — treat it as a miss and
      // let the loader produce the truth.
      this.log.debug(`Cache read failed for ${namespace}:${key}: ${(err as Error).message}`);
      return null;
    }
  }

  /** Store with a TTL. A cache entry without an expiry is a leak with a good reputation. */
  async set(namespace: string, key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!this.redis.ready()) return;
    try {
      await this.redis.withTimeout(
        this.redis.raw()!.set(this.redis.key(namespace, key), JSON.stringify(value), 'EX', Math.max(1, Math.floor(ttlSeconds))),
        null,
      );
    } catch (err) {
      this.log.debug(`Cache write failed for ${namespace}:${key}: ${(err as Error).message}`);
    }
  }

  async forget(namespace: string, key: string): Promise<void> {
    if (!this.redis.ready()) return;
    try {
      await this.redis.withTimeout(this.redis.raw()!.del(this.redis.key(namespace, key)), 0);
    } catch { /* a failed invalidation expires on its own; the TTL is the backstop */ }
  }

  /**
   * Drop every key in a namespace — used when something invalidates a whole class of answers, such
   * as a role's permissions changing for everybody at once.
   *
   * SCAN, not KEYS. `KEYS` blocks the whole Redis server while it walks the keyspace, which on a
   * shared instance stalls every other application using it. This walks in batches instead.
   */
  async forgetNamespace(namespace: string): Promise<number> {
    if (!this.redis.ready()) return 0;
    const client = this.redis.raw()!;
    const match = `${this.redis.key(namespace)}:*`;
    let cursor = '0';
    let removed = 0;
    try {
      do {
        const page = await this.redis.withTimeout(
          client.scan(cursor, 'MATCH', match, 'COUNT', 200),
          ['0', [] as string[]] as [string, string[]],
        );
        const [next, keys] = page;
        cursor = next;
        if (keys.length) removed += await this.redis.withTimeout(client.del(...keys), 0);
      } while (cursor !== '0');
    } catch (err) {
      this.log.debug(`Namespace flush failed for ${namespace}: ${(err as Error).message}`);
    }
    return removed;
  }

  /**
   * Read through the cache, or compute and store.
   *
   * The loader runs on a miss AND whenever Redis is unavailable, so the caller gets the right answer
   * either way. A loader that throws propagates: a failure to compute is a real failure, and
   * swallowing it here would cache nothing while hiding the reason.
   */
  async remember<T>(namespace: string, key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
    const hit = await this.get<T>(namespace, key);
    if (hit !== null) return hit;

    const value = await loader();
    // `undefined` does not survive JSON and would be stored as the string "undefined"; null is a
    // legitimate answer but is indistinguishable from a miss, so neither is written.
    if (value !== undefined && value !== null) await this.set(namespace, key, value, ttlSeconds);
    return value;
  }

  /**
   * Set only if absent — the primitive behind single-execution across processes.
   *
   * This is what stops two API instances running the same scheduled sweep: the comment on
   * `common/schedulers.ts` describes exactly that failure (two IMAP syncs racing on one mailbox,
   * two copies of a reminder reaching a real client). Returns false when Redis is unavailable, so a
   * caller must decide what "cannot coordinate" means for it — silently claiming the lock would be
   * the dangerous default.
   */
  async acquireLock(name: string, ttlSeconds: number): Promise<boolean> {
    if (!this.redis.ready()) return false;
    try {
      // Fallback is null, i.e. "lock not acquired" — a timeout must never be read as success, or
      // two processes would both believe they hold it.
      const result = await this.redis.withTimeout(
        this.redis.raw()!.set(this.redis.key('lock', name), '1', 'EX', Math.max(1, ttlSeconds), 'NX'),
        null,
      );
      return result === 'OK';
    } catch {
      return false;
    }
  }

  async releaseLock(name: string): Promise<void> {
    await this.forget('lock', name);
  }
}
