import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { Queue, Worker, type Job } from 'bullmq';
import {
  QUEUE_NAMES,
  type JobHandler,
  type JobOptions,
  type JobRecord,
  type QueueDriver,
  type QueueName,
  type QueueStats,
} from './queue.types';

/**
 * The Redis-backed driver, used when `REDIS_URL` is set.
 *
 * WHAT THIS BUYS OVER THE IN-PROCESS DRIVER, and it is the whole reason for the dependency:
 *   - jobs SURVIVE A RESTART, because they live in Redis rather than in this process's memory;
 *   - work is shared across processes, so a second API instance helps rather than duplicating —
 *     which is the exact failure `common/schedulers.ts` warns about (two IMAP syncs racing on one
 *     mailbox, two copies of a reminder reaching a real client);
 *   - workers can run somewhere else entirely, so nothing background competes with request handling.
 *
 * HONEST STATUS: this driver is written against BullMQ 5 but has NOT been executed against a live
 * Redis, because no Redis, Docker or WSL is available on the machine it was built on — BullMQ needs
 * real Lua scripting and blocking reads, so a mock proves nothing. The in-process driver is fully
 * tested and is the default. Treat the first run of this one on real infrastructure as the
 * verification step: `docs/` records exactly what to check.
 */
export class BullMqQueueDriver implements QueueDriver {
  readonly kind = 'redis' as const;
  private readonly log = new Logger('Queue:redis');

  private readonly queues = new Map<QueueName, Queue>();
  private readonly workers = new Map<QueueName, Worker>();
  /** Cancellation is cooperative here too — the flag is read by the handler's `ctx.cancelled()`. */
  private readonly cancelling = new Set<string>();

  static readonly CONCURRENCY = 4;

  /**
   * How long any single Redis-backed queue operation may take.
   *
   * MEASURED, NOT PRECAUTIONARY. BullMQ needs `maxRetriesPerRequest: null`, which means "never give
   * up on a command" — so against a configured-but-unreachable Redis these promises NEVER SETTLE.
   * The first version of this driver hung `/api/health/ready` indefinitely, and `add()` would have
   * hung any request that enqueued work. Every public method below therefore races a deadline.
   */
  static readonly DEADLINE_MS = 2_000;

