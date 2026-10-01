import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@launchos/database';
import {
  DEPLOYMENT_WORKER_SERVICE,
  WORKER_HEARTBEAT_INTERVAL_MS,
} from '@launchos/shared';

export type HeartbeatStatus = 'ONLINE' | 'DEGRADED' | 'OFFLINE';

export type QueueConsumerReady = {
  deployment: boolean;
  systemCert: boolean;
  databaseProvision: boolean;
  redisProvision: boolean;
  serverProvision: boolean;
  serverInitialization: boolean;
};

export class WorkerHeartbeatReporter {
  readonly workerId: string;
  readonly startedAt: Date;
  private timer: NodeJS.Timeout | null = null;
  private status: HeartbeatStatus = 'ONLINE';
  private readonly version: string;
  private consumedQueues: string[] = [];
  private queueReady: QueueConsumerReady = {
    deployment: false,
    systemCert: false,
    databaseProvision: false,
    redisProvision: false,
    serverProvision: false,
    serverInitialization: false,
  };

  constructor(
    private readonly prisma: PrismaClient,
    options?: { workerId?: string; version?: string },
  ) {
    this.workerId = options?.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
    this.startedAt = new Date();
    this.version = options?.version ?? process.env.npm_package_version ?? '0.0.0';
  }

  setConsumedQueues(queues: string[]): void {
    this.consumedQueues = [...queues];
  }

  setQueueReady(partial: Partial<QueueConsumerReady>): void {
    this.queueReady = { ...this.queueReady, ...partial };
    // Persist immediately so API ensureWorkerOnline does not race the 12s interval.
    void this.beat(this.status).catch((error) => {
      console.error(
        'worker heartbeat queueReady update failed',
        error instanceof Error ? error.message : error,
      );
    });
  }

  async start(): Promise<void> {
    await this.beat('ONLINE');
    this.timer = setInterval(() => {
      void this.beat(this.status).catch((error) => {
        console.error(
          'worker heartbeat failed',
          error instanceof Error ? error.message : error,
        );
      });
    }, WORKER_HEARTBEAT_INTERVAL_MS);
    this.timer.unref?.();
  }

  setStatus(status: HeartbeatStatus): void {
    this.status = status;
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.beat('OFFLINE').catch(() => undefined);
  }

  private metaPayload(): Prisma.InputJsonObject {
    return {
      consumedQueues: this.consumedQueues,
      queueReady: this.queueReady,
    };
  }

  private async beat(status: HeartbeatStatus): Promise<void> {
    const now = new Date();
    const meta = this.metaPayload();
    await this.prisma.workerHeartbeat.upsert({
      where: { workerId: this.workerId },
      create: {
        workerId: this.workerId,
        service: DEPLOYMENT_WORKER_SERVICE,
        status,
        version: this.version,
        meta,
        startedAt: this.startedAt,
        lastSeenAt: now,
      },
      update: {
        service: DEPLOYMENT_WORKER_SERVICE,
        status,
        version: this.version,
        meta,
        lastSeenAt: now,
      },
    });
  }
}
