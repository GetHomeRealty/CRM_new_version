import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  QUEUE_NAMES,
  type JobHandler,
  type JobOptions,
  type JobRecord,
  type QueueDriver,
  type QueueName,
  type QueueStats,
} from './queue.types';

interface Entry {
  record: JobRecord;
  payload: unknown;
  options: Required<Pick<JobOptions, 'attempts' | 'backoffMs'>>;
  runAt: number;
  cancelled: boolean;
}

/**
 * The queue, running inside this process.
 *
 * WHAT THIS IS FOR. It is the production path on a deployment with no Redis, and it is a real
 * queue rather than a placeholder: work is taken off the request path, retried with exponential
 * backoff, capped by concurrency, cancellable, and parked in a dead-letter list when it finally
 * gives up. A handler that throws no longer takes the caller down with it.
 *
 * WHAT IT HONESTLY CANNOT DO, stated here rather than discovered later:
 *   - It does not survive a restart. Jobs waiting in memory are lost when the process stops. Every
 *     job this application enqueues is either re-derivable from the database on the next sweep or
 *     safe to lose (a notification recount); nothing here is the only record of anything.
 *   - It does not coordinate across processes. Two API instances each run their own queue, so
 *     `jobId` de-duplication is per-process. That is exactly the gap `common/schedulers.ts` already
 *     describes for timers, and exactly what the Redis driver closes.
 *
 * Both limits are why `RUN_SCHEDULERS` still matters, and why the monitoring endpoint reports which
 * driver is live.
 */
export class InProcessQueueDriver implements QueueDriver {
  readonly kind = 'in-process' as const;
  private readonly log = new Logger('Queue:in-process');

  private readonly handlers = new Map<QueueName, JobHandler<never>>();
  private readonly waiting = new Map<QueueName, Entry[]>();
  private readonly active = new Map<QueueName, Set<string>>();
  private readonly deadLetter = new Map<QueueName, JobRecord[]>();
  private readonly counters = new Map<QueueName, { completed: number; failed: number }>();
  /** Every job's record, so `cancel` and the monitor can find one by id. */
  private readonly records = new Map<string, Entry>();

  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  /** How many jobs of one queue may run at once. Bounded so a burst cannot exhaust the event loop. */
  static readonly CONCURRENCY = 4;
  /** How often the scheduler looks for due work. */
  static readonly TICK_MS = 250;
  /** How many dead jobs to keep per queue. Enough to diagnose, bounded so memory cannot grow. */
  static readonly DEAD_LIMIT = 100;

  constructor() {
    for (const q of QUEUE_NAMES) {
      this.waiting.set(q, []);
      this.active.set(q, new Set());
      this.deadLetter.set(q, []);
      this.counters.set(q, { completed: 0, failed: 0 });
    }
    this.timer = setInterval(() => this.drain(), InProcessQueueDriver.TICK_MS);
    // Never hold the process open: a queue with nothing to do must not stop node from exiting.
    this.timer.unref?.();
  }

  register<T>(queue: QueueName, handler: JobHandler<T>): void {
    if (this.handlers.has(queue)) {
      // Registering twice means two copies of the same work would run. Loud, because it is the kind
      // of mistake that only shows up as duplicate emails in somebody's inbox.
      this.log.warn(`A handler for the "${queue}" queue was already registered; the newer one replaces it.`);
    }
    this.handlers.set(queue, handler as JobHandler<never>);
  }

  async add<T>(queue: QueueName, payload: T, options: JobOptions = {}): Promise<string> {
    const id = options.jobId ?? randomUUID();

    // De-duplication by id: the same unit of work already waiting or running is not queued twice.
    const existing = this.records.get(id);
    if (existing && (existing.record.state === 'waiting' || existing.record.state === 'active')) {
      this.log.debug(`Job ${id} is already ${existing.record.state} on "${queue}" — not queued again.`);
      return id;
    }

    const entry: Entry = {
      record: {
        id,
        queue,
        state: 'waiting',
        attempts: 0,
        maxAttempts: Math.max(1, options.attempts ?? 3),
        progress: 0,
        enqueuedAt: new Date().toISOString(),
      },
      payload,
      options: { attempts: Math.max(1, options.attempts ?? 3), backoffMs: options.backoffMs ?? 1_000 },
      runAt: Date.now() + Math.max(0, options.delayMs ?? 0),
      cancelled: false,
    };

    this.waiting.get(queue)!.push(entry);
    this.records.set(id, entry);
    return id;
  }

  async cancel(queue: QueueName, jobId: string): Promise<boolean> {
    const entry = this.records.get(jobId);
    if (!entry || entry.record.queue !== queue) return false;
    if (entry.record.state === 'completed' || entry.record.state === 'dead') return false;

    entry.cancelled = true;
    if (entry.record.state === 'waiting') {
      // Not started: remove it outright.
      const queueWaiting = this.waiting.get(queue)!;
      const at = queueWaiting.indexOf(entry);
      if (at >= 0) queueWaiting.splice(at, 1);
      entry.record.state = 'cancelled';
      entry.record.finishedAt = new Date().toISOString();
    }
    // If it is active, the flag is all that can be done — a running function cannot be interrupted
    // from outside. The handler is expected to check `ctx.cancelled()` between units of work.
    return true;
  }

