/**
 * Read-only pre-resume target-server check for Step 25.3.
 * Does NOT retry / enqueue / CreateDBInstance / mutate CloudResource.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const CR_ID = 'cmu4110xm0001ric027vr0tc3';
const EXPECTED_HOST = '8.138.113.134';

for (const line of readFileSync(resolve(root, '.env'), 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i <= 0) continue;
  const k = t.slice(0, i).trim();
  let v = t.slice(i + 1).trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1);
  }
  if (process.env[k] === undefined) process.env[k] = v;
}

const { PrismaClient } = require(resolve(root, 'packages/database/generated/client'));
const prisma = new PrismaClient();

function asMeta(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

function isLocalTestHost(host, port) {
  const h = String(host || '');
  const p = Number(port);
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || p === 2222;
}

try {
  const resource = await prisma.cloudResource.findUnique({
    where: { id: CR_ID },
  });
  if (!resource) throw new Error('CloudResource missing');
  const meta = asMeta(resource.metadata);

  const metaServerId =
    typeof meta.serverInstanceId === 'string' ? meta.serverInstanceId : null;
  const metaServer = metaServerId
    ? await prisma.serverInstance.findFirst({
        where: { id: metaServerId, workspaceId: resource.workspaceId },
      })
    : null;

  const unitIds = Array.isArray(meta.unitIds)
    ? meta.unitIds.filter((x) => typeof x === 'string')
    : [];
  const units = unitIds.length
    ? await prisma.deployableUnit.findMany({
        where: { id: { in: unitIds } },
        select: { id: true, name: true, type: true, projectId: true },
      })
    : [];

  const allServers = await prisma.serverInstance.findMany({
    where: { workspaceId: resource.workspaceId },
    select: {
      id: true,
      name: true,
      host: true,
      port: true,
      status: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: 'desc' },
  });
  const local2222 = allServers.filter((s) => isLocalTestHost(s.host, s.port));

  // Exact same order as database-provision-executor.resolveServerTarget
  let execResolved = null;
  let execPath = null;
  if (metaServer) {
    execResolved = {
      serverId: metaServer.id,
      name: metaServer.name,
      host: metaServer.host,
      port: metaServer.port,
    };
    execPath = 'metadata.serverInstanceId';
  } else {
    const cloudServer = await prisma.cloudResource.findFirst({
      where: {
        projectId: resource.projectId,
        type: 'SERVER',
        status: 'RUNNING',
      },
      orderBy: { createdAt: 'desc' },
    });
    if (cloudServer?.providerResourceId) {
      const byHost = cloudServer.publicIp
        ? await prisma.serverInstance.findFirst({
            where: {
              workspaceId: resource.workspaceId,
              host: cloudServer.publicIp,
            },
            orderBy: { updatedAt: 'desc' },
          })
        : null;
      execResolved = byHost
        ? {
            serverId: byHost.id,
            name: byHost.name,
            host: byHost.host,
            port: byHost.port,
          }
        : {
            serverId: null,
            name: `CloudResource.SERVER:${cloudServer.id}`,
            host: cloudServer.publicIp,
            port: null,
            ecsInstanceId: cloudServer.providerResourceId,
          };
      execPath = byHost
        ? 'project RUNNING CloudResource SERVER → ServerInstance by publicIp'
        : 'project RUNNING CloudResource SERVER (ecs/publicIp only)';
    } else {
      const running = await prisma.serviceInstance.findFirst({
        where: {
          projectId: resource.projectId,
          status: 'RUNNING',
          serverInstanceId: { not: null },
        },
        orderBy: { updatedAt: 'desc' },
        include: {
          server: { select: { id: true, name: true, host: true, port: true } },
        },
      });
      if (running?.server) {
        execResolved = {
          serverId: running.server.id,
          name: running.server.name,
          host: running.server.host,
          port: running.server.port,
        };
        execPath = 'project RUNNING ServiceInstance.server';
      } else {
        const anyServer = await prisma.serverInstance.findFirst({
          where: { workspaceId: resource.workspaceId },
          orderBy: { updatedAt: 'desc' },
        });
        if (anyServer) {
          execResolved = {
            serverId: anyServer.id,
            name: anyServer.name,
            host: anyServer.host,
            port: anyServer.port,
          };
          execPath = 'workspace ServerInstance updatedAt desc fallback';
        }
      }
    }
  }

  const runningServices = await prisma.serviceInstance.findMany({
    where: { status: 'RUNNING', containerId: { not: null } },
    select: {
      id: true,
      projectId: true,
      deployableUnit: { select: { id: true, name: true, type: true } },
      server: {
        select: { id: true, name: true, host: true, port: true, status: true },
      },
    },
    take: 80,
  });
  const servicesOn2222 = runningServices.filter(
    (s) => s.server && isLocalTestHost(s.server.host, s.server.port),
  );
  const servicesOnExpected = runningServices.filter(
    (s) => s.server && s.server.host === EXPECTED_HOST,
  );

  const targetHost = execResolved?.host || null;
  const targetPort = execResolved?.port ?? null;
  const isSafe =
    Boolean(resource.providerResourceId?.trim()) &&
    targetHost === EXPECTED_HOST &&
    !isLocalTestHost(targetHost, targetPort);

  console.log(
    JSON.stringify(
      {
        cloudResource: {
          id: resource.id,
          projectId: resource.projectId,
          status: resource.status,
          phase: meta.phase || null,
          providerResourceId: resource.providerResourceId,
          createInstanceCompleted: meta.createInstanceCompleted === true,
          metaServerInstanceId: metaServerId,
          unitIds,
        },
        units: units.map((u) => ({ id: u.id, name: u.name, type: u.type })),
        executorResolvePath: execPath,
        targetServerForRdsResume: execResolved,
        expectedHost: EXPECTED_HOST,
        hostMatchesExpected: targetHost === EXPECTED_HOST,
        isLocal2222Target: isLocalTestHost(targetHost, targetPort),
        sshClientError2222Source: {
          note: 'Log comes from packages/remote-runner RemoteRunner when health-monitor/runtime reconcile SSHes ServerInstance',
          local2222ServersInWorkspace: local2222.map((s) => ({
            serverId: s.id,
            name: s.name,
            host: s.host,
            port: s.port,
            status: s.status,
            updatedAt: s.updatedAt,
          })),
          runningServiceInstancesOn2222: servicesOn2222.map((s) => ({
            serviceInstanceId: s.id,
            projectId: s.projectId,
            unit: s.deployableUnit,
            serverId: s.server?.id,
            serverName: s.server?.name,
            host: s.server?.host,
            port: s.server?.port,
          })),
          runningServiceInstancesOnExpectedHost: servicesOnExpected.map((s) => ({
            serviceInstanceId: s.id,
            projectId: s.projectId,
            unit: s.deployableUnit,
            serverId: s.server?.id,
            serverName: s.server?.name,
            host: s.server?.host,
            port: s.server?.port,
          })),
        },
        workspaceServerSummary: allServers.map((s) => ({
          serverId: s.id,
          name: s.name,
          host: s.host,
          port: s.port,
          status: s.status,
        })),
        createDbInstanceWouldBeZero: Boolean(resource.providerResourceId?.trim()),
        safeToResume: isSafe,
      },
      null,
      2,
    ),
  );
} finally {
  await prisma.$disconnect();
}
