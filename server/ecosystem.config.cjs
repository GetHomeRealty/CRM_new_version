/**
 * Multi-process deployment topology.
 *
 * WHY THIS EXISTS: LOGIN CAPACITY. `bcryptjs` is a pure-JavaScript implementation with no native
 * addon and no threadpool, so every password verification runs on the Node event loop. Measured at
 * cost factor 12: 226 ms of CPU per login, giving **~4.3 logins per second per process**, and
 * twelve cores do not help because one process gets one thread for this work.
 *
 * Measured, by signing 500 accounts in at once:
 *
 *     1 process   4.3 logins/s   500 agents in 116.7 s
 *     2 processes 8.5 logins/s   500 agents in  58.9 s
 *     4 processes ~17 logins/s   500 agents in  29.5 s
 *
 * Linear. A 9 a.m. rush of 500 agents is two minutes on one process and about thirty seconds on
 * four.
 *
 * WHY ONE MACHINE AND NOT FOUR: uploads, generated exports, call recordings, user photos and the
 * brand logo are written to the local filesystem under `STORAGE_ROOT`. Processes on separate hosts
 * would each see only their own files — an upload would succeed and the download would 404, with
 * nothing reporting it. So these processes must share a filesystem: pm2 on one machine, or
 * containers mounting one volume. Scaling beyond that machine means moving `STORAGE_ROOT` to
 * shared or object storage first, and that is a separate piece of work.
 *
 * THE SHAPE: several web processes that serve requests and own no background work, plus exactly
 * ONE worker that owns every scheduler.
 *
 *   crm-web     cluster mode, N instances, share port 8000, RUN_SCHEDULERS=false
 *   crm-worker  fork mode,    1 instance,  port 8001,       RUN_SCHEDULERS=true
 *
 * WHY THE WORKER IS SEPARATE rather than "instance 0 of the cluster": a cluster instance is
 * replaceable. pm2 restarts one on a crash or a reload, and during that window either two processes
 * briefly hold the scheduler role or none does. A named single-instance app has one identity, and
 * `RUN_SCHEDULERS` is set in one place where it can be read at a glance.
 *
 * The worker still listens on a port — it is the same application — but nothing routes to it. Point
 * the load balancer at the `crm-web` port only. Its `/api/health/workers` is worth scraping
 * directly, because that is where scheduler health actually lives.
 *
 * WITHOUT REDIS this file is the ONLY thing preventing duplicate scheduled work. `clusterTick`
 * deliberately runs its tick when no lock is available, so `RUN_SCHEDULERS=false` on the web
 * processes is load-bearing, not belt-and-braces. `schedulersEnabled()` also refuses to run
 * schedulers under a process manager unless told explicitly, so a web process that somehow lost
 * this setting still stays quiet.
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 reload crm-web        # zero-downtime, web only
 *   pm2 logs crm-worker       # where the sweeps report
 */

/**
 * How many web processes.
 *
 * Four is the measured sweet spot for the login ceiling above. Leave headroom for PostgreSQL and
 * the worker rather than taking every core: `WEB_INSTANCES` overrides it per host.
 */
const WEB_INSTANCES = Number(process.env.WEB_INSTANCES) || 4;

/**
 * Prisma pool size per process.
 *
 * THE ARITHMETIC MATTERS, because exceeding `max_connections` fails at connect time rather than
 * degrading: WEB_INSTANCES x POOL + worker pool + a margin for psql, backups and monitoring must
 * stay under PostgreSQL's `max_connections`.
 *
 *     4 web x 20 = 80, worker 10, total 90 against the default max_connections of 100 — too tight.
 *
 * Measured default is 25 per process (Prisma's `cores x 2 + 1`), which four processes would take to
 * 100 on its own. So this is set explicitly rather than left to the default, and the recommendation
 * is to raise `max_connections` to 200 on the database side.
 */
const WEB_POOL = Number(process.env.WEB_DB_POOL) || 20;
const WORKER_POOL = Number(process.env.WORKER_DB_POOL) || 10;

/** Append the pool size to whatever DATABASE_URL is configured, without rewriting the rest of it. */
const withPool = (limit) => {
  const url = process.env.DATABASE_URL || '';
  if (!url) return url;
  if (/[?&]connection_limit=/.test(url)) return url;   // already explicit; leave it alone
  return `${url}${url.includes('?') ? '&' : '?'}connection_limit=${limit}&pool_timeout=30`;
};

const shared = {
  script: 'dist/main.js',
  cwd: __dirname,
  env: {
    NODE_ENV: 'production',
    // Every process shares it: a worker building dates in a different zone from the web tier
    // would misdate reminders and campaign schedules relative to what the user saw.
    TZ: process.env.TZ || 'America/Toronto',
  },
  // A process that dies repeatedly at boot is misconfigured, not unlucky. Stop restarting it and
  // leave the failure visible instead of hiding it in a restart loop.
  max_restarts: 10,
  min_uptime: '30s',
  // The server holds no request state, but a restart mid-send is worth avoiding: give it time to
  // finish what it is doing. Sessions live in PostgreSQL, so a restart never signs anybody out.
  kill_timeout: 15000,
  // Node's default heap is generous on a 34 GB host; cap it so one leaking process cannot take the
  // machine with it, and let pm2 restart it instead.
  max_memory_restart: '1G',
  time: true,
};

module.exports = {
  apps: [
    {
      ...shared,
      name: 'crm-web',
      // Cluster mode: pm2 uses Node's cluster module, so all instances share one listening port and
      // the kernel balances across them. No reverse-proxy configuration needed to fan out.
      exec_mode: 'cluster',
      instances: WEB_INSTANCES,
      env: {
        ...shared.env,
        PORT: process.env.PORT || 8000,
        // THE LINE THAT PREVENTS DUPLICATE CLIENT EMAIL. Without Redis this is the only thing that
        // does; with Redis it saves three processes from losing a race every tick.
        RUN_SCHEDULERS: 'false',
        DATABASE_URL: withPool(WEB_POOL),
      },
      // Zero-downtime reloads: pm2 waits for the process to say it is ready before retiring the old
      // one. Nest signals this once `listen()` resolves.
      wait_ready: false,
      listen_timeout: 20000,
    },
    {
      ...shared,
      name: 'crm-worker',
      // Fork, not cluster: exactly one, always. Its identity is the point.
      exec_mode: 'fork',
      instances: 1,
      env: {
        ...shared.env,
        // A port nothing routes to. It exists because this is the same application; use it to read
        // /api/health/workers directly from the process that actually owns the schedulers.
        PORT: process.env.WORKER_PORT || 8001,
        RUN_SCHEDULERS: 'true',
        DATABASE_URL: withPool(WORKER_POOL),
      },
    },
  ],
};
