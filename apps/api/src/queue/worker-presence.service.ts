import { Injectable } from '@nestjs/common';
import {
  DEPLOYMENT_WORKER_SERVICE,
  isWorkerHeartbeatFresh,
} from '@launchos/shared';
import { PrismaService } from '../database/prisma.service';

export type QueueConsumerReady = {
  deployment: boolean;
  systemCert: boolean;
  databaseProvision: boolean;
  redisProvision: boolean;
  serverProvision: boolean;
  serverInitialization: boolean;
};

export type WorkerPresence = {
  online: boolean;
  workerId: string | null;
  status: string | null;
  lastSeenAt: string | null;
  startedAt: string | null;
  version: string | null;
  consumedQueues: string[];
  queueReady: QueueConsumerReady;
};

const EMPTY_READY: QueueConsumerReady = {
  deployment: false,
  systemCert: false,
  databaseProvision: false,
  redisProvision: false,
  serverProvision: false,
  serverInitialization: false,
};

@Injectable()
export class WorkerPresenceService {
  constructor(private readonly prisma: PrismaService) {}

  async getDeploymentWorkerPresence(): Promise<WorkerPresence> {
    const rows = await this.listHeartbeats();
    return rows[0] ?? emptyPresence();
  }

  async getOnlineConsumer(flag: keyof QueueConsumerReady): Promise<WorkerPresence> {
    const rows = await this.listHeartbeats();
    return rows.find((row) => row.online && row.queueReady[flag]) ?? rows[0] ?? emptyPresence();
  }

  private async listHeartbeats(): Promise<WorkerPresence[]> {
    const rows = await this.prisma.workerHeartbeat.findMany({
      where: { service: DEPLOYMENT_WORKER_SERVICE },
      orderBy: { lastSeenAt: 'desc' },
      take: 20,
    });
    return rows.map((row) => toPresence(row));
  }

  async assertDeploymentWorkerOnline(): Promise<void> {
    const presence = await this.getOnlineConsumer('deployment');
    if (!presence.online || !presence.queueReady.deployment) {
      const error = new Error('上线服务暂时不可用，请稍后重试。');
      (error as Error & { code?: string }).code = 'NO_DEPLOYMENT_WORKER_AVAILABLE';
      throw error;
    }
  }
}

function emptyPresence(): WorkerPresence {
  return {
    online: false,
    workerId: null,
    status: null,
    lastSeenAt: null,
    startedAt: null,
    version: null,
    consumedQueues: [],
    queueReady: { ...EMPTY_READY },
  };
}

function toPresence(row: {
  workerId: string;
  status: string;
  lastSeenAt: Date;
  startedAt: Date;
  version: string | null;
  meta: unknown;
}): WorkerPresence {
  const online = isWorkerHeartbeatFresh({
    status: row.status,
    lastSeenAt: row.lastSeenAt,
  });
  const meta = asMeta(row.meta);
  const queueReady = meta.queueReady as Partial<QueueConsumerReady> | undefined;
  return {
    online,
    workerId: row.workerId,
    status: online ? row.status : 'OFFLINE',
    lastSeenAt: row.lastSeenAt.toISOString(),
    startedAt: row.startedAt.toISOString(),
    version: row.version,
    consumedQueues: Array.isArray(meta.consumedQueues)
      ? meta.consumedQueues.filter((item): item is string => typeof item === 'string')
      : [],
    queueReady: {
      deployment: queueReady?.deployment === true,
      systemCert: queueReady?.systemCert === true,
      databaseProvision: queueReady?.databaseProvision === true,
      redisProvision: queueReady?.redisProvision === true,
      serverProvision: queueReady?.serverProvision === true,
      serverInitialization: queueReady?.serverInitialization === true,
    },
  };
}

function asMeta(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
