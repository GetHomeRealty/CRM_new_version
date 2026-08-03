/**
 * Failed audit writes, counted so somebody finds out.
 *
 * Audit writes are best-effort by design: a lead change must not be rolled back because the trail
 * could not be written. That trade-off is defensible on its own, but it was paired with a
 * `log.warn` and nothing else — so a broken audit trail produced one line in a log nobody greps,
 * and the application carried on looking healthy. The compliance consequence is that the ABSENCE
 * of an audit entry stopped being evidence of anything: you could not tell "it did not happen"
 * from "it happened and we failed to record it".
 *
 * This does not make the write reliable. It makes the failure impossible to miss: the count is
 * surfaced on /api/health/workers, which the monitor already polls every five minutes, and the
 * failure itself is logged at ERROR so it reaches error-rate alerting too.
 *
 * Deliberately in-process and unpersisted. It resets on restart, which is correct — the question
 * it answers is "is the audit trail failing *now*", and the log carries the history.
 */

export interface AuditHealth {
  /** Failed writes since this process started. Zero is the only acceptable steady state. */
  failures: number;
  /** When the most recent one happened, ISO, or null if there have been none. */
  last_failed_at: string | null;
  /** What went wrong most recently, truncated. Null if there have been none. */
  last_error: string | null;
  /** Which audit action was being recorded when it last failed. */
  last_action: string | null;
}

let failures = 0;
let lastFailedAt: Date | null = null;
let lastError: string | null = null;
let lastAction: string | null = null;

/** Record that an audit write failed. Never throws — it is called from a catch block. */
export function recordAuditFailure(action: string, err: unknown): void {
  failures += 1;
  lastFailedAt = new Date();
  lastAction = action;
  lastError = (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

export function auditHealth(): AuditHealth {
  return {
    failures,
    last_failed_at: lastFailedAt ? lastFailedAt.toISOString() : null,
    last_error: lastError,
    last_action: lastAction,
  };
}

/** Test hook. */
export function resetAuditHealth(): void {
  failures = 0;
  lastFailedAt = null;
  lastError = null;
  lastAction = null;
}
