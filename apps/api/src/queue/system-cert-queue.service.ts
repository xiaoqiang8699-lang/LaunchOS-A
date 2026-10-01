import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import {
  SYSTEM_CERT_QUEUE,
  systemTlsRenewJobId,
  type SystemCertJobData,
} from '@launchos/shared';
import { Queue } from 'bullmq';

@Injectable()
export class SystemCertQueueService {
  constructor(
    @InjectQueue(SYSTEM_CERT_QUEUE)
    private readonly queue: Queue<SystemCertJobData>,
  ) {}

  async enqueueRenew(options: {
    rootDomain: string;
    force?: boolean;
    dryRun?: boolean;
  }): Promise<{ jobId: string; queued: boolean }> {
    const jobId = systemTlsRenewJobId(options.rootDomain);
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'active' || state === 'waiting' || state === 'delayed') {
        return { jobId, queued: false };
      }
      await existing.remove().catch(() => undefined);
    }
    await this.queue.add(
      'renew',
      {
        kind: 'renew',
        rootDomain: options.rootDomain,
        force: options.force,
        dryRun: options.dryRun,
      },
      {
        jobId,
        removeOnComplete: 50,
        removeOnFail: 50,
        attempts: 1,
      },
    );
    return { jobId, queued: true };
  }

  async enqueueDailyCheck(): Promise<void> {
    await this.queue.add(
      'check',
      { kind: 'check' },
      {
        jobId: `system-cert-check-${new Date().toISOString().slice(0, 10)}`,
        removeOnComplete: 30,
        removeOnFail: 30,
        attempts: 1,
      },
    );
  }
}
