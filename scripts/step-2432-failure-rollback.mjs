/**
 * Step 24.3.2 — failure rollback: new container unhealthy must not replace old.
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const { PrismaClient, ServiceStatus } = require(
  resolve(ROOT, 'packages/database/generated/client'),
);
const { RemoteDockerRuntime } = require(resolve(ROOT, 'packages/runtime/dist/index.js'));
const { decryptCredential, allocateHostPort } = (() => {
  const shared = require(resolve(ROOT, 'packages/shared/dist/index.js'));
  const dep = require(resolve(ROOT, 'packages/deployment/dist/index.js'));
  return { decryptCredential: shared.decryptCredential, allocateHostPort: dep.allocateHostPort };
})();

const PROJECT_ID = 'cmu3j24mv0001ri7wcsoa30hj';
const WEB_UNIT = 'cmu3j27340007ri7wcno1xrai';
const SERVER_ID = 'cmu22cqo80007ri6wkt4krfsq';

const prisma = new PrismaClient();
const old = await prisma.serviceInstance.findFirst({
  where: { projectId: PROJECT_ID, deployableUnitId: WEB_UNIT, status: ServiceStatus.RUNNING },
  orderBy: { updatedAt: 'desc' },
});
if (!old?.containerId || !old.externalPort) {
  throw new Error('no healthy web instance');
}
const oldCid = old.containerId;
const oldPort = old.externalPort;

const server = await prisma.serverInstance.findUnique({ where: { id: SERVER_ID } });
const remote = new RemoteDockerRuntime({
  host: server.host,
  port: server.port,
  username: server.username,
  password: decryptCredential(server.credentialEncrypted),
});

const hostPort = await allocateHostPort({
  prisma,
  remote,
  serverInstanceId: SERVER_ID,
});

const name = `launchos-failtest-${Date.now().toString(36)}`;
// Sleep keeps container RUNNING but nothing listens on mapped port → health fails.
const run = await remote
  .withRunner?.(async () => null)
  .catch(() => null);

// Use docker via RemoteRunner for a sleeping container with published port.
const { RemoteRunner } = require(resolve(ROOT, 'packages/remote-runner/dist/index.js'));
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: server.username,
  password: decryptCredential(server.credentialEncrypted),
});
await runner.execute(`docker rm -f ${name}`, { timeoutMs: 15000 }).catch(() => undefined);
const started = await runner.execute(
  [
    'docker run -d',
    `--name ${name}`,
    `-p 127.0.0.1:${hostPort}:80`,
    '--label launchos.managed=true',
    `--label launchos.projectId=${PROJECT_ID}`,
    `--label launchos.deployableUnitId=${WEB_UNIT}`,
    '--label launchos.deploymentId=failure-test',
    '--label launchos.serviceInstanceId=failure-test-si',
    'docker.io/library/busybox:1.36',
    'sleep',
    '3600',
  ].join(' '),
  { timeoutMs: 60000 },
);
const newCid = (started.stdout || '').trim().split(/\r?\n/)[0];
if (!newCid || started.exitCode !== 0) {
  console.error('failed to start sleep container', started.stderr);
  await runner.disconnect();
  await prisma.$disconnect();
  process.exit(1);
}

let healthFailed = false;
try {
  await remote.checkHttp(`http://127.0.0.1:${hostPort}/`, 8_000);
} catch {
  healthFailed = true;
}

// Simulate engine catch: destroy new, leave old.
await remote.destroyRuntime(newCid);
await runner.disconnect();

const oldStatus = await remote.getContainerStatus(oldCid);
const https = await fetch('https://web-launchos.zsaos.com/', {
  signal: AbortSignal.timeout(15000),
}).then((r) => r.status);
const still = await prisma.serviceInstance.findUnique({
  where: { id: old.id },
  select: { status: true, containerId: true, externalPort: true },
});
console.log(
  JSON.stringify(
    {
      healthFailed,
      newDestroyed: true,
      oldStillRunning: oldStatus.running === true,
      oldPortUnchanged: still?.externalPort === oldPort,
      oldStatus: still?.status,
      publicHttps: https,
      hostPortAllocated: hostPort,
    },
    null,
    2,
  ),
);
const pass =
  healthFailed &&
  oldStatus.running &&
  still?.status === ServiceStatus.RUNNING &&
  still.externalPort === oldPort &&
  https === 200;
await prisma.$disconnect();
process.exit(pass ? 0 : 1);
