import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  DeploymentStatus,
  ServiceStatus,
  ServerScope,
} from '@launchos/database';
import {
  BETA_CAPACITY_DEFAULTS,
  decideCapacityAdmission,
  isBuildStage,
  parseCapacityProbeText,
  type CapacityAdmissionDecision,
  type ServerCapacitySnapshot,
  decryptCredential,
  resolveServerSshUsername,
  shellCommand,
} from '@launchos/shared';
import { RemoteRunner } from '@launchos/remote-runner';
import { PrismaService } from '../database/prisma.service';
import { WorkerPresenceService } from '../queue/worker-presence.service';

type MetaCapacity = {
  capacityProbe?: {
    cpuCores?: number | null;
    memoryTotalMb?: number | null;
    memoryAvailableMb?: number | null;
    diskTotalMb?: number | null;
    diskFreeMb?: number | null;
    diskUsedPercent?: number | null;
    probedAt?: string;
    /** When true, skip live SSH probe and trust injected values (tests / admin override). */
    force?: boolean;
  };
};

@Injectable()
export class CapacityGovernanceService {
  private readonly logger = new Logger(CapacityGovernanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly workers: WorkerPresenceService,
  ) {}

  async admitManagedDeployment(input?: {
    preferServerInstanceId?: string;
    allowWait?: boolean;
  }): Promise<{
    decision: CapacityAdmissionDecision;
    serverInstanceId: string | null;
    snapshot: ServerCapacitySnapshot | null;
  }> {
    const presence = await this.workers.getOnlineConsumer('deployment');
    const nodes = await this.prisma.serverInstance.findMany({
      where: { scope: ServerScope.PLATFORM_MANAGED },
      orderBy: { updatedAt: 'asc' },
      select: {
        id: true,
        host: true,
        port: true,
        username: true,
        credentialEncrypted: true,
        status: true,
        dockerStatus: true,
        metadata: true,
        updatedAt: true,
      },
    });
    const preferred = input?.preferServerInstanceId
      ? nodes.find((n) => n.id === input.preferServerInstanceId)
      : undefined;
    const server = preferred || nodes[0] || null;
    if (!server) {
      const decision = decideCapacityAdmission({
        workerOnline: presence.online,
        queueReady: Boolean(presence.queueReady.deployment),
        snapshot: null,
        allowWait: input?.allowWait,
      });
      return { decision, serverInstanceId: null, snapshot: null };
    }

    const snapshot = await this.buildSnapshot(server.id, {
      host: server.host,
      port: server.port,
      username: server.username,
      credentialEncrypted: server.credentialEncrypted,
      metadata: server.metadata,
    });

    const decision = decideCapacityAdmission({
      workerOnline: presence.online,
      queueReady: Boolean(presence.queueReady.deployment),
      snapshot,
      allowWait: input?.allowWait ?? true,
    });

    if (decision.diskWarning) {
      this.logger.warn(`DISK_WARNING server=${server.id} freeMb=${snapshot.diskFreeMb}`);
    }
    if (decision.diskCritical) {
      this.logger.error(`CAPACITY_CRITICAL DISK server=${server.id} freeMb=${snapshot.diskFreeMb}`);
    }
    if (decision.result !== 'ADMITTED') {
      this.logger.warn(
        `CAPACITY_ADMISSION result=${decision.result} code=${decision.code} reasons=${decision.reasons.join(',')}`,
      );
    }

    return { decision, serverInstanceId: server.id, snapshot };
  }

  assertAdmitted(decision: CapacityAdmissionDecision): void {
    if (decision.result === 'ADMITTED') return;
    const status =
      decision.result === 'WORKER_UNAVAILABLE'
        ? 503
        : decision.result === 'WAITING_CAPACITY'
          ? 429
          : 503;
    throw new ServiceUnavailableException({
      statusCode: status,
      message: decision.userMessage || '当前上线资源繁忙，请稍后重试。',
      code: decision.code || 'CAPACITY_UNAVAILABLE',
      admission: decision.result,
      uiLabel: decision.uiLabel,
    });
  }

