import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { InProcessQueueDriver } from './in-process.driver';
import { BullMqQueueDriver } from './bullmq.driver';
import { schedulersEnabled } from '../common/schedulers';
import { registerWorker, workerFailed, workerFinished, workerStarted } from '../observability/worker-health';
import type { JobHandler, JobOptions, JobRecord, QueueDriver, QueueName, QueueStats } from './queue.types';

/**
 * The queue everything else talks to.
 *
 * It picks a driver once, at construction, from whether Redis is configured — and nothing else in
 * the application needs to know which one it got. That is the point: enqueueing looks identical on
 * a laptop with no Redis and on a production box with three API instances.
 *
 * WHO PROCESSES JOBS. Handlers are only registered when `schedulersEnabled()` is true, which reuses
 * the existing `RUN_SCHEDULERS` rule rather than inventing a second one. So a web process started
 * with `RUN_SCHEDULERS=false` can still ENQUEUE work — it simply does not execute it — and a
 * dedicated worker process with the flag on does the running. That is the brief's "workers process
 * jobs independently from the web server", built out of the mechanism this project already had.
 *
 * EVERY RUN IS REPORTED to the existing worker-health registry, so `/api/health/workers` shows queue
 * handlers beside the timers that were already there. A second monitoring system would have meant
 * two places to look and two chances to miss something.
 */
@Injectable()
export class QueueService implements OnApplicationShutdown {
  private readonly log = new Logger(QueueService.name);
  private readonly driver: QueueDriver;
  private readonly processing: boolean;

  constructor(private readonly redis: RedisService) {
    const connection = this.redis.raw();
    if (connection) {
      this.driver = new BullMqQueueDriver(connection, RedisService.prefix().replace(/:$/, ''));
      this.log.log('Queues are backed by Redis — jobs survive a restart and are shared across processes.');
    } else {
      this.driver = new InProcessQueueDriver();
      this.log.log('Queues are running in-process — jobs do NOT survive a restart and are not shared across processes. Set REDIS_URL to change that.');
    }

    this.processing = schedulersEnabled();
    if (!this.processing) {
      this.log.log('This process enqueues but does not execute jobs (RUN_SCHEDULERS is off).');
    }
  }

  /** 'redis' or 'in-process'. Reported by the monitoring endpoint so nobody has to infer it. */
  get driverKind(): 'redis' | 'in-process' {
    return this.driver.kind;
  }

  /** Whether this process runs handlers, as opposed to only enqueueing. */
  get isWorker(): boolean {
    return this.processing;
  }

  /**
   * Register the handler for a queue.
   *
   * Wrapped so every job reports into the worker-health registry and so a handler can never throw
   * into the driver's loop — a rejected promise escaping here would be an unhandled rejection, which
   * on newer node versions ends the process.
   */
  register<T>(queue: QueueName, handler: JobHandler<T>): void {
    if (!this.processing) return;

    // Interval is unknown for a queue — it runs when there is work — so it is registered as 0,
    // which the health endpoint already renders as "not on a timer".
    registerWorker(`queue:${queue}`, 0);

    this.driver.register<T>(queue, async (payload, ctx) => {
      workerStarted(`queue:${queue}`);
      try {
        const result = await handler(payload, ctx);
        workerFinished(`queue:${queue}`);
        return result;
      } catch (err) {
        workerFailed(`queue:${queue}`, err);
        // Rethrown deliberately: the driver decides about retries and the dead letter, and
        // swallowing it here would mark a failed job successful.
        throw err;
      }
    });
    this.log.log(`Handler registered for the "${queue}" queue.`);
  }

  /** Enqueue work. Returns the job id, which is the caller's handle for cancelling or tracking it. */
  async add<T>(queue: QueueName, payload: T, options?: JobOptions): Promise<string> {
    return this.driver.add(queue, payload, options);
  }

  async cancel(queue: QueueName, jobId: string): Promise<boolean> {
    return this.driver.cancel(queue, jobId);
  }

  async stats(): Promise<QueueStats[]> {
    return this.driver.stats();
  }

  async dead(queue?: QueueName): Promise<JobRecord[]> {
    return this.driver.dead(queue);
  }

  async retryDead(queue: QueueName, jobId: string): Promise<boolean> {
    return this.driver.retryDead(queue, jobId);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.driver.shutdown();
  }
}
