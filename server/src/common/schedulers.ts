/**
 * Whether this process should run background schedulers.
 *
 * Three of them live inside the API process — the IMAP poller, the export sweeper, and the
 * lawyer-detail reminders. They are plain timers, not distributed jobs, so there is nothing to
 * stop two processes running the same one: pm2 in cluster mode, or a second container, means two
 * IMAP syncs racing on one mailbox and two copies of every reminder email arriving at a real
 * client. Nothing in the application would report that; it would simply be happening.
 *
 * Default is on, which is correct for the single instance this deployment runs — uploads are
 * written to local disk, so it cannot meaningfully scale out regardless. If a second process is
 * ever added, give it RUN_SCHEDULERS=false and leave exactly one with the schedulers on.
 *
 * Tests never run them: a test run must not open network connections or send mail on a timer.
 * The existing per-scheduler flags still work and are finer-grained than this one.
 */
export function schedulersEnabled(): boolean {
  if (process.env.NODE_ENV === 'test') return false;
  const v = process.env.RUN_SCHEDULERS;
  if (v === undefined || v === '') return true;
  return v === 'true' || v === '1';
}

/** One-line explanation of why a scheduler stayed idle, for the boot log. */
export const schedulerSkipReason = (): string =>
  process.env.NODE_ENV === 'test' ? 'test environment' : 'RUN_SCHEDULERS is off for this process';
