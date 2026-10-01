import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import {
  SERVER_PROVISION_QUEUE,
  serverProvisionJobId,
  serverProvisionLegacyJobId,
  type ServerProvisionJobData,
} from '@launchos/shared';
import { Queue } from 'bullmq';

export type ServerProvisionEnqueueStrategy =
  | 'reuse_inflight'
  | 'retry_failed'
  | 'remove_completed_then_add_same_id'
  | 'remove_readd'
  | 'add_new';

@Injectable()
export class ServerProvisionQueueService {
  constructor(
    @InjectQueue(SERVER_PROVISION_QUEUE)
    private readonly queue: Queue<ServerProvisionJobData>,
  ) {}

  /**
   * Idempotent enqueue scoped by createGeneration.
   * jobId = server-provision-{cloudResourceId}-g{generation}
   *
   * failed → prefer job.retry(); if retry unavailable, remove + add same jobId.
   * completed (incl. incomplete business) → remove + add same jobId.
   * waiting/active/delayed → reuse (no duplicate).
   */
  async enqueue(
    cloudResourceId: string,
    operationId: string,
    createGeneration: number = 1,
  ): Promise<{
    jobId: string;
    strategy: ServerProvisionEnqueueStrategy;
    queueJobStateBefore: string | null;
  }> {
    const generation = Math.max(1, Math.floor(Number(createGeneration) || 1));
    const jobId = serverProvisionJobId(cloudResourceId, generation);
    const payload: ServerProvisionJobData = { cloudResourceId, operationId };

    // Legacy id (pre generation-scope) must not block resume.
    const legacy = await this.queue.getJob(serverProvisionLegacyJobId(cloudResourceId));
    if (legacy) {
      const legacyState = await legacy.getState();
      if (legacyState === 'failed' || legacyState === 'completed') {
        await legacy.remove().catch(() => undefined);
      } else if (legacyState === 'waiting' || legacyState === 'delayed') {
        await legacy.remove().catch(() => undefined);
      }
    }

    const existing = await this.queue.getJob(jobId);
    let queueJobStateBefore: string | null = null;
    if (existing) {
      const state = await existing.getState();
      queueJobStateBefore = state;
      if (state === 'waiting' || state === 'active' || state === 'delayed') {
        return {
          jobId: String(existing.id),
          strategy: 'reuse_inflight',
          queueJobStateBefore,
        };
      }
      if (state === 'failed') {
        try {
          await existing.updateData(payload);
          await existing.retry();
          return {
            jobId: String(existing.id),
            strategy: 'retry_failed',
            queueJobStateBefore,
          };
        } catch {
          await existing.remove().catch(() => undefined);
          // fall through to add same jobId
        }
      } else if (state === 'completed') {
        await existing.remove().catch(() => undefined);
      } else {
        // unknown — remove and re-add same generation id
        await existing.remove().catch(() => undefined);
      }
    }

    const job = await this.queue.add('provision', payload, {
      jobId,
      // Terminal provider rejections (Forbidden.RAM / NotEnoughBalance / …) must not
      // auto-retry RunInstances. Same generation allows at most one real SDK call.
      attempts: 1,
      removeOnComplete: 50,
      removeOnFail: 50,
    });
    let strategy: ServerProvisionEnqueueStrategy = 'add_new';
    if (queueJobStateBefore === 'completed') {
      strategy = 'remove_completed_then_add_same_id';
    } else if (queueJobStateBefore === 'failed') {
      strategy = 'remove_completed_then_add_same_id'; // retry() failed → remove+add fallback
    } else if (queueJobStateBefore) {
      strategy = 'remove_readd';
    }
    return { jobId: String(job.id), strategy, queueJobStateBefore };
  }

  async getJobState(
    cloudResourceId: string,
    createGeneration: number = 1,
  ): Promise<{
    jobId: string;
    state: string | null;
    attemptsMade: number | null;
    failedReason: string | null;
    processedOn: number | null;
    finishedOn: number | null;
  }> {
    const jobId = serverProvisionJobId(cloudResourceId, createGeneration);
    const job = await this.queue.getJob(jobId);
    if (!job) {
      const legacy = await this.queue.getJob(serverProvisionLegacyJobId(cloudResourceId));
      if (!legacy) {
        return {
          jobId,
          state: null,
          attemptsMade: null,
          failedReason: null,
          processedOn: null,
          finishedOn: null,
        };
      }
      const state = await legacy.getState();
      return {
        jobId: serverProvisionLegacyJobId(cloudResourceId),
        state,
        attemptsMade: legacy.attemptsMade,
        failedReason: legacy.failedReason || null,
        processedOn: legacy.processedOn || null,
        finishedOn: legacy.finishedOn || null,
      };
    }
    const state = await job.getState();
    return {
      jobId,
      state,
      attemptsMade: job.attemptsMade,
      failedReason: job.failedReason || null,
      processedOn: job.processedOn || null,
      finishedOn: job.finishedOn || null,
    };
  }

  async isPaused(): Promise<boolean> {
    return this.queue.isPaused();
  }
}
