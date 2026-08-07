import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { QueueService } from './queue.service';
import { QUEUE_NAMES, type QueueName } from './queue.types';
import { RedisService } from '../redis/redis.service';

/**
 * Queue monitoring and intervention.
 *
 * `AuthGuard, AdminGuard` — Super Admin only, matching `users.controller.ts`. This exposes what the
 * application is doing in the background and lets somebody cancel or re-run it, which is
 * administrative by any reading. `ScreenGuard` is deliberately not used: there is no `queues`
 * screen in the permission vocabulary, and inventing one would mean a role could be granted it by
 * accident.
 */
@Controller('queues')
@UseGuards(AuthGuard, AdminGuard)
export class QueueController {
  constructor(
    private readonly queues: QueueService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Everything an operator needs on one screen: which driver is live, whether Redis is healthy, and
   * the depth of every queue.
   *
   * `driver` matters more than it looks. "in-process" means jobs do not survive a restart and are
   * not shared between processes — a fact that changes how an incident should be interpreted, and
   * one nobody should have to infer from an environment variable.
   */
  @Get()
  async overview(): Promise<Record<string, unknown>> {
    return {
      driver: this.queues.driverKind,
      processes_jobs: this.queues.isWorker,
      redis: await this.redis.health(),
      queues: await this.queues.stats(),
    };
  }

  /** The dead letter — jobs that exhausted every attempt and now need a person. */
  @Get('dead')
  async dead(@Query('queue') queue?: string): Promise<Record<string, unknown>> {
    const name = QUEUE_NAMES.includes(queue as QueueName) ? (queue as QueueName) : undefined;
    return { jobs: await this.queues.dead(name) };
  }

  /** Re-queue a dead job, once whatever broke it has been fixed. */
  @Post('dead/:queue/:jobId/retry')
  @HttpCode(200)
  async retry(
    @Param('queue') queue: string,
    @Param('jobId') jobId: string,
  ): Promise<{ requeued: boolean }> {
    if (!QUEUE_NAMES.includes(queue as QueueName)) return { requeued: false };
    return { requeued: await this.queues.retryDead(queue as QueueName, jobId) };
  }

  /**
   * Ask a job to stop.
   *
   * Honest about what this can do: a job that has not started is removed outright, but a RUNNING
   * handler cannot be interrupted from outside — it is asked to stop, and stops at its next
   * checkpoint. Both drivers behave the same way here.
   */
  @Delete(':queue/:jobId')
  @HttpCode(200)
  async cancel(
    @Param('queue') queue: string,
    @Param('jobId') jobId: string,
  ): Promise<{ cancelled: boolean; note: string }> {
    if (!QUEUE_NAMES.includes(queue as QueueName)) return { cancelled: false, note: 'No such queue.' };
    const cancelled = await this.queues.cancel(queue as QueueName, jobId);
    return {
      cancelled,
      note: cancelled
        ? 'Queued work is removed; work already running stops at its next checkpoint.'
        : 'Nothing to cancel — the job is unknown or already finished.',
    };
  }

  /**
   * Enqueue a no-op job, to prove the pipeline end to end from an operator's seat.
   *
   * Deliberately trivial and admin-only: it proves a job can be accepted, picked up and completed
   * without touching mail, SMS or anybody's data.
   */
  @Post('ping')
  @HttpCode(200)
  async ping(@Body() body: { queue?: string }): Promise<{ queue: QueueName; job_id: string }> {
    const queue = (QUEUE_NAMES.includes(body?.queue as QueueName) ? body.queue : 'notification') as QueueName;
    return { queue, job_id: await this.queues.add(queue, { ping: true, at: new Date().toISOString() }) };
  }
}
