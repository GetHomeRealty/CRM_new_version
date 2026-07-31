import { registerWorker, resetWorkers, workerFailed, workerFinished, workerSnapshot, workerStarted, trackedTick } from './worker-health';

/**
 * The logic that decides whether somebody gets woken up.
 *
 * A background timer fails in three ways that look identical from outside the process — it stopped,
 * its callback throws every pass, or it was never armed — and in all three the application serves
 * every page perfectly while the work silently does not happen. These tests pin the distinctions
 * that make each one reportable, and the two ways this could be useless: crying wolf about a
 * scheduler that is merely slow, or staying quiet about one that is failing every single pass.
 */
describe('background worker health', () => {
  beforeEach(() => resetWorkers());

  const only = () => workerSnapshot()[0];

  it('does not report a scheduler as stale before it has had time to start', () => {
    // Most of these delay their first pass after boot on purpose, so "never run" must not mean
    // "broken" for at least as long as that delay.
    registerWorker('imap-sync', 60_000);
    const w = only();
    expect(w.ageMs).toBeNull();
    expect(w.stale).toBe(false);
    expect(w.healthy).toBe(true);
  });

  it('reports a healthy scheduler that has completed a pass', () => {
    registerWorker('imap-sync', 60_000);
    workerStarted('imap-sync');
    workerFinished('imap-sync');
    const w = only();
    expect(w.runs).toBe(1);
    expect(w.stale).toBe(false);
    expect(w.healthy).toBe(true);
    expect(w.ageMs).toBeLessThan(1000);
  });

  it('goes stale once it has missed several of its own intervals', () => {
    jest.useFakeTimers();
    try {
      registerWorker('meta-sync', 60_000);
      workerStarted('meta-sync');
      workerFinished('meta-sync');
      expect(only().stale).toBe(false);

      // Two intervals: late, but within the grace that stops a slow pass paging anyone.
      jest.advanceTimersByTime(2 * 60_000);
      expect(only().stale).toBe(false);

      // Past three intervals plus a minute — no longer explicable by slowness.
      jest.advanceTimersByTime(3 * 60_000);
      expect(only().stale).toBe(true);
      expect(only().healthy).toBe(false);
    } finally { jest.useRealTimers(); }
  });

  it('reports a scheduler that runs but fails every pass as unhealthy, not as stale', () => {
    // The distinction matters to whoever reads the alert: "not running" and "running and throwing"
    // need different responses, and a timer that fires is not stale.
    registerWorker('lawyer-reminders', 3_600_000);
    workerStarted('lawyer-reminders');
    workerFailed('lawyer-reminders', new Error('SMTP refused the connection'));

    const w = only();
    expect(w.stale).toBe(false);
    expect(w.healthy).toBe(false);
    expect(w.failures).toBe(1);
    expect(w.runs).toBe(0);
    expect(w.lastError).toContain('SMTP refused');
  });

  it('recovers once a pass succeeds again', () => {
    registerWorker('export-sweeper', 900_000);
    workerStarted('export-sweeper');
    workerFailed('export-sweeper', new Error('boom'));
    expect(only().healthy).toBe(false);

    workerStarted('export-sweeper');
    workerFinished('export-sweeper');
    expect(only().healthy).toBe(true);
  });

  it('never lets a failing callback reject out of the timer', async () => {
    // An unhandled rejection from a setInterval callback takes the whole process down, which would
    // turn a broken mail sync into an outage.
    registerWorker('imap-sync', 60_000);
    const tick = trackedTick('imap-sync', () => Promise.reject(new Error('mailbox unreachable')));
    expect(() => tick()).not.toThrow();

    await new Promise((r) => setImmediate(r));
    const w = only();
    expect(w.failures).toBe(1);
    expect(w.lastError).toContain('mailbox unreachable');
  });

  it('records a successful pass through the wrapper', async () => {
    registerWorker('meta-sync', 900_000);
    trackedTick('meta-sync', async () => undefined)();
    await new Promise((r) => setImmediate(r));
    expect(only().runs).toBe(1);
    expect(only().healthy).toBe(true);
  });

  it('ignores a scheduler that was never registered rather than inventing one', () => {
    // Schedulers register only when they actually arm a timer, so one disabled on this process is
    // absent. Reporting it would mean permanently alerting about work nobody asked this process
    // to do.
    workerFinished('not-registered');
    expect(workerSnapshot()).toHaveLength(0);
  });
});
