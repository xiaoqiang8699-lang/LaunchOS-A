import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import {
  SERVER_INITIALIZATION_QUEUE,
  serverInitializationJobId,
  type ServerInitializationJobData,
} from '@launchos/shared';
import { Queue } from 'bullmq';

export type ServerInitializationQueueReadiness = {
  queueName: string;
  redisReady: boolean;
  serverInitializationQueueReady: boolean;
  paused: boolean;
  jobCounts: {
    waiting: number;
    active: number;
    delayed: number;
    completed: number;
    failed: number;
  } | null;
  existingJobState: string | null;
  errorCode: string | null;
  errorMessage: string | null;
};

@Injectable()
export class ServerInitializationQueueService {
  constructor(
    @InjectQueue(SERVER_INITIALIZATION_QUEUE)
    private readonly queue: Queue<ServerInitializationJobData>,
  ) {}

  /**
   * Side-effect-free readiness: Redis ping + getJobCounts + getJob.
   * Never calls queue.add.
   */
  async probeReadiness(serverInstanceId?: string): Promise<ServerInitializationQueueReadiness> {
    const queueName = SERVER_INITIALIZATION_QUEUE;
    try {
      // Side-effect free: waitUntilReady + getJobCounts proves BullMQ Redis wiring.
      await this.queue.waitUntilReady();
      const redisReady = true;
      const paused = await this.queue.isPaused();
      const counts = await this.queue.getJobCounts(
        'waiting',
        'active',
        'delayed',
        'completed',
        'failed',
      );
      let existingJobState: string | null = null;
      if (serverInstanceId) {
        const job = await this.queue.getJob(serverInitializationJobId(serverInstanceId));
        existingJobState = job ? await job.getState() : null;
      }
      return {
        queueName,
        redisReady,
        serverInitializationQueueReady: redisReady && !paused,
        paused,
        jobCounts: {
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          delayed: counts.delayed ?? 0,
          completed: counts.completed ?? 0,
          failed: counts.failed ?? 0,
        },
        existingJobState,
        errorCode: null,
        errorMessage: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        queueName,
        redisReady: false,
        serverInitializationQueueReady: false,
        paused: false,
        jobCounts: null,
        existingJobState: null,
        errorCode: 'SERVER_INITIALIZATION_QUEUE_UNAVAILABLE',
        errorMessage: message.slice(0, 240),
      };
    }
  }

  /**
   * Stable jobId = server-initialize-{serverInstanceId}
   * attempts=1 — do not auto-retry the whole init job.
   */
  async enqueue(input: {
    serverInstanceId: string;
    projectId: string;
    workspaceId: string;
    operationId: string;
  }): Promise<{
    jobId: string;
    alreadyInProgress: boolean;
    strategy: 'reuse_inflight' | 'remove_completed_then_add' | 'add_new';
  }> {
    const jobId = serverInitializationJobId(input.serverInstanceId);
    const payload: ServerInitializationJobData = {
      serverInstanceId: input.serverInstanceId,
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      operationId: input.operationId,
    };

    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'waiting' || state === 'active' || state === 'delayed') {
        return { jobId: String(existing.id), alreadyInProgress: true, strategy: 'reuse_inflight' };
      }
      if (state === 'completed' || state === 'failed') {
        await existing.remove().catch(() => undefined);
        const job = await this.queue.add('initialize', payload, {
          jobId,
          attempts: 1,
          removeOnComplete: 50,
          removeOnFail: 50,
        });
        return {
          jobId: String(job.id),
          alreadyInProgress: false,
          strategy: 'remove_completed_then_add',
        };
      }
      await existing.remove().catch(() => undefined);
    }

    const job = await this.queue.add('initialize', payload, {
      jobId,
      attempts: 1,
      removeOnComplete: 50,
      removeOnFail: 50,
    });
    return { jobId: String(job.id), alreadyInProgress: false, strategy: 'add_new' };
  }

  async getJobState(serverInstanceId: string): Promise<{
    jobId: string;
    state: string | null;
    attemptsMade: number | null;
    failedReason: string | null;
  }> {
    const jobId = serverInitializationJobId(serverInstanceId);
    const job = await this.queue.getJob(jobId);
    if (!job) {
      return { jobId, state: null, attemptsMade: null, failedReason: null };
    }
    const state = await job.getState();
    return {
      jobId,
      state,
      attemptsMade: job.attemptsMade,
      failedReason: job.failedReason || null,
    };
  }

  async isPaused(): Promise<boolean> {
    return this.queue.isPaused();
  }
}
