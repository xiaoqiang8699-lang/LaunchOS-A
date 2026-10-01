import {
  DeploymentStatus,
  PrismaClient,
  ServiceStatus,
} from '@launchos/database';
import { RemoteDockerRuntime } from '@launchos/runtime';
import { decryptCredential, OLD_RUNTIME_GRACE_MS, shouldCleanupOldRuntime } from '@launchos/shared';

const STALE_CREATING_MS = 30 * 60_000;
/** Align orphan destroy with Safe-release grace (10 min). */
const ORPHAN_SAFE_AGE_MS = OLD_RUNTIME_GRACE_MS;

export type RuntimeReconcileReport = {
  staleCreating: number;
  orphanContainersRemoved: number;
  warnings: string[];
};

/**
 * Lightweight reconcile for LaunchOS-managed remote containers vs ServiceInstance.
 * Only auto-cleans clearly stale/orphan resources with ownership labels.
 */
export async function reconcileRemoteRuntimes(
  prisma: PrismaClient,
): Promise<RuntimeReconcileReport> {
  const report: RuntimeReconcileReport = {
    staleCreating: 0,
    orphanContainersRemoved: 0,
    warnings: [],
  };

  const staleCutoff = new Date(Date.now() - STALE_CREATING_MS);
  const stale = await prisma.serviceInstance.findMany({
    where: {
      status: ServiceStatus.CREATING,
      serverInstanceId: { not: null },
      updatedAt: { lt: staleCutoff },
    },
    select: {
      id: true,
      containerId: true,
      serverInstanceId: true,
      server: {
        select: {
          host: true,
          port: true,
          username: true,
          credentialEncrypted: true,
        },
      },
    },
  });

  for (const item of stale) {
    if (item.containerId && item.server) {
      try {
        const remote = new RemoteDockerRuntime({
          host: item.server.host,
          port: item.server.port,
          username: item.server.username,
          password: decryptCredential(item.server.credentialEncrypted),
        });
        await remote.destroyRuntime(item.containerId).catch(() => undefined);
      } catch {
        report.warnings.push(`stale-creating-cleanup-failed:${item.id}`);
      }
    }
    await prisma.serviceInstance.update({
      where: { id: item.id },
      data: { status: ServiceStatus.FAILED },
    });
    report.staleCreating += 1;
  }

  const servers = await prisma.serverInstance.findMany({
    select: {
      id: true,
      host: true,
      port: true,
      username: true,
      credentialEncrypted: true,
    },
  });

  for (const server of servers) {
    let remote: RemoteDockerRuntime;
    try {
      remote = new RemoteDockerRuntime({
        host: server.host,
        port: server.port,
        username: server.username,
        password: decryptCredential(server.credentialEncrypted),
      });
    } catch {
      continue;
    }

    let managed: Array<{ id: string; name: string; labels: Record<string, string> }> = [];
    try {
      managed = await remote.listManagedContainerIds();
    } catch {
      report.warnings.push(`list-managed-failed:${server.id}`);
      continue;
    }

    const active = await prisma.serviceInstance.findMany({
      where: {
        serverInstanceId: server.id,
        status: { in: [ServiceStatus.CREATING, ServiceStatus.RUNNING] },
        containerId: { not: null },
      },
      select: { id: true, containerId: true },
    });
    const activeIds = new Set(
      active.flatMap((item) => (item.containerId ? [item.containerId, item.containerId.slice(0, 12)] : [])),
    );
    const activeServiceIds = new Set(active.map((item) => item.id));

    for (const container of managed) {
      const serviceInstanceId = container.labels['launchos.serviceInstanceId'] || '';
      const deploymentId = container.labels['launchos.deploymentId'] || '';
      const shortId = container.id.slice(0, 12);
      const stillActive =
        activeIds.has(container.id) ||
        activeIds.has(shortId) ||
        (serviceInstanceId && activeServiceIds.has(serviceInstanceId));
      if (stillActive) {
        continue;
      }

      let safeToRemove = false;
      if (serviceInstanceId) {
        const si = await prisma.serviceInstance.findUnique({
          where: { id: serviceInstanceId },
          select: { status: true, updatedAt: true },
        });
        if (
          si &&
          (si.status === ServiceStatus.FAILED || si.status === ServiceStatus.STOPPED) &&
          shouldCleanupOldRuntime({
            switchedAt: si.updatedAt,
            now: new Date(),
            graceMs: ORPHAN_SAFE_AGE_MS,
          })
        ) {
          safeToRemove = true;
        }
      } else if (deploymentId) {
        const dep = await prisma.deployment.findUnique({
          where: { id: deploymentId },
          select: { status: true, updatedAt: true },
        });
        if (
          dep &&
          (dep.status === DeploymentStatus.FAILED || dep.status === DeploymentStatus.CANCELLED) &&
          Date.now() - dep.updatedAt.getTime() > ORPHAN_SAFE_AGE_MS
        ) {
          safeToRemove = true;
        }
      }

      if (!safeToRemove) {
        report.warnings.push(`orphan-unconfirmed:${container.name || container.id}`);
        continue;
      }

      try {
        await remote.destroyRuntime(container.id);
        report.orphanContainersRemoved += 1;
      } catch {
        report.warnings.push(`orphan-remove-failed:${container.id}`);
      }
    }
  }

  return report;
}