  async buildSnapshot(
    serverInstanceId: string,
    server?: {
      host: string;
      port: number;
      username: string;
      credentialEncrypted: string;
      metadata: unknown;
    },
  ): Promise<ServerCapacitySnapshot> {
    const row =
      server ||
      (await this.prisma.serverInstance.findUniqueOrThrow({
        where: { id: serverInstanceId },
        select: {
          host: true,
          port: true,
          username: true,
          credentialEncrypted: true,
          metadata: true,
        },
      }));

    const [runningRuntimeCount, activeDeploymentCount, allocatedPortCount] =
      await Promise.all([
        this.prisma.serviceInstance.count({
          where: {
            serverInstanceId,
            status: { in: [ServiceStatus.RUNNING, ServiceStatus.CREATING] },
          },
        }),
        this.prisma.deployment.count({
          where: {
            serverInstanceId,
            status: {
              in: [DeploymentStatus.CREATED, DeploymentStatus.QUEUED, DeploymentStatus.RUNNING],
            },
          },
        }),
        this.prisma.serviceInstance.count({
          where: {
            serverInstanceId,
            status: { in: [ServiceStatus.RUNNING, ServiceStatus.CREATING] },
            OR: [{ externalPort: { not: null } }, { port: { not: null } }],
          },
        }),
      ]);

    // Approximate active builds: RUNNING deployments whose currentStage looks like build/upload.
    const runningDeps = await this.prisma.deployment.findMany({
      where: {
        serverInstanceId,
        status: DeploymentStatus.RUNNING,
      },
      select: { currentStage: true },
      take: 50,
    });
    const activeBuildCount = runningDeps.filter((d) => isBuildStage(d.currentStage)).length;

    const meta = (row.metadata || {}) as MetaCapacity;
    const cached = meta.capacityProbe;
    const cacheFresh =
      Boolean(cached?.force) ||
      (cached?.probedAt &&
        Date.now() - Date.parse(cached.probedAt) < BETA_CAPACITY_DEFAULTS.capacityProbeTtlMs);

    let probe = cached || null;
    if (!cacheFresh) {
      probe = (await this.probeRemote(row)) || cached || null;
      if (probe) {
        await this.prisma.serverInstance
          .update({
            where: { id: serverInstanceId },
            data: {
              metadata: {
                ...((row.metadata as object) || {}),
                capacityProbe: { ...probe, force: false },
              },
            },
          })
          .catch(() => undefined);
      }
    }

    return {
      serverInstanceId,
      cpuCores: probe?.cpuCores ?? null,
      memoryTotalMb: probe?.memoryTotalMb ?? null,
      memoryAvailableMb: probe?.memoryAvailableMb ?? null,
      diskTotalMb: probe?.diskTotalMb ?? null,
      diskFreeMb: probe?.diskFreeMb ?? null,
      diskUsedPercent: probe?.diskUsedPercent ?? null,
      runningRuntimeCount,
      activeDeploymentCount,
      activeBuildCount,
      allocatedPortCount,
      probedAt: probe?.probedAt || new Date().toISOString(),
    };
  }

  private async probeRemote(server: {
    host: string;
    port: number;
    username: string;
    credentialEncrypted: string;
  }): Promise<MetaCapacity['capacityProbe'] | null> {
    const runner = new RemoteRunner();
    try {
      await runner.connect({
        host: server.host,
        port: server.port,
        username: resolveServerSshUsername({ serverUsername: server.username }),
        password: decryptCredential(server.credentialEncrypted),
      });
      const r = await runner.execute(
        shellCommand('nproc; free -m | head -3; df -h / | tail -1'),
        { timeoutMs: 20_000 },
      );
      const parsed = parseCapacityProbeText(String(r.stdout || ''));
      return {
        ...parsed,
        probedAt: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.warn(
        `capacity probe failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      return null;
    } finally {
      await runner.disconnect().catch(() => undefined);
    }
  }

  async adminCapacityView() {
    const presence = await this.workers.getDeploymentWorkerPresence();
    const nodes = await this.prisma.serverInstance.findMany({
      where: { scope: ServerScope.PLATFORM_MANAGED },
      orderBy: { updatedAt: 'asc' },
      select: {
        id: true,
        name: true,
        host: true,
        status: true,
        dockerStatus: true,
        port: true,
        username: true,
        credentialEncrypted: true,
        metadata: true,
      },
    });
    const servers = [];
    for (const node of nodes) {
      const snapshot = await this.buildSnapshot(node.id, node);
      const decision = decideCapacityAdmission({
        workerOnline: presence.online,
        queueReady: Boolean(presence.queueReady.deployment),
        snapshot,
        allowWait: true,
      });
      servers.push({
        id: node.id,
        name: node.name,
        host: node.host,
        status: node.status,
        dockerStatus: node.dockerStatus,
        snapshot,
        admission: decision.result,
        diskWarning: decision.diskWarning,
        diskCritical: decision.diskCritical,
        limits: BETA_CAPACITY_DEFAULTS,
      });
    }

    // Queue depth: best-effort from DB (BullMQ counts are optional).
    const waiting = await this.prisma.deployment.count({
      where: { status: { in: [DeploymentStatus.CREATED, DeploymentStatus.QUEUED] } },
    });
    const active = await this.prisma.deployment.count({
      where: { status: DeploymentStatus.RUNNING },
    });
    const failed = await this.prisma.deployment.count({
      where: { status: DeploymentStatus.FAILED },
    });

    return {
      workerOnline: presence.online,
      lastSeenAt: presence.lastSeenAt,
      queues: presence.queueReady,
      queueDepth: {
        deploymentQueue: { waiting, active, failed },
      },
      servers,
      limits: BETA_CAPACITY_DEFAULTS,
      warnings: servers
        .filter((s) => s.diskWarning || s.diskCritical || s.admission !== 'ADMITTED')
        .map((s) => ({
          serverId: s.id,
          code: s.diskCritical
            ? 'DISK_CRITICAL'
            : s.diskWarning
              ? 'DISK_WARNING'
              : s.admission === 'WORKER_UNAVAILABLE'
                ? 'WORKER_OFFLINE'
                : 'CAPACITY_PRESSURE',
        })),
    };
  }
}
