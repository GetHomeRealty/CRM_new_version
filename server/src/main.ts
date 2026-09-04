import cluster from 'node:cluster';
import { cpus } from 'node:os';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { Pool } from 'pg';
import helmet from 'helmet';
import { AppModule } from './app.module';
import configuration from './config/configuration';
import { assertProductionConfig } from './config/validate-config';
import { corsOptions } from './config/cors';
import { STORAGE_ROOT, checkStorageRoot } from './config/storage';
import { laravelValidationExceptionFactory } from './common/laravel-exceptions';
import { installShutdownHandlers } from './common/shutdown';

import { StructuredLogger } from './observability/log';
// Runtime-generated CRM files contain private client data.
// 0077 makes new files owner-only and new directories owner-only.
process.umask(0o077);

async function bootstrap(): Promise<void> {
  // `rawBody` keeps the exact bytes of each request alongside the parsed body. The Meta webhook
  // needs them: its HMAC signature is computed over the raw payload, and re-serialising the
  // parsed JSON changes the bytes and breaks verification.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    // Every `new Logger(...)` already in the codebase emits structured lines from here on, without
    // any of those 27 files being touched.
    logger: new StructuredLogger(),
  });
  // Pure, deterministic from env — identical to what ConfigModule loaded for DI.
  const appCfg = configuration();

  // Checked before anything binds a port. Each setting it guards fails silently at runtime
  // rather than at boot — a non-secure cookie is discarded by the browser, so login "works" and
  // the next request is anonymous — so a deploy that stops here is the cheap outcome.
  assertProductionConfig(appCfg);

  // Where uploads live. Checked before serving, because an unreachable or wrong storage root
  // fails only at the moment someone uploads or opens a document — and a *wrong* one is worse
  // than an unreachable one: writes succeed into the new place while every existing file appears
  // to have vanished. Logged unconditionally so the resolved path is never a matter of guesswork.
  const storage = checkStorageRoot(appCfg.env);
  if (!storage.ok) throw new Error(`Refusing to start: ${storage.problem}\n`);
  new Logger('Storage').log(`Files are stored in ${STORAGE_ROOT}`);

  // All API routes live under /api (matching Laravel). The Sanctum CSRF-cookie
  // route is served at the root, so it is excluded from the prefix.
  app.setGlobalPrefix('api', { exclude: ['sanctum/csrf-cookie'] });

  // Express defaults to a 100 KB JSON body, which is far below what this app posts: campaign
  // template attachments and document uploads arrive base64-encoded, so a 5 MB file is ~6.7 MB
  // on the wire. Without this the server answers 413 and the size limits enforced in code are
  // never even reached.
  app.useBodyParser('json', { limit: '12mb' });
  app.useBodyParser('urlencoded', { limit: '12mb', extended: true });

  // Trust the proxy so secure cookies work behind nginx in production. It is also what makes
  // rate limiting meaningful: without it every request appears to come from the proxy's address
  // and the whole site would share one bucket.
  app.set('trust proxy', 1);


  // Security response headers: HSTS, nosniff, no referrer leakage, framing and CSP.
  app.use(
    helmet({
      // Two things this API serves are *meant* to be loaded from other origins, and the default
      // (same-origin) silently blocks both:
      //   - the campaign open-tracking pixel, fetched by recipients' mail clients;
      //   - the brand logo and user photos, used as <img src> by the SPA, which in development
      //     runs on a different port.
      // Cross-origin READS of these is the intended behaviour; what must stay closed is
      // credentialed API access, and that is CORS's job, which is configured above.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      // The one HTML page this API serves (campaign unsubscribe) styles itself with inline
      // `style` attributes, which helmet's default style-src already permits. Scripts are not
      // relaxed: nothing here serves any.
    }),
  );

  // CORS for the React SPA — credentials required for cookie auth, and the export headers
  // the download helpers read (TD-046). See `config/cors.ts`.
  app.enableCors(corsOptions(appCfg.corsOrigins));

  // Server-side sessions (cookie-based), emulating the Sanctum SPA contract.
  // Persisted in Postgres (connect-pg-simple → `user_sessions` table) so sessions
  // survive restarts and scale across instances — production-grade, like Laravel's
  // database session driver. The session payload (user id + XSRF token) is unchanged.
  const PgStore = connectPgSimple(session);
  const sessionPool = new Pool({ connectionString: appCfg.databaseUrl });

  /*
   * WITHOUT THIS LISTENER THE PROCESS DIES WHENEVER POSTGRES HICCUPS.
   *
   * `pg.Pool` is an EventEmitter, and it emits `error` on behalf of IDLE clients — a Postgres
   * restart, a failover, an admin `pg_terminate_backend`, an `idle_in_transaction_session_timeout`,
   * or a network blip all reach us this way, with no query in flight to reject and no `await` to
   * catch it. An `error` event with no listener is thrown by EventEmitter itself, which lands in
   * `uncaughtException`; that handler treats the process as untrustworthy — correctly, in the
   * general case — and shuts down with exit code 1, so the supervisor restarts the app.
   *
   * The result is a healthy process being recycled by something that is not its fault and that it
   * had already recovered from: the pool discards the dead client and opens another on the next
   * request. So this is NOT swallowing a fatal error to keep a restart count down — the event is
   * genuinely non-fatal, and the crash was an artefact of nobody listening. It is logged at `error`
   * so a real database problem is still loud, and repeated lines still say "Postgres keeps dropping
   * connections" to anyone reading.
   *
   * Registered immediately after construction, before `app.use` can put the pool to work, so there
   * is no window in which the pool is live and unlistened.
   */
  const poolLog = new Logger('SessionStore');
  sessionPool.on('error', (err: Error) => {
    poolLog.error(`Idle session-store connection dropped by Postgres: ${err.message}. `
      + 'The pool will open a new connection on the next request; the process is left running.');
  });

  app.use(
    session({
      store: new PgStore({ pool: sessionPool, tableName: 'user_sessions', createTableIfMissing: true, pruneSessionInterval: 60 * 15 }),
      name: appCfg.session.cookieName,
      secret: appCfg.session.secret,
      resave: false,
      saveUninitialized: false,
      // Slide the expiry on every response. Without this the cookie dies a fixed
      // SESSION_LIFETIME_MINUTES after sign-in no matter how active the user is, and the next
      // save fails mid-edit — surfacing as a bare "CSRF token mismatch" because the session
      // holding the token is gone. Idle users still time out; working users don't.
      rolling: true,
      cookie: {
        httpOnly: true,
        secure: appCfg.session.secure,
        sameSite: appCfg.session.sameSite,
        domain: appCfg.session.domain,
        path: '/',
        maxAge: appCfg.session.lifetimeMinutes * 60 * 1000,
      },
    }),
  );

  // Mirror Laravel FormRequest behaviour: reject unknown fields, coerce types,
  // and emit validation failures in Laravel's 422 { message, errors } shape.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      exceptionFactory: laravelValidationExceptionFactory,
    }),
  );

  await app.listen(appCfg.port, '127.0.0.1');
  // eslint-disable-next-line no-console
  console.log(`Transaction Desk API listening on http://localhost:${appCfg.port}`);

  // Every deploy stops this process. Without handlers that is an instant kill mid-request,
  // with the IMAP sockets dropped and Prisma never disconnected.
  installShutdownHandlers(app, sessionPool);
}

