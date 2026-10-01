import { ForbiddenException, Injectable } from '@nestjs/common';
import { WorkspaceRole } from '@launchos/database';
import { DatabaseProvisionQueueService } from '../queue/database-provision-queue.service';
import { DeploymentQueueService } from '../queue/deployment-queue.service';
import { WorkerPresenceService } from '../queue/worker-presence.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';

@Injectable()
export class SystemStatusService {
  constructor(
    private readonly workspaceAccess: WorkspaceAccessService,
    private readonly deploymentQueue: DeploymentQueueService,
    private readonly databaseProvisionQueue: DatabaseProvisionQueueService,
    private readonly workerPresence: WorkerPresenceService,
  ) {}

  async getQueueStatus(userId: string) {
    const membership = await this.workspaceAccess.requireCurrentWorkspace(userId);
    if (
      membership.role !== WorkspaceRole.OWNER &&
      membership.role !== WorkspaceRole.ADMIN
    ) {
      throw new ForbiddenException();
    }

    const [counts, presence, paused, dbCounts, dbPaused] = await Promise.all([
      this.deploymentQueue.getCounts(),
      this.workerPresence.getOnlineConsumer('deployment'),
      this.deploymentQueue.isPaused(),
      this.databaseProvisionQueue.getCounts().catch(() => null),
      this.databaseProvisionQueue.isPaused().catch(() => false),
    ]);

    const databasePresence = await this.workerPresence.getOnlineConsumer('databaseProvision');
    const deployServiceOk = presence.online && presence.queueReady.deployment && !paused;
    const databaseProvisionReady =
      databasePresence.online && databasePresence.queueReady.databaseProvision && !dbPaused;
    return {
      deploymentQueue: {
        waiting: counts.waiting,
        active: counts.active,
        completed: counts.completed,
        failed: counts.failed,
        delayed: counts.delayed,
        paused,
      },
      databaseProvisionQueue: dbCounts
        ? {
            waiting: dbCounts.waiting,
            active: dbCounts.active,
            completed: dbCounts.completed,
            failed: dbCounts.failed,
            delayed: dbCounts.delayed,
            paused: dbPaused,
          }
        : null,
      workerOnline: presence.online && presence.queueReady.deployment,
      workerLastSeenAt: presence.lastSeenAt,
      workerStatus: presence.status,
      workerId: presence.workerId,
      workerVersion: presence.version,
      consumedQueues: presence.consumedQueues,
      queueReady: presence.queueReady,
      databaseProvisionConsumerReady: databaseProvisionReady,
      deployService: {
        status: deployServiceOk ? 'OK' : 'DEGRADED',
        label: deployServiceOk ? '正常' : '异常',
      },
    };
  }
}
