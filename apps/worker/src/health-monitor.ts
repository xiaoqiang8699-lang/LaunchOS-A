import {
  HealthStatus,
  PrismaClient,
  ServiceStatus,
} from '@launchos/database';
import {
  createRuntimeProvider,
  type RuntimeProvider,
} from '@launchos/runtime';
import {
  decryptCredential,
  reconcileServiceInstanceRuntimeState,
  type ContainerRuntimeObservation,
} from '@launchos/shared';

const DEFAULT_INTERVAL_MS = 30_000;
const HTTP_TIMEOUT_MS = 10_000;

type MonitoredService = {
  id: string;
  containerId: string | null;
  port: number | null;
  externalPort: number | null;
  serverInstanceId: string | null;
  deployableUnit: { type: string } | null;
  server: {
    host: string;
    port: number;
    username: string;
    credentialEncrypted: string;
  } | null;
};

export function startHealthMonitor(prisma: PrismaClient): () => void {
  const intervalMs = readIntervalMs();
  let running = false;

  const run = async (): Promise<void> => {
    if (running) {
      return;
    }
    running = true;
    try {
      await checkAllServices(prisma);
    } catch (error) {
      console.error('Health monitor failed', error);
    } finally {
      running = false;
    }
  };

  const initialTimer = setTimeout(() => void run(), 3_000);
  const interval = setInterval(() => void run(), intervalMs);
  console.log(`Health monitor started (every ${intervalMs}ms)`);

  return () => {
    clearTimeout(initialTimer);
    clearInterval(interval);
  };
}

async function checkAllServices(prisma: PrismaClient): Promise<void> {
  const services = await prisma.serviceInstance.findMany({
    where: {
      status: ServiceStatus.RUNNING,
      containerId: { not: null },
    },
    select: {
      id: true,
      containerId: true,
      port: true,
      externalPort: true,
      serverInstanceId: true,
      projectId: true,
      deployableUnitId: true,
      updatedAt: true,
      deployableUnit: { select: { type: true } },
      server: {
        select: {
          host: true,
          port: true,
          username: true,
          credentialEncrypted: true,
        },
      },
    },
    orderBy: { updatedAt: 'desc' },
  });

  // Only monitor the newest RUNNING instance per unit (ignore retired leftovers).
  const active: typeof services = [];
  const seen = new Set<string>();
  for (const service of services) {
    const key = `${service.projectId}:${service.deployableUnitId ?? service.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    active.push(service);
  }

  await Promise.allSettled(active.map((service) => checkService(prisma, service)));
}

async function checkService(prisma: PrismaClient, service: MonitoredService): Promise<void> {
  const checkedAt = new Date();
  let status: HealthStatus = HealthStatus.UNHEALTHY;
  let serviceStatus: ServiceStatus | null = null;
  let responseTimeMs: number | null = null;
  let statusCode: number | null = null;
  let message = '应用没有响应';

  try {
    if (!service.containerId) {
      throw new Error('应用尚未启动');
    }
    const provider = createProvider(service);
    const runtime = await provider.getStatus(service.containerId);
    const observation: ContainerRuntimeObservation = runtime.running
      ? { exists: true, running: true, exitCode: runtime.exitCode ?? null }
      : { exists: true, running: false, exitCode: runtime.exitCode ?? null };
    if (!runtime.running) {
      const next = reconcileServiceInstanceRuntimeState({ observation });
      serviceStatus = next.status as ServiceStatus;
      status = next.healthStatus as HealthStatus;
      message = next.healthMessage;
    } else {
      const port = runtime.port ?? service.externalPort ?? service.port;
      if (!port) {
        throw new Error('应用访问地址尚未准备好');
      }

      // Remote RuntimeProvider probes via SSH on the target host loopback.
      // Local RuntimeProvider probes LaunchOS loopback.
      const healthPath = service.deployableUnit?.type === 'API' ? '/health' : '/';
      try {
        const probe = await provider.checkHttp(`http://127.0.0.1:${port}${healthPath}`, HTTP_TIMEOUT_MS);
        const next = reconcileServiceInstanceRuntimeState({
          observation,
          healthProbe: 'success',
        });
        serviceStatus = next.status as ServiceStatus;
        status = next.healthStatus as HealthStatus;
        responseTimeMs = probe.duration;
        statusCode = probe.status;
        message = next.healthMessage;
      } catch {
        const next = reconcileServiceInstanceRuntimeState({
          observation,
          healthProbe: 'fail',
        });
        serviceStatus = next.status as ServiceStatus;
        status = next.healthStatus as HealthStatus;
        message = next.healthMessage;
      }
    }
  } catch (error) {
    if (isMissingContainer(error)) {
      const next = reconcileServiceInstanceRuntimeState({ observation: { exists: false } });
      serviceStatus = next.status as ServiceStatus;
      status = next.healthStatus as HealthStatus;
      message = next.healthMessage;
    } else {
      message = toHealthMessage(error);
    }
  }

  await prisma.$transaction([
    prisma.serviceInstance.update({
      where: { id: service.id },
      data: {
        ...(serviceStatus ? { status: serviceStatus } : {}),
        healthStatus: status,
        lastHealthCheckAt: checkedAt,
        responseTimeMs,
        healthMessage: message,
      },
    }),
    prisma.serviceHealthCheck.create({
      data: {
        serviceInstanceId: service.id,
        status,
        responseTimeMs,
        statusCode,
        message,
        checkedAt,
      },
    }),
    prisma.serviceHealthCheck.deleteMany({
      where: {
        serviceInstanceId: service.id,
        checkedAt: { lt: new Date(checkedAt.getTime() - 7 * 24 * 60 * 60 * 1000) },
      },
    }),
  ]);
}

function createProvider(service: MonitoredService): RuntimeProvider {
  if (!service.serverInstanceId) {
    return createRuntimeProvider('local');
  }
  if (!service.server) {
    throw new Error('绑定的服务器不可用');
  }
  return createRuntimeProvider('remote', {
    host: service.server.host,
    port: service.server.port,
    username: service.server.username,
    password: decryptCredential(service.server.credentialEncrypted),
  });
}

function readIntervalMs(): number {
  const value = Number(process.env.HEALTH_CHECK_INTERVAL_MS);
  return Number.isInteger(value) && value >= 5_000 ? value : DEFAULT_INTERVAL_MS;
}

function isMissingContainer(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such|does not exist|not found|无法读取容器/i.test(message);
}

function toHealthMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('stopped') || message.includes('停止') || message.includes('exited')) {
    return '应用已停止运行';
  }
  if (message.includes('服务器') || message.includes('SSH') || message.includes('连接')) {
    return '暂时无法连接运行位置';
  }
  return '应用暂时没有响应';
}
