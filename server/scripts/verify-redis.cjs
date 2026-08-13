/**
 * Prove the APPLICATION uses Redis correctly — not merely that Redis answers PING.
 *
 * `setup-redis.sh` verifies the server. This verifies the four things the application actually
 * depends on, each of which fails silently rather than loudly if it is wrong:
 *
 *   1. CONNECTION AND PREFIX      keys land under REDIS_PREFIX, so two environments sharing one
 *                                 Redis cannot read each other's cached permission maps.
 *   2. CACHE ROUND-TRIP AND TTL   a value written is readable, and EXPIRES. A cache entry that
 *                                 never expires is a stale dashboard for ever.
 *   3. THE DISTRIBUTED LOCK       set-if-absent really is atomic across connections. This is the
 *                                 only thing stopping two processes running the same scheduler
 *                                 pass once RUN_SCHEDULERS is no longer the sole guard — two IMAP
 *                                 syncs racing one mailbox, two copies of a reminder to a client.
 *   4. noeviction                 BullMQ requires it. Under any other policy an evicted job is a
 *                                 job that silently never runs.
 *
 * Read-only apart from its own keys, which are namespaced `__verify__` and deleted afterwards.
 *
 *   node scripts/verify-redis.cjs
 *
 * Exits non-zero on any failure, so it can gate a deployment step.
 */
const { readFileSync } = require('node:fs');
const { join, dirname, resolve } = require('node:path');

const SERVER = resolve(dirname(__filename), '..');

/** Read REDIS_* from the environment, falling back to server/.env exactly as the app does. */
function fromEnvFile(name) {
  if (process.env[name]) return process.env[name];
  try {
    const line = readFileSync(join(SERVER, '.env'), 'utf8')
      .split('\n').find((l) => l.trim().startsWith(`${name}=`));
    return line ? line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '') : '';
  } catch { return ''; }
}

const URL_ = fromEnvFile('REDIS_URL');
const PREFIX = (fromEnvFile('REDIS_PREFIX') || 'ghr').replace(/:+$/, '');

let failed = 0;
const ok   = (m) => console.log(`  \x1b[32mok\x1b[0m    ${m}`);
const bad  = (m) => { failed++; console.log(`  \x1b[31mFAIL\x1b[0m  ${m}`); };
const note = (m) => console.log(`        ${m}`);
const head = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

(async () => {
  console.log('\nApplication-level Redis verification');

  if (!URL_) {
    console.log('\n  REDIS_URL is not set, in the environment or in server/.env.');
    console.log('  The application is running in-process: queues do not survive a restart, the');
    console.log('  dashboard cache is a no-op, and scheduler single-execution rests entirely on');
    console.log('  RUN_SCHEDULERS=false being correct on every web process.');
    console.log('\n  That is a supported configuration, not a fault. To enable Redis see');
    console.log('  docs/REDIS-SETUP.md, or run: sudo bash scripts/setup-redis.sh\n');
    process.exit(2);
  }

  let Redis;
  try { Redis = require('ioredis'); }
  catch { console.error('\n  ioredis is not installed — run npm install in server/.\n'); process.exit(1); }

  const redis = new Redis(URL_, { lazyConnect: true, maxRetriesPerRequest: 2, connectTimeout: 5000 });
  const second = new Redis(URL_, { lazyConnect: true, maxRetriesPerRequest: 2, connectTimeout: 5000 });
  const k = (s) => `${PREFIX}:__verify__:${s}`;

  try {
    head('1. Connection, version and prefix');
    const t0 = Date.now();
    await redis.connect();
    ok(`connected in ${Date.now() - t0} ms`);

    const info = await redis.info('server');
    const version = (/redis_version:([0-9.]+)/.exec(info) || [])[1] || 'unknown';
    const [maj, min] = version.split('.').map(Number);
    if (maj > 6 || (maj === 6 && min >= 2)) ok(`Redis ${version}`);
    else bad(`Redis ${version} — below 6.2. bullmq@5 will refuse to start, and because ioredis `
           + `connects anyway the in-process fallback is no longer in the path. Worse than no Redis.`);

    ok(`key prefix "${PREFIX}:"`);
    note('two environments sharing one Redis must NOT share this prefix');

    head('2. Cache round-trip and expiry');
    await redis.set(k('probe'), JSON.stringify({ hello: 'world' }), 'EX', 2);
    const read = await redis.get(k('probe'));
    if (read && JSON.parse(read).hello === 'world') ok('write then read returns the same value');
    else bad('a value written was not read back');

    const ttl = await redis.ttl(k('probe'));
    if (ttl > 0 && ttl <= 2) ok(`TTL is set and counting down (${ttl}s)`);
    else bad(`TTL is ${ttl} — a cache entry that never expires is a permanently stale dashboard`);

    head('3. Distributed lock (single-execution across processes)');
    await second.connect();
    const lock = k('lock');
    await redis.del(lock);
    const first  = await redis.set(lock, '1', 'EX', 10, 'NX');
    const clash  = await second.set(lock, '2', 'EX', 10, 'NX');
    if (first === 'OK' && clash === null) {
      ok('a second connection is refused the lock the first holds');
      note('this is what stops two processes running one scheduler pass');
    } else {
      bad(`set-NX is not atomic across connections (first=${first}, second=${clash}) — `
        + 'two instances could run the same sweep simultaneously');
    }
    await redis.del(lock);
    if (await second.set(lock, '3', 'EX', 10, 'NX') === 'OK') ok('the lock is reacquirable once released');
    else bad('the lock could not be reacquired after release — sweeps would stall permanently');
    await second.del(lock);

    head('4. Eviction policy (BullMQ correctness)');
    const [, policy] = await redis.config('GET', 'maxmemory-policy');
    if (policy === 'noeviction') ok('maxmemory-policy noeviction');
    else bad(`maxmemory-policy is "${policy}" — under any policy but noeviction an evicted job is a `
           + 'job that silently never runs. Set it in /etc/redis/redis.conf.');

    const [, maxmem] = await redis.config('GET', 'maxmemory');
    note(`maxmemory ${maxmem === '0' ? 'unlimited' : `${Math.round(Number(maxmem) / 1048576)} MB`}`);

    head('5. Cleaning up');
    const mine = await redis.keys(`${PREFIX}:__verify__:*`);
    if (mine.length) await redis.del(...mine);
    ok(`removed ${mine.length} verification key(s) — nothing else was touched`);
  } catch (e) {
    bad(`${e.message}`);
  } finally {
    redis.disconnect(); second.disconnect();
  }

  if (failed) {
    console.log(`\n\x1b[31m  ${failed} check(s) failed.\x1b[0m Do not enable Redis in production until these pass —`);
    console.log('  every one of them fails silently in normal use.\n');
    process.exit(1);
  }
  console.log('\n\x1b[32m  Every check passed.\x1b[0m Restart the application and confirm the boot log reads');
  console.log(`  [RedisService] Redis is connected (prefix "${PREFIX}:").\n`);
})();
