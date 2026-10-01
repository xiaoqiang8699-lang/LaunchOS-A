import type { PrismaClient } from '@launchos/database';
import { ServiceStatus } from '@launchos/database';
import type { RemoteDockerRuntime } from '@launchos/runtime';
import { withRedisLock } from '@launchos/shared';

/** Host-side dynamic port pool. Never overlaps common containerPorts (80/3000/…). */
export const HOST_PORT_RANGE_START = 39000;
export const HOST_PORT_RANGE_END = 39999;

export function selectHostPort(
  blocked: Iterable<number>,
  start = HOST_PORT_RANGE_START,
  end = HOST_PORT_RANGE_END,
): number | null {
  const taken = new Set(blocked);
  for (let port = start; port <= end; port += 1) {
    if (!taken.has(port)) return port;
  }
  return null;
}

export function hostPortCandidates(start = HOST_PORT_RANGE_START, end = HOST_PORT_RANGE_END): number[] {
  const list: number[] = [];
  for (let p = start; p <= end; p += 1) {
    list.push(p);
  }
  return list;
}

export async function listDbReservedHostPorts(
  prisma: PrismaClient,
  serverInstanceId: string,
): Promise<number[]> {
  const rows = await prisma.serviceInstance.findMany({
    where: {
      serverInstanceId,
      status: { in: [ServiceStatus.CREATING, ServiceStatus.RUNNING] },
    },
    select: { port: true, externalPort: true },
  });
  const ports = new Set<number>();
  for (const row of rows) {
    for (const value of [row.externalPort, row.port]) {
      if (typeof value === 'number' && value > 0) {
        ports.add(value);
      }
    }
  }
  return [...ports];
}

export async function listServerListeningPorts(
  remote: Pick<RemoteDockerRuntime, 'listListeningHostPorts'>,
): Promise<number[]> {
  return remote.listListeningHostPorts();
}

export type AllocateHostPortInput = {
  prisma: PrismaClient;
  remote: RemoteDockerRuntime;
  serverInstanceId: string;
  /** Extra ports to skip (e.g. previous instance still running). */
  excludePorts?: number[];
};

/**
 * Allocate a unique hostPort for a ServerInstance.
 * Checks DB reserved ports + remote listening ports under a Redis lock.
 */
export async function allocateHostPort(input: AllocateHostPortInput): Promise<number> {
  return withRedisLock(`server-port:${input.serverInstanceId}`, 20_000, async () => {
    const [dbPorts, livePorts] = await Promise.all([
      listDbReservedHostPorts(input.prisma, input.serverInstanceId),
      listServerListeningPorts(input.remote),
    ]);
    const blocked = [
      ...dbPorts,
      ...livePorts,
      ...(input.excludePorts ?? []),
    ];
    const candidate = selectHostPort(blocked);
    if (candidate != null) return candidate;
    throw new Error('服务器运行资源暂时冲突，请重新尝试上线。');
  });
}

export function toUserFacingRuntimeError(message: string): string {
  if (/address already in use|EADDRINUSE|bind:|port.*in use/i.test(message)) {
    return '服务器运行资源暂时冲突，请重新尝试上线。';
  }
  if (/资源锁等待超时/.test(message)) {
    return '服务器运行资源暂时繁忙，请稍后重试上线。';
  }
  return message;
}