  /** Resolve to `fallback` if Redis does not answer in time, instead of waiting for ever. */
  private async deadline<T>(operation: Promise<T>, fallback: T): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), BullMqQueueDriver.DEADLINE_MS); }),
      ]);
    } catch {
      return fallback;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  constructor(private readonly connection: Redis, private readonly prefix: string) {
    for (const name of QUEUE_NAMES) {
      this.queues.set(name, new Queue(name, {
        connection: this.connection,
        prefix: this.prefix,
        defaultJobOptions: {
          // Completed jobs are kept briefly for the monitor, then trimmed — an untrimmed completed
          // set grows without limit and is the usual way a BullMQ Redis fills up.
          removeOnComplete: { age: 3_600, count: 500 },
          // Failures are kept far longer: they are the evidence somebody needs.
          removeOnFail: { age: 7 * 24 * 3_600 },
        },
      }));
    }
  }

  register<T>(queue: QueueName, handler: JobHandler<T>): void {
    if (this.workers.has(queue)) {
      this.log.warn(`A worker for the "${queue}" queue already exists; the newer handler replaces it.`);
      void this.workers.get(queue)!.close();
    }

    const worker = new Worker(
      queue,
      async (job: Job) => handler(job.data as T, {
        id: String(job.id),
        queue,
        attempt: job.attemptsMade + 1,
        progress: async (percent: number) => { await job.updateProgress(Math.max(0, Math.min(100, Math.round(percent)))); },
        cancelled: () => this.cancelling.has(String(job.id)),
      }),
      { connection: this.connection, prefix: this.prefix, concurrency: BullMqQueueDriver.CONCURRENCY },
    );

    worker.on('failed', (job, err) => {
      const attempts = job?.attemptsMade ?? 0;
      const max = job?.opts?.attempts ?? 1;
      if (attempts >= max) {
        // BullMQ's own failed set IS the dead letter — a job that has exhausted its attempts stays
        // there rather than being deleted, which is what `dead()` reads back.
        this.log.error(`Job ${job?.id} on "${queue}" failed ${attempts} time(s) and is dead-lettered: ${err.message}`);
      } else {
        this.log.warn(`Job ${job?.id} on "${queue}" failed (attempt ${attempts}/${max}): ${err.message}`);
      }
    });
    worker.on('error', (err) => this.log.error(`Worker error on "${queue}": ${err.message}`));

    this.workers.set(queue, worker);
  }

  async add<T>(queue: QueueName, payload: T, options: JobOptions = {}): Promise<string> {
    const job = await this.deadline(this.queues.get(queue)!.add(queue, payload, {
      attempts: Math.max(1, options.attempts ?? 3),
      delay: Math.max(0, options.delayMs ?? 0),
      backoff: { type: 'exponential', delay: options.backoffMs ?? 1_000 },
      // A stable id makes the same unit of work idempotent: BullMQ drops a duplicate rather than
      // queueing it twice, which is what makes enqueueing from a timer safe.
      ...(options.jobId ? { jobId: options.jobId } : {}),
    }), null);

    /*
     * A null here means Redis did not answer in time, so the job is NOT queued. Thrown rather than
     * returned quietly: enqueueing is the caller's request to have work done later, and silently
     * dropping it would lose that work with nothing anywhere to show for it. Callers that must not
     * fail — a nightly sweep, say — catch this and carry on.
     */
    if (!job) throw new Error(`Redis did not accept the job for the "${queue}" queue within ${BullMqQueueDriver.DEADLINE_MS}ms.`);
    return String(job.id);
  }

  async cancel(queue: QueueName, jobId: string): Promise<boolean> {
    const job = await this.deadline(this.queues.get(queue)!.getJob(jobId), undefined);
    if (!job) return false;

    this.cancelling.add(jobId);
    const state = await this.deadline(job.getState(), 'unknown' as never);
    if (state === 'waiting' || state === 'delayed') {
      // Not started yet, so it can simply be removed.
      await job.remove();
      this.cancelling.delete(jobId);
    }
    // Active jobs are left to notice `ctx.cancelled()`; a running handler cannot be interrupted.
    return true;
  }

  async stats(): Promise<QueueStats[]> {
    return Promise.all([...this.queues.entries()].map(async ([queue, q]) => {
      // Zeroes rather than a hang when Redis is gone; the health check reports Redis itself as down,
      // which is the honest signal — the queue depths are simply unknown at that moment.
      const counts = await this.deadline(
        q.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
        {} as Record<string, number>,
      );
      return {
        queue,
        // Delayed jobs are waiting too, as far as anyone reading this is concerned.
        waiting: (counts.waiting ?? 0) + (counts.delayed ?? 0),
        active: counts.active ?? 0,
        completed: counts.completed ?? 0,
        failed: counts.failed ?? 0,
        dead: counts.failed ?? 0,
      };
    }));
  }

  async dead(queue?: QueueName): Promise<JobRecord[]> {
    const names = queue ? [queue] : [...QUEUE_NAMES];
    const out: JobRecord[] = [];
    for (const name of names) {
      const failed = await this.deadline(this.queues.get(name)!.getFailed(0, 100), []);
      for (const job of failed) {
        out.push({
          id: String(job.id),
          queue: name,
          state: 'dead',
          attempts: job.attemptsMade,
          maxAttempts: job.opts.attempts ?? 1,
          progress: typeof job.progress === 'number' ? job.progress : 0,
          enqueuedAt: new Date(job.timestamp).toISOString(),
          finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : undefined,
          error: job.failedReason,
        });
      }
    }
    return out;
  }

  async retryDead(queue: QueueName, jobId: string): Promise<boolean> {
    const job = await this.deadline(this.queues.get(queue)!.getJob(jobId), undefined);
    if (!job) return false;
    await this.deadline(job.retry(), undefined);
    this.log.log(`Dead job ${jobId} on "${queue}" was re-queued.`);
    return true;
  }

  async shutdown(): Promise<void> {
    // Workers first, so nothing new is picked up while the queues close.
    await Promise.all([...this.workers.values()].map((w) => w.close()));
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}
