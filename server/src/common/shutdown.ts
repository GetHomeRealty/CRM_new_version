import { Logger } from '@nestjs/common';

/**
 * Stopping cleanly when the process is asked to stop — which happens on every deploy.
 *
 * Without this, SIGTERM kills the process outright: a request mid-response is cut off, the IMAP
 * poller's sockets are dropped rather than closed, and Prisma never disconnects. `app.close()`
 * runs the framework's own teardown — the `onModuleDestroy` hooks that clear the poll timers and
 * disconnect the database — while letting in-flight requests finish.
 *
 * Nest's `enableShutdownHooks()` is deliberately not used. It installs its own signal listeners
 * and calls `app.close()`, which leaves the session store's connection pool open: that pool is
 * created in main.ts outside dependency injection, so nothing in the module graph knows to close
 * it, and an open pool keeps the event loop alive until the supervisor gives up and sends
 * SIGKILL — the exact outcome being avoided.
 */

/** The parts of a Nest application and a pg Pool this needs, so both can be faked in tests. */
export interface ClosableApp { close(): Promise<unknown> }
export interface ClosablePool { end(): Promise<unknown> }

export interface ShutdownOptions {
  log?: Pick<Logger, 'log' | 'error'>;
  /** Overridden in tests so a shutdown does not take the test runner with it. */
  exit?: (code: number) => void;
}

export type Shutdown = (signal: string, code?: number) => Promise<void>;

/**
 * Build the shutdown routine. Both resources are closed even if the first one fails: they are
 * independent, and skipping the pool because the app threw would leave the process alive with
 * open database connections — a hang instead of an error.
 */
export function createShutdown(app: ClosableApp, pool: ClosablePool, opts: ShutdownOptions = {}): Shutdown {
  const log = opts.log ?? new Logger('Shutdown');
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let closing = false;

  return async function shutdown(signal: string, code = 0): Promise<void> {
    // A second Ctrl-C, or a signal arriving while the first teardown is still running, must not
    // start a second one — that would call close() twice and race the exit.
    if (closing) return;
    closing = true;
    log.log(`${signal} received — finishing in-flight requests and closing connections.`);

    let failed = false;
    try {
      await app.close();
    } catch (err) {
      failed = true;
      log.error(`Application did not close cleanly: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await pool.end();
    } catch (err) {
      failed = true;
      log.error(`Session pool did not close cleanly: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!failed) log.log('Shutdown complete.');
    exit(failed ? code || 1 : code);
  };
}

/**
 * Register the process-level handlers.
 *
 * SIGTERM is what an orchestrator, systemd or `pm2 reload` sends; SIGINT is Ctrl-C. Note that
 * Windows cannot deliver either to a Node process — it terminates immediately instead — so this
 * path only takes effect on the Linux host that actually runs production.
 */
export function installShutdownHandlers(app: ClosableApp, pool: ClosablePool, opts: ShutdownOptions = {}): Shutdown {
  const log = opts.log ?? new Logger('Shutdown');
  const shutdown = createShutdown(app, pool, { ...opts, log });

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // An unhandled rejection terminates the process by default in current Node, taking every live
  // request with it and printing only a stack. One background job that forgot a `.catch()` must
  // not be able to do that, so it is logged and the server keeps serving.
  process.on('unhandledRejection', (reason) => {
    log.error(`Unhandled promise rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
  });

  // An uncaught exception is different in kind: the process is in an unknown state and cannot be
  // trusted to keep answering correctly. Log it, then shut down properly so the supervisor starts
  // a clean one — rather than dying instantly in the middle of a request.
  process.on('uncaughtException', (err) => {
    log.error(`Uncaught exception: ${err.stack ?? err.message}`);
    void shutdown('uncaughtException', 1);
  });

  return shutdown;
}
