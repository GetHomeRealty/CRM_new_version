# Redis on the production server

**Status:** **installed and configured in PRODUCTION as of 2026-08-08**, on a current Redis, as
reported by the operator. Not installed on the development machine, which continues to run
in-process — so anything measured or tested there still reflects the no-Redis path.

> **Not independently verified.** Nobody has yet run `node scripts/verify-redis.cjs` against the
> production server. Until that passes, four things remain assumed rather than known: that the
> version clears BullMQ's floor, that `maxmemory-policy` is `noeviction`, that the key prefix is
> unique to production, and that `SET NX` is atomic across connections. Every one of those fails
> **silently** — nothing errors, the behaviour is simply wrong. That is the whole reason the
> script exists.

**Two scripts do the work described below.** They were added 2026-08-08 so the steps are executed
rather than transcribed:

| | |
|---|---|
| `server/scripts/setup-redis.sh` | Installs, configures and starts Redis on the Linux server. Idempotent. Generates the password on the machine from `/dev/urandom`, so it is never typed or pasted. **Refuses to proceed below Redis 6.2** — see §1 for why that matters more than it looks. `--verify-only` checks an existing install without changing it. |
| `server/scripts/verify-redis.cjs` | Verifies the APPLICATION, not the server: prefix isolation, cache round-trip and expiry, the distributed lock's atomicity across two connections, and `noeviction`. Exits non-zero, so it can gate a deployment step. |

`verify-redis.cjs` was itself tested against a mock server for all three hazards it exists to catch —
a 3.0.504 server, a wrong eviction policy, and a non-atomic `SET NX` — and correctly fails each one.
Every one of those failures is silent in normal use, which is the reason the check exists.

**What it is worth.** Three things are dormant without Redis, and all three switch on from one
environment variable with no code change and no data migration:

| | Without Redis (today) | With Redis |
|---|---|---|
| CRM dashboard cache | no-op; every request recomputes 12 aggregates | 20s per-user entries |
| Background queues | in-process; jobs lost on restart, not shared across processes | BullMQ — durable, shared |
| Scheduler single-execution | rests on `RUN_SCHEDULERS=false` being correct on every web process | a real distributed lock |

Nothing is ever stored **only** in Redis. It is a faster path to what PostgreSQL already holds, so
there is nothing to migrate in, and unsetting `REDIS_URL` reverts cleanly.

---

## 1. Version requirement — do not skip this

`bullmq@5.81.3` enforces a minimum at connect time:

```
RedisConnection.minimumVersion           = '5.0.0'
RedisConnection.recommendedMinimumVersion = '6.2.0'
```

**Redis 6.2 or newer.** Debian 12 and Ubuntu 22.04/24.04 all ship 7.x from their own repositories,
so the distribution package is fine.

Anything below 5.0 is worse than no Redis at all: ioredis connects, `RedisService.enabled()` becomes
true, `QueueService` switches to the BullMQ driver, BullMQ then rejects the server version — and the
in-process fallback is no longer in the path. This is exactly why the Windows `Redis.Redis 3.0.504`
package was rejected.

## 2. Install

```bash
sudo apt update
sudo apt install -y redis-server
redis-server --version          # confirm 6.2+
```

## 3. Configure

Edit `/etc/redis/redis.conf`:

```conf
# Localhost only. Redis has no authentication worth the name on an open port, and this application
# talks to it from the same machine.
bind 127.0.0.1 -::1
protected-mode yes
port 6379

# Defence in depth even on localhost — any local process could otherwise read cached permission
# maps and queued job payloads.
requirepass <A-LONG-RANDOM-STRING>

# THE IMPORTANT ONE. BullMQ requires noeviction: an evicted job is a job that silently never runs.
# Safe for the cache too, because CacheService writes every key with an EX expiry — nothing this
# application stores is eviction-dependent, so keys expire on their own schedule.
maxmemory 512mb
maxmemory-policy noeviction

# Durability. The queue is the only thing here whose loss is felt; appendonly makes a restart
# lose at most a second of jobs instead of everything since the last snapshot.
appendonly yes
appendfsync everysec
```