/**
 * How many worker processes serve HTTP. One means "exactly as before, no cluster at all".
 *
 * WHY THIS EXISTS. Node runs JavaScript on one thread, so one process uses one core however many
 * the machine has. Measured on a twelve-core box at 80,000 transactions, throughput saturated at
 * roughly 60 requests per second and stayed there whether 100, 300 or 600 users were signed in —
 * the extra users queued rather than failed. That ceiling is the single thread, not the database:
 * PostgreSQL was at 26 connections of 100 with no lock waits.
 *
 * `WEB_CONCURRENCY` is the conventional name for this (Heroku, Foreman, gunicorn). `0` or `max`
 * means one worker per core.
 *
 * Env: WEB_CONCURRENCY
 */
function workerCount(): number {
  const raw = (process.env.WEB_CONCURRENCY ?? '1').trim().toLowerCase();
  const cores = cpus().length;
  if (raw === 'max' || raw === '0') return Math.max(1, cores);
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), cores * 2) : 1;
}

/**
 * Fork the workers, and make sure EXACTLY ONE of them runs the schedulers.
 *
 * That last part is the whole reason this is not just `cluster.fork()` in a loop. The IMAP poller,
 * the reminder sweeps, the export sweeper and the retention sweep are timers inside the process, not
 * distributed jobs — four workers with the default `RUN_SCHEDULERS=true` would mean four IMAP syncs
 * racing on one mailbox and four copies of every reminder arriving at a real client. Only worker 0
 * inherits the configured value; the others are told no, and cannot be told otherwise by the
 * environment.
 *
 * Node's cluster module shares ONE listening socket across the workers, so this needs no proxy and
 * changes no URL: the operating system distributes accepted connections. Sessions live in
 * PostgreSQL (`connect-pg-simple`), so a request landing on a different worker than the one that
 * signed the user in is already the normal case and needs nothing here.
 *
 * A worker that dies is replaced. A worker that dies DURING SHUTDOWN is not — otherwise stopping the
 * service would fork forever.
 */
function runCluster(workers: number): void {
  const log = new Logger('Cluster');
  log.log(`Starting ${workers} worker processes (WEB_CONCURRENCY). Schedulers run on worker 1 only.`);

  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      stopping = true;
      for (const w of Object.values(cluster.workers ?? {})) w?.kill(signal);
    });
  }

  const forked: number[] = [];
  const fork = (index: number): void => {
    // Only the first worker keeps whatever RUN_SCHEDULERS was configured as; the rest are off.
    const worker = cluster.fork({ RUN_SCHEDULERS: index === 0 ? (process.env.RUN_SCHEDULERS ?? 'true') : 'false' });
    forked[worker.id] = index;
  };
  for (let i = 0; i < workers; i += 1) fork(i);

  cluster.on('exit', (worker, code, signal) => {
    const index = forked[worker.id] ?? 0;
    if (stopping) return;
    log.error(`Worker ${worker.process.pid} (#${index + 1}) exited (${signal ?? code}); replacing it.`);
    fork(index);
  });
}

const workers = workerCount();
if (workers > 1 && cluster.isPrimary) {
  runCluster(workers);
} else {
  void bootstrap();
}
