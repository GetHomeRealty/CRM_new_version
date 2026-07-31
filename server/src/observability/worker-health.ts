/**
 * A record of when each background timer last ran, so "the schedulers stopped" is detectable.
 *
 * Four schedulers live inside the API process — the IMAP poller, the Meta lead-ad sync, the export
 * sweeper and the lawyer-detail reminders. They are plain `setInterval` timers, which means the
 * failure that matters is not an exception: it is a timer that silently stopped, or one whose
 * callback is throwing every pass while the application looks perfectly healthy from outside. The
 * process is up, the database is reachable, `/ready` is green, and nobody's leads have synced for
 * three days.
 *
 * NOTHING CAN DETECT AN EVENT THAT DID NOT OCCUR, so as with backups this is checked by STALENESS:
 * each scheduler declares how often it expects to run, records each pass here, and anything that
 * has not reported within a generous multiple of its own interval is reported as stale. That covers
 * a stopped timer, a wedged callback and a process that was restarted and never re-armed, all of
 * which look identical from the outside and all of which need the same response.
 *
 * In-process and not persisted, deliberately: a restart resets these, and a restart is also when
 * the timers are re-armed, so there is nothing to carry across. Consumed by `/api/health/workers`.
 */

export interface WorkerRun {
  /** Expected gap between runs, in ms. Used to judge staleness. */
  intervalMs: number;
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  runs: number;
  failures: number;
}

export interface WorkerSnapshot extends WorkerRun {
  name: string;
  /** Null when it has never run — which is different from "ran and is late". */
  ageMs: number | null;
  /** Late by its own standard: no completed run within 3 intervals plus a minute of slack. */
  stale: boolean;
  healthy: boolean;
}

const workers = new Map<string, WorkerRun>();

/**
 * Declare a scheduler at start-up, whether or not it is enabled.
 *
 * Registering a DISABLED scheduler would make it permanently stale and cry wolf forever, so callers
 * only register when they actually arm their timer. A scheduler deliberately turned off on this
 * process (RUN_SCHEDULERS=false) is therefore simply absent, which is the honest answer.
 */
export function registerWorker(name: string, intervalMs: number): void {
  if (!workers.has(name)) {
    workers.set(name, { intervalMs, lastStartedAt: null, lastFinishedAt: null, lastError: null, lastErrorAt: null, runs: 0, failures: 0 });
  }
}

export function workerStarted(name: string): void {
  const w = workers.get(name);
  if (w) w.lastStartedAt = Date.now();
}

export function workerFinished(name: string): void {
  const w = workers.get(name);
  if (!w) return;
  w.lastFinishedAt = Date.now();
  w.runs += 1;
}

export function workerFailed(name: string, err: unknown): void {
  const w = workers.get(name);
  if (!w) return;
  w.failures += 1;
  w.lastError = err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300);
  w.lastErrorAt = Date.now();
  // A failed pass still counts as the timer having fired: the distinction between "not running"
  // and "running and failing" is exactly what makes this useful, so lastFinishedAt is set too.
  w.lastFinishedAt = Date.now();
}

export function workerSnapshot(): WorkerSnapshot[] {
  const now = Date.now();
  return [...workers.entries()].map(([name, w]) => {
    const ageMs = w.lastFinishedAt === null ? null : now - w.lastFinishedAt;
    // Three intervals of grace, plus a minute, so a slow pass or a busy moment is never an alert.
    const budget = w.intervalMs * 3 + 60_000;
    // Never-run is not stale until it has had a full budget to get going — the first pass of most
    // of these is deliberately delayed after boot.
    const sinceStart = now - (w.lastStartedAt ?? now);
    const stale = ageMs === null ? sinceStart > budget : ageMs > budget;
    return {
      name, ...w, ageMs, stale,
      // Failing every pass is unhealthy even though the timer is clearly alive.
      healthy: !stale && !(w.runs === 0 && w.failures > 0),
    };
  });
}

/**
 * Wraps a timer callback so each pass is recorded without every scheduler growing its own
 * try/catch. Returns a function safe to hand straight to `setInterval`/`setTimeout`: it never
 * rejects, because an unhandled rejection from a timer callback takes the process down.
 */
export function trackedTick(name: string, fn: () => Promise<unknown>): () => void {
  return () => {
    workerStarted(name);
    void (async () => {
      try { await fn(); workerFinished(name); } catch (err) { workerFailed(name, err); }
    })();
  };
}

/** Test seam. */
export function resetWorkers(): void {
  workers.clear();
}