Then:

```bash
sudo systemctl enable --now redis-server
sudo systemctl restart redis-server
redis-cli -a '<A-LONG-RANDOM-STRING>' ping     # expect: PONG
```

### Sizing

512 MB is generous for this workload. Cached dashboards are a few hundred bytes each and expire in
20 seconds; queue payloads are small. Raise it only if `INFO memory` shows `used_memory` approaching
the cap.

## 4. Point the application at it

In `server/.env` on the server:

```
REDIS_URL=redis://:<A-LONG-RANDOM-STRING>@127.0.0.1:6379
REDIS_PREFIX=ghr
```

Note the URL form for a password with no username: `redis://:PASSWORD@host:port`. If the password
contains `@ : / ? #`, percent-encode it or the URL parses wrongly.

### `REDIS_PREFIX` matters more than it looks

Every key is namespaced with it (default `ghr:`). If staging and production ever share one Redis
server and share a prefix, **staging reads production's cached permission maps** — and the failure is
silent, because nothing errors, the answers are simply wrong. Give each environment its own:

```
REDIS_PREFIX=ghr-prod        # and ghr-staging on the other box
```

## 5. Restart and verify

Restart the application, then check the boot log. Before:

```
[RedisService] REDIS_URL is not set — caching and distributed queues are off, everything runs in-process.
[QueueService] Queues are running in-process — jobs do NOT survive a restart …
```

After:

```
[RedisService] Redis is connected (prefix "ghr-prod:").
[QueueService] Queues are backed by Redis — jobs survive a restart and are shared across processes.
```

`GET /api/health/ready` reports Redis with a real round-trip latency instead of `skipped`.

Confirm keys are actually being written, and that they carry the expected prefix:

```bash
redis-cli -a '<PASSWORD>' --scan --pattern 'ghr-prod:*' | head
redis-cli -a '<PASSWORD>' info keyspace
```

Loading the CRM dashboard twice within 20 seconds should produce a `ghr-prod:dashboard:crm:<id>:own`
key. If no keys appear, the application is not connected — re-read the boot log rather than guessing.

## 6. What does NOT change

**Keep `RUN_SCHEDULERS=false` on every web process.** `clusterTick` fails *open* — it runs the tick
when no lock is available, deliberately, so that a Redis-less deployment does not silently stop every
scheduled job. Redis makes single-execution robust; it does not make the flag optional. The
`crm-worker` app in `ecosystem.config.cjs` remains the one process with `RUN_SCHEDULERS=true`.

**No schema change, no migration, no code change.** Only the two variables above.

## 7. If Redis fails later

By design, an outage degrades rather than breaks:

- Commands fail fast (`enableOfflineQueue: false`) instead of queueing in memory
- Every command has a 1-second deadline (`COMMAND_TIMEOUT_MS`)
- Cache reads answer "not cached" and the request is served from PostgreSQL
- ioredis reconnects underneath with capped exponential backoff
- The readiness probe reports `down` without failing the whole health check

Queued jobs are the one thing genuinely at risk during an outage, which is what `appendonly yes`
above is for.

**Rollback:** comment out `REDIS_URL` and restart. Everything returns to the in-process behaviour.

## 8. Verifying the gain

The dashboard cache has never been measured — Redis was absent on the machine where the load test
ran, so every recorded dashboard figure is the uncached path. To measure it:

```bash
cd server
LOAD_API=http://localhost:8000 LOAD_CONCURRENCY=50 LOAD_ROUNDS=6 node scripts/load-test.cjs
```

Compare the `CRM dashboard` row against the same run with `REDIS_URL` commented out. Expect a large
p50 improvement and a smaller p95 one: the first request per user in each 20-second window still pays
full price, and the load test spreads across many distinct agents, each of which has its own key.
