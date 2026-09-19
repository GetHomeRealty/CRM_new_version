import { schedulerEnvironmentProblem } from '../config/environment';

/**
 * Whether this process should run background schedulers.
 *
 * Eleven of them live inside the API process — the IMAP poller, campaign resume, lead-task and
 * appointment reminders, Meta sync, the Google retry, the export sweeper, review SLA, mail
 * retention and lead birthday/anniversary greetings. Every one goes through `clusterTick`, so with
 * Redis exactly one process runs each
 * pass. WITHOUT Redis `clusterTick` deliberately runs the tick anyway — failing closed would
 * silently stop every scheduled job on a deployment that has none — so on more than one process
 * this flag is still the only thing standing between a brokerage and two IMAP syncs racing on one
 * mailbox.
 *
 * SINGLE PROCESS: default on, unchanged. `node dist/main.js` with nothing set behaves exactly as it
 * always has.
 *
 * UNDER A PROCESS MANAGER: the default inverts, and this is the important part. pm2 sets
 * `NODE_APP_INSTANCE` on every worker it forks. If that is present and nobody has said explicitly
 * whether this process owns the schedulers, the answer is NO — because the failure modes are not
 * symmetric. Forgetting to disable them means four processes emailing the same client four times,
 * which nobody notices until a client complains. Forgetting to enable them means the sweeps do not
 * run, which `GET /api/health/workers` reports within minutes as a stale scheduler.
 *
 * So: to run schedulers under pm2, a process must be told `RUN_SCHEDULERS=true`. The ecosystem file
 * gives that to the worker app and only the worker app.
 *
 * Tests never run them: a test run must not open network connections or send mail on a timer.
 * The existing per-scheduler flags still work and are finer-grained than this one.
 */
export function schedulersEnabled(): boolean {
  if (process.env.NODE_ENV === 'test') return false;

  /*
   * S-1. REFUSED OUTRIGHT when a non-production process holds the production database, whatever
   * RUN_SCHEDULERS says — this one is not a default that an explicit answer can win, because the
   * explicit answer is exactly what goes wrong: a developer copies the deploy host's environment,
   * inherits `RUN_SCHEDULERS=true` along with `DATABASE_URL`, and the reminder and welcome sweeps
   * begin working through the brokerage's real clients from a laptop.
   *
   * The mail gate would stop the message leaving. This stops the work happening at all, which also
   * covers what a sweep does besides mailing — marking rows as contacted, spending reminders — none
   * of which a sink can undo.
   */
  if (schedulerEnvironmentProblem()) return false;

  const v = process.env.RUN_SCHEDULERS;
  // An explicit answer always wins, in either direction, whatever else is going on.
  if (v !== undefined && v !== '') return v === 'true' || v === '1';

  // No explicit answer. Safe only if we are certain this is the sole process.
  return !underProcessManager();
}

/**
 * Is something forking us?
 *
 * `NODE_APP_INSTANCE` is pm2's, set on every worker in both fork and cluster mode.
 * `INSTANCE_ID` is the older pm2 name and is still emitted by some versions.
 * Node's own `cluster.isWorker` would be the general answer, but importing `cluster` here to ask
 * one question would pull it into every process that imports this file, so the environment is read
 * instead — which is also what a container orchestrator can set by hand.
 */
function underProcessManager(): boolean {
  return Boolean((process.env.NODE_APP_INSTANCE ?? process.env.INSTANCE_ID ?? '').trim());
}

/** One-line explanation of why a scheduler stayed idle, for the boot log. */
export const schedulerSkipReason = (): string => {
  if (process.env.NODE_ENV === 'test') return 'test environment';
  const environment = schedulerEnvironmentProblem();
  if (environment) return environment;
  const v = process.env.RUN_SCHEDULERS;
  if (v !== undefined && v !== '') return 'RUN_SCHEDULERS is off for this process';
  return `running under a process manager (instance ${process.env.NODE_APP_INSTANCE ?? process.env.INSTANCE_ID}) `
    + 'without RUN_SCHEDULERS=true — only the worker process should own the schedulers';
};
