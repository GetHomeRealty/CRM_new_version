/**
 * The queue contract, shared by both drivers.
 *
 * WHY THERE IS AN INTERFACE AT ALL RATHER THAN JUST BULLMQ. This deployment has no Redis in
 * production. A BullMQ-only implementation would mean the feature cannot ship until infrastructure
 * catches up, and would make Redis a single point of failure for work that currently runs fine on a
 * timer. Two drivers behind one interface means the same calling code runs either way, and
 * `REDIS_URL` is the only thing that decides which — so adopting Redis later is a config change,
 * not a rewrite.
 *
 * The in-process driver is not a stub or a test double. It is the production path today, and it
 * implements the same guarantees the brief asks for: retries, exponential backoff, dead-letter
 * handling, progress, cancellation and logging. What it CANNOT do is coordinate across processes —
 * which is precisely what Redis buys, and is stated plainly rather than papered over.
 */

/** The queues this application runs. Named, not free-form, so a typo cannot create a silent queue. */
export const QUEUE_NAMES = [
  'email',
  'sms',
  'reminder',
  'calendar-sync',
  'notification',
  'export',
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

export interface JobOptions {
  /**
   * How many times to try IN TOTAL, including the first. Default 3.
   *
   * A job that is not safe to run twice must use 1 and handle its own idempotency — retrying a
   * "send this email" job that already reached the SMTP server sends it twice.
   */
  attempts?: number;
  /** Delay before the first attempt, in milliseconds. */
  delayMs?: number;
  /** Base for the exponential backoff between attempts. Default 1000ms → 1s, 2s, 4s… */
  backoffMs?: number;
  /**
   * A stable identifier for this unit of work. Two jobs with the same id are the same job: the
   * second is dropped rather than queued. This is what makes "sync mailbox 7" safe to enqueue from
   * a timer that may fire while the previous run is still going.
   */
  jobId?: string;
}

export interface JobContext {
  id: string;
  queue: QueueName;
  /** 1 for the first try. Handlers that behave differently on a retry can read it. */
  attempt: number;
  /** Report progress 0–100. Surfaced by the monitoring endpoint. */
  progress: (percent: number) => Promise<void>;
  /**
   * True once the job has been asked to stop. Long handlers should check it between units of work
   * and return early — cancellation cannot interrupt a running function from outside.
   */
  cancelled: () => boolean;
}

export type JobHandler<T = unknown> = (payload: T, ctx: JobContext) => Promise<unknown>;

export interface JobRecord {
  id: string;
  queue: QueueName;
  state: 'waiting' | 'active' | 'completed' | 'failed' | 'dead' | 'cancelled';
  attempts: number;
  maxAttempts: number;
  progress: number;
  enqueuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

export interface QueueStats {
  queue: QueueName;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  /** Jobs that exhausted every attempt. These need a person, which is the point of naming them. */
  dead: number;
}

export interface QueueDriver {
  /** 'redis' or 'in-process' — reported by the monitoring endpoint so nobody has to guess. */
  readonly kind: 'redis' | 'in-process';
  register<T>(queue: QueueName, handler: JobHandler<T>): void;
  add<T>(queue: QueueName, payload: T, options?: JobOptions): Promise<string>;
  cancel(queue: QueueName, jobId: string): Promise<boolean>;
  stats(): Promise<QueueStats[]>;
  /** The dead-letter contents, for the screen that has to show a human what needs attention. */
  dead(queue?: QueueName): Promise<JobRecord[]>;
  /** Re-queue a dead job after whatever broke it has been fixed. */
  retryDead(queue: QueueName, jobId: string): Promise<boolean>;
  shutdown(): Promise<void>;
}
