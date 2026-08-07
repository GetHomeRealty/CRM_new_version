import { CacheService } from './cache.service';
import { RedisService } from './redis.service';

/**
 * Caching, and the one rule it must never break: a cache may make an answer FASTER, never DIFFERENT.
 *
 * These run without Redis, which is the point — no Redis exists on the build machine and none
 * exists in production yet, so "Redis is absent" is not an edge case here, it is the default
 * configuration. Every test below asserts that a caller cannot tell.
 *
 * The keyed/namespaced behaviour is tested against a small in-memory stand-in for ioredis, because
 * what matters is the key SHAPE and the TTL this service asks for — not that Redis stores strings,
 * which is Redis's job and is not in doubt.
 */

const originalUrl = process.env.REDIS_URL;
const originalPrefix = process.env.REDIS_PREFIX;

afterAll(() => {
  if (originalUrl === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = originalUrl;
  if (originalPrefix === undefined) delete process.env.REDIS_PREFIX; else process.env.REDIS_PREFIX = originalPrefix;
});

// ============================================================================ no Redis at all
describe('with no Redis configured', () => {
  let cache: CacheService;
  let redis: RedisService;

  beforeEach(() => {
    delete process.env.REDIS_URL;
    redis = new RedisService();
    cache = new CacheService(redis);
  });

  it('reports itself disabled rather than pretending', () => {
    expect(redis.enabled()).toBe(false);
    expect(redis.ready()).toBe(false);
    expect(redis.raw()).toBeNull();
  });

  it('every read is a miss', async () => {
    expect(await cache.get('permissions', 'user:1')).toBeNull();
  });

  it('writes are silently dropped rather than throwing', async () => {
    // A cache write that throws would turn an optional dependency into a required one — every
    // caller would need a try/catch and one of them would forget.
    await expect(cache.set('permissions', 'user:1', { a: 1 }, 60)).resolves.toBeUndefined();
    await expect(cache.forget('permissions', 'user:1')).resolves.toBeUndefined();
    expect(await cache.forgetNamespace('permissions')).toBe(0);
  });

  it('remember() still returns the right answer, by calling the loader', async () => {
    /*
     * THE TEST THIS FILE EXISTS FOR. Callers must be unable to distinguish "no Redis" from "cache
     * miss", because that is what makes it safe to cache on a deployment that has none.
     */
    let calls = 0;
    const load = async () => { calls += 1; return { permissions: 'edit' }; };

    expect(await cache.remember('permissions', 'user:1', 60, load)).toEqual({ permissions: 'edit' });
    expect(await cache.remember('permissions', 'user:1', 60, load)).toEqual({ permissions: 'edit' });

    // Called every time, because nothing can be stored — correct, if not fast.
    expect(calls).toBe(2);
  });

  it('a failing loader still fails, rather than being swallowed', async () => {
    // A failure to COMPUTE is a real failure. Hiding it here would cache nothing and report success.
    await expect(cache.remember('api', 'k', 30, async () => { throw new Error('database down'); }))
      .rejects.toThrow('database down');
  });

  it('reports a lock as NOT acquired', async () => {
    /*
     * The safe direction, and worth pinning down. Returning true would mean every process believes
     * it holds the lock — turning a coordination primitive into the exact duplicate-work bug it
     * exists to prevent.
     */
    expect(await cache.acquireLock('nightly-sweep', 60)).toBe(false);
  });

  it('health reports "skipped", which must not fail a readiness probe', async () => {
    expect(await redis.health()).toEqual({ status: 'skipped' });
  });
});

// ============================================================================ keys and TTLs
describe('keys and lifetimes', () => {
  /** Just enough of ioredis for the key shape and TTL to be observable. */
  class FakeRedis {
    readonly store = new Map<string, { value: string; ttl: number }>();
    calls: Array<{ cmd: string; key: string; ttl?: number }> = [];

    async get(key: string) { this.calls.push({ cmd: 'get', key }); return this.store.get(key)?.value ?? null; }
    async set(key: string, value: string, _ex?: string, ttl?: number, nx?: string) {
      this.calls.push({ cmd: 'set', key, ttl });
      if (nx === 'NX' && this.store.has(key)) return null;
      this.store.set(key, { value, ttl: ttl ?? 0 });
      return 'OK';
    }
    async del(...keys: string[]) { keys.forEach((k) => this.store.delete(k)); return keys.length; }
    async ping() { return 'PONG'; }
  }

  function build() {
    delete process.env.REDIS_URL;
    process.env.REDIS_PREFIX = 'ghr-test';
    const redis = new RedisService();
    const fake = new FakeRedis();
    // Stand the service up as though it were connected. Done here rather than by connecting to a
    // real server because no Redis exists on this machine — and the key shape is what is under test.
    (redis as unknown as { client: unknown }).client = fake;
    (redis as unknown as { connected: boolean }).connected = true;
    return { cache: new CacheService(redis), redis, fake };
  }

  it('namespaces every key with the configured prefix', async () => {
    /*
     * Getting this wrong is SILENT. A staging deployment pointed at a shared Redis would read
     * production's cached permission maps and answer confidently with the wrong ones — no error
     * anywhere, just wrong answers.
     */
    const { cache, fake } = build();
    await cache.set('permissions', 'user:7', { crm: 'edit' }, 60);

    expect([...fake.store.keys()]).toEqual(['ghr-test:permissions:user:7']);
  });

  it('always sets a TTL — an entry without one is a leak with a good reputation', async () => {
    const { cache, fake } = build();
    await cache.set('api', 'leads:page:1', [1, 2, 3], CacheService.TTL.api);

    expect(fake.calls.find((c) => c.cmd === 'set')?.ttl).toBe(CacheService.TTL.api);
  });

  it('never asks for a zero or negative TTL', async () => {
    // `EX 0` is an error in Redis, and a negative one would delete the key immediately — both turn a
    // caching bug into a runtime failure on a request path.
    const { cache, fake } = build();
    await cache.set('api', 'k', 'v', 0);
    await cache.set('api', 'k2', 'v', -5);

    for (const call of fake.calls.filter((c) => c.cmd === 'set')) {
      expect(call.ttl).toBeGreaterThanOrEqual(1);
    }
  });

  it('round-trips a value through the cache', async () => {
    const { cache } = build();
    await cache.set('permissions', 'user:7', { crm: 'edit' }, 60);
    expect(await cache.get('permissions', 'user:7')).toEqual({ crm: 'edit' });
  });

  it('remember() calls the loader once, then serves from the cache', async () => {
    const { cache } = build();
    let calls = 0;
    const load = async () => { calls += 1; return { crm: 'edit' }; };

    expect(await cache.remember('permissions', 'user:7', 60, load)).toEqual({ crm: 'edit' });
    expect(await cache.remember('permissions', 'user:7', 60, load)).toEqual({ crm: 'edit' });
    expect(calls).toBe(1);
  });

  it('does not cache null, so a real miss is not mistaken for a stored null', async () => {
    const { cache, fake } = build();
    let calls = 0;
    await cache.remember('api', 'nothing', 30, async () => { calls += 1; return null; });
    await cache.remember('api', 'nothing', 30, async () => { calls += 1; return null; });

    expect(fake.store.size).toBe(0);
    expect(calls).toBe(2);
  });

  it('a lock is exclusive — the second attempt fails while the first holds it', async () => {
    const { cache } = build();
    expect(await cache.acquireLock('nightly-sweep', 60)).toBe(true);
    expect(await cache.acquireLock('nightly-sweep', 60)).toBe(false);

    await cache.releaseLock('nightly-sweep');
    expect(await cache.acquireLock('nightly-sweep', 60)).toBe(true);
  });

  it('keeps permission entries short-lived, because they back an authorization decision', () => {
    /*
     * A cached permission map is a window in which a right that has just been revoked still works.
     * Asserted as a bound rather than an exact number so the value can be tuned — but not to
     * something that would leave a removed permission working for an hour.
     */
    expect(CacheService.TTL.permissions).toBeLessThanOrEqual(60);
    expect(CacheService.TTL.moduleAccess).toBeLessThanOrEqual(60);
  });
});

// ============================================================================ timeouts
describe('a Redis that accepts commands but never answers', () => {
  /*
   * THE FAILURE THIS GUARDS, WHICH WAS MEASURED RATHER THAN IMAGINED. BullMQ requires
   * `maxRetriesPerRequest: null`, meaning "never give up on a command" — so against an unreachable
   * Redis these promises never settle. The first version of this module hung `/api/health/ready`
   * indefinitely, which would have pulled a healthy deployment out of the load balancer during a
   * Redis outage: the exact opposite of what an optional dependency should do.
   */
  function buildHanging() {
    delete process.env.REDIS_URL;
    const redis = new RedisService();
    const hanging = {
      get: () => new Promise(() => {}),
      set: () => new Promise(() => {}),
      del: () => new Promise(() => {}),
      ping: () => new Promise(() => {}),
    };
    (redis as unknown as { client: unknown }).client = hanging;
    (redis as unknown as { connected: boolean }).connected = true;
    return { cache: new CacheService(redis), redis };
  }

  it('a read gives up and reports a miss', async () => {
    const { cache } = buildHanging();
    const started = Date.now();
    expect(await cache.get('permissions', 'user:1')).toBeNull();
    expect(Date.now() - started).toBeLessThan(RedisService.COMMAND_TIMEOUT_MS + 500);
  });

  it('a write gives up instead of blocking the caller', async () => {
    const { cache } = buildHanging();
    const started = Date.now();
    await cache.set('permissions', 'user:1', { a: 1 }, 60);
    expect(Date.now() - started).toBeLessThan(RedisService.COMMAND_TIMEOUT_MS + 500);
  });

  it('remember() falls through to the loader rather than hanging', async () => {
    const { cache } = buildHanging();
    expect(await cache.remember('api', 'k', 30, async () => 'from the database')).toBe('from the database');
  });

  it('health reports "down" instead of never returning', async () => {
    const { redis } = buildHanging();
    const started = Date.now();
    expect((await redis.health()).status).toBe('down');
    expect(Date.now() - started).toBeLessThan(RedisService.COMMAND_TIMEOUT_MS + 500);
  });

  it('a lock is not granted when Redis does not answer', async () => {
    const { cache } = buildHanging();
    expect(await cache.acquireLock('sweep', 60)).toBe(false);
  });
});
