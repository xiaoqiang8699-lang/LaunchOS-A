import { ServerScope, type Prisma, type PrismaClient } from '@launchos/database';
import { encryptCredential, evaluateManagedNodePreflight, type ManagedNodeProbeFacts } from '@launchos/shared';

const publicNodeSelect = {
  id: true,
  name: true,
  host: true,
  port: true,
  username: true,
  provider: true,
  status: true,
  dockerStatus: true,
  scope: true,
  workspaceId: true,
} as const;

export async function registerPlatformManagedNode(
  prisma: PrismaClient,
  input: { name: string; host: string; port: number; username: string; password: string },
) {
  const name = input.name.trim();
  const host = input.host.trim();
  const username = input.username.trim();
  const password = input.password;
  if (!name || !host || !username || !password) {
    throw new Error('MANAGED_NODE_FIELDS_REQUIRED');
  }
  if (!Number.isInteger(input.port) || input.port <= 0) {
    throw new Error('MANAGED_NODE_PORT_INVALID');
  }
  return prisma.serverInstance.create({
    data: {
      workspaceId: null,
      scope: ServerScope.PLATFORM_MANAGED,
      name,
      host,
      port: input.port,
      username,
      credentialEncrypted: encryptCredential(password),
      provider: 'CUSTOM',
      status: 'CREATED',
      dockerStatus: 'UNKNOWN',
      metadata: {
        preflightStatus: 'REGISTERED',
        localGatewayReady: false,
        schedulable: false,
      },
    },
    select: publicNodeSelect,
  });
}

export async function retirePlatformManagedNode(prisma: PrismaClient, serverInstanceId: string) {
  const existing = await prisma.serverInstance.findFirst({
    where: { id: serverInstanceId, scope: ServerScope.PLATFORM_MANAGED },
    select: { id: true, metadata: true },
  });
  if (!existing) {
    throw new Error('MANAGED_NODE_NOT_FOUND');
  }
  const metadata = asObject(existing.metadata);
  return prisma.serverInstance.update({
    where: { id: existing.id },
    data: {
      status: 'UNAVAILABLE',
      metadata: {
        ...metadata,
        preflightStatus: 'RETIRED',
        localGatewayReady: false,
        schedulable: false,
      } as Prisma.InputJsonValue,
    },
    select: publicNodeSelect,
  });
}

export async function applyManagedNodePreflight(
  prisma: PrismaClient,
  serverInstanceId: string,
  facts: ManagedNodeProbeFacts,
) {
  const existing = await prisma.serverInstance.findFirst({
    where: { id: serverInstanceId, scope: ServerScope.PLATFORM_MANAGED },
    select: { id: true, metadata: true },
  });
  if (!existing) {
    throw new Error('MANAGED_NODE_NOT_FOUND');
  }
  const result = evaluateManagedNodePreflight(facts);
  const metadata = asObject(existing.metadata);
  return prisma.serverInstance.update({
    where: { id: existing.id },
    data: {
      status: result.status === 'READY' ? 'READY' : 'UNAVAILABLE',
      dockerStatus: facts.dockerDaemonUsable ? 'READY' : 'ERROR',
      metadata: {
        ...metadata,
        preflightStatus: result.status === 'READY' ? 'READY' : 'FAILED',
        localGatewayReady: result.localGatewayReady,
        schedulable: result.status === 'READY',
        preflightBlockers: result.blockers.map((item) => item.code),
      } as Prisma.InputJsonValue,
    },
    select: publicNodeSelect,
  });
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}