  async stats(): Promise<QueueStats[]> {
    return QUEUE_NAMES.map((queue) => {
      const counts = this.counters.get(queue)!;
      return {
        queue,
        waiting: this.waiting.get(queue)!.length,
        active: this.active.get(queue)!.size,
        completed: counts.completed,
        failed: counts.failed,
        dead: this.deadLetter.get(queue)!.length,
      };
    });
  }

  async dead(queue?: QueueName): Promise<JobRecord[]> {
    const queues = queue ? [queue] : [...QUEUE_NAMES];
    return queues.flatMap((q) => this.deadLetter.get(q) ?? []);
  }

  async retryDead(queue: QueueName, jobId: string): Promise<boolean> {
    const list = this.deadLetter.get(queue);
    if (!list) return false;
    const at = list.findIndex((r) => r.id === jobId);
    if (at === -1) return false;

    const [record] = list.splice(at, 1);
    const entry = this.records.get(record.id);
    if (!entry) return false;

    // A fresh budget: the operator has fixed whatever broke it, so it starts over rather than
    // resuming with its attempts already spent.
    entry.record.state = 'waiting';
    entry.record.attempts = 0;
    entry.record.error = undefined;
    entry.record.progress = 0;
    entry.cancelled = false;
    entry.runAt = Date.now();
    this.waiting.get(queue)!.push(entry);
    this.log.log(`Dead job ${jobId} on "${queue}" was re-queued.`);
    return true;
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ------------------------------------------------------------------ the loop

  /** Start every job that is due and within the concurrency budget. Never throws. */
  private drain(): void {
    if (this.stopped) return;
    const now = Date.now();

    for (const queue of QUEUE_NAMES) {
      const handler = this.handlers.get(queue);
      if (!handler) continue;                       // nothing registered: leave the work waiting

      const active = this.active.get(queue)!;
      const waiting = this.waiting.get(queue)!;

      while (active.size < InProcessQueueDriver.CONCURRENCY) {
        const at = waiting.findIndex((e) => e.runAt <= now && !e.cancelled);
        if (at === -1) break;
        const [entry] = waiting.splice(at, 1);
        void this.run(queue, entry, handler);
      }
    }
  }

  private async run(queue: QueueName, entry: Entry, handler: JobHandler<never>): Promise<void> {
    const active = this.active.get(queue)!;
    active.add(entry.record.id);

    entry.record.state = 'active';
    entry.record.attempts += 1;
    entry.record.startedAt = new Date().toISOString();

    const ctx = {
      id: entry.record.id,
      queue,
      attempt: entry.record.attempts,
      progress: async (percent: number) => {
        entry.record.progress = Math.max(0, Math.min(100, Math.round(percent)));
      },
      cancelled: () => entry.cancelled,
    };

    try {
      await handler(entry.payload as never, ctx);

      if (entry.cancelled) {
        entry.record.state = 'cancelled';
      } else {
        entry.record.state = 'completed';
        entry.record.progress = 100;
        this.counters.get(queue)!.completed += 1;
      }
      entry.record.finishedAt = new Date().toISOString();
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      entry.record.error = message;
      this.counters.get(queue)!.failed += 1;

      const exhausted = entry.record.attempts >= entry.options.attempts;
      if (entry.cancelled) {
        entry.record.state = 'cancelled';
        entry.record.finishedAt = new Date().toISOString();
      } else if (exhausted) {
        /*
         * DEAD LETTER. The job is not retried again and is not silently dropped — it is parked
         * where a person can see it, because a job that has failed every attempt is usually
         * evidence of something broken rather than bad luck.
         */
        entry.record.state = 'dead';
        entry.record.finishedAt = new Date().toISOString();
        const list = this.deadLetter.get(queue)!;
        list.push({ ...entry.record });
        if (list.length > InProcessQueueDriver.DEAD_LIMIT) list.shift();
        this.log.error(`Job ${entry.record.id} on "${queue}" failed ${entry.record.attempts} time(s) and was dead-lettered: ${message}`);
      } else {
        // Exponential backoff: 1s, 2s, 4s… so a struggling downstream service is not hammered.
        const wait = entry.options.backoffMs * 2 ** (entry.record.attempts - 1);
        entry.record.state = 'waiting';
        entry.runAt = Date.now() + wait;
        this.waiting.get(queue)!.push(entry);
        this.log.warn(`Job ${entry.record.id} on "${queue}" failed (attempt ${entry.record.attempts}/${entry.options.attempts}); retrying in ${wait}ms: ${message}`);
      }
    } finally {
      active.delete(entry.record.id);
    }
  }
}
