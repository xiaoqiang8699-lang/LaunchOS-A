import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import {
  DEPLOYMENT_QUEUE,
  deploymentJobId,
  type DeploymentJobData,
} from '@launchos/shared';
import { Queue } from 'bullmq';

export type DeploymentQueueCounts = {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
};

@Injectable()
export class DeploymentQueueService {
  constructor(
    @InjectQueue(DEPLOYMENT_QUEUE)
    private readonly queue: Queue<DeploymentJobData>,
  ) {}

  /**
   * Idempotent enqueue: stable jobId = deployment-{deploymentId}.
   * Re-adding the same jobId while waiting/active/delayed is a no-op.
   */
  async enqueue(deploymentId: string, maxRetry: number): Promise<string> {
    const jobId = deploymentJobId(deploymentId);
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'waiting' || state === 'active' || state === 'delayed') {
        return String(existing.id);
      }
      await existing.remove().catch(() => undefined);
    }

    const job = await this.queue.add(
      'execute',
      { deploymentId },
      {
        jobId,
        attempts: Math.max(1, maxRetry),
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );
    return String(job.id);
  }

  async getCounts(): Promise<DeploymentQueueCounts> {
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

  async getJobState(jobId: string | null | undefined): Promise<string | null> {
    if (!jobId) {
      return null;
    }
    const job = await this.queue.getJob(jobId);
    if (!job) {
      return null;
    }
    return job.getState();
  }

  async hasActiveJob(jobId: string | null | undefined): Promise<boolean> {
    const state = await this.getJobState(jobId);
    return state === 'active' || state === 'waiting' || state === 'delayed';
  }

  async isPaused(): Promise<boolean> {
    return this.queue.isPaused();
  }
}
