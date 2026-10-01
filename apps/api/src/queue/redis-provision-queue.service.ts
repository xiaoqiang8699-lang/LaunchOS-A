import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import {
  REDIS_PROVISION_QUEUE,
  redisProvisionJobId,
  type RedisProvisionJobData,
} from '@launchos/shared';
import { Queue } from 'bullmq';

export type RedisProvisionQueueCounts = {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
};

@Injectable()
export class RedisProvisionQueueService {
  constructor(
    @InjectQueue(REDIS_PROVISION_QUEUE)
    private readonly queue: Queue<RedisProvisionJobData>,
  ) {}

  /**
   * Idempotent enqueue for a CloudResource.
   * Reuses stable jobId = redis-provision-{cloudResourceId}.
   * Prefer retrying a failed job over creating a second job.
   */
  async enqueue(
    cloudResourceId: string,
    operationId: string,
    resolvedSku?: RedisProvisionJobData['resolvedSku'],
  ): Promise<string> {
    const jobId = redisProvisionJobId(cloudResourceId);
    const payload: RedisProvisionJobData = {
      cloudResourceId,
      operationId,
      ...(resolvedSku ? { resolvedSku } : {}),
    };
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'waiting' || state === 'active' || state === 'delayed') {
        return String(existing.id);
      }
      if (state === 'failed') {
        // Prefer BullMQ native retry so we do not race two jobs for the same id.
        // Refresh data so retry carries the latest resolved SKU.
        try {
          await existing.updateData(payload);
          await existing.retry();
          return String(existing.id);
        } catch {
          await existing.remove().catch(() => undefined);
        }
      } else {
        await existing.remove().catch(() => undefined);
      }
    }
    const job = await this.queue.add('provision', payload, {
      jobId,
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 50,
      removeOnFail: 50,
    });
    return String(job.id);
  }

  async getCounts(): Promise<RedisProvisionQueueCounts> {
    const counts = await this.queue.getJobCounts(
      'waiting',
      'active',
      'completed',
      'failed',
      'delayed',
      'paused',
    );
    return {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      delayed: counts.delayed ?? 0,
      paused: counts.paused ?? 0,
    };
  }

  async getJobState(cloudResourceId: string): Promise<string | null> {
    const job = await this.queue.getJob(redisProvisionJobId(cloudResourceId));
    if (!job) return null;
    return job.getState();
  }

  async getFailedReason(cloudResourceId: string): Promise<string | null> {
    const job = await this.queue.getJob(redisProvisionJobId(cloudResourceId));
    if (!job) return null;
    const state = await job.getState();
    if (state !== 'failed') return null;
    return job.failedReason || null;
  }

  async isPaused(): Promise<boolean> {
    return this.queue.isPaused();
  }
}
