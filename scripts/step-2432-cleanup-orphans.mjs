/**
 * One-shot cleanup: keep newest RUNNING ServiceInstance per unit; stop other LaunchOS containers.
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
const { decryptCredential } = require(resolve(ROOT, 'packages/shared/dist/index.js'));

const PROJECT_ID = process.env.E2E_PROJECT_ID || 'cmu3j24mv0001ri7wcsoa30hj';
const SERVER_ID = process.env.E2E_SERVER_ID || 'cmu22cqo80007ri6wkt4krfsq';

const prisma = new PrismaClient();

const running = await prisma.serviceInstance.findMany({
  where: { projectId: PROJECT_ID, status: ServiceStatus.RUNNING },
  orderBy: { updatedAt: 'desc' },
  select: {
    id: true,
    containerId: true,
    deployableUnitId: true,
    externalPort: true,
    updatedAt: true,
  },
});

const keep = new Set();
const seenUnit = new Set();
for (const row of running) {
  const key = row.deployableUnitId || row.id;
  if (seenUnit.has(key)) {
    await prisma.serviceInstance.update({
      where: { id: row.id },
      data: { status: ServiceStatus.STOPPED, healthMessage: 'Step 24.3.2 cleanup' },
    });
    console.log(`DB_STOP ${row.id} port=${row.externalPort}`);
  } else {
    seenUnit.add(key);
    keep.add(row.containerId);
    console.log(`KEEP ${row.id} unit=${row.deployableUnitId} cid=${row.containerId?.slice(0, 12)}`);
  }
}

const server = await prisma.serverInstance.findUnique({ where: { id: SERVER_ID } });
if (!server) {
  throw new Error('server missing');
}
const remote = new RemoteDockerRuntime({
  host: server.host,
  port: server.port,
  username: server.username,
  password: decryptCredential(server.credentialEncrypted),
});

const listed = await remote.execDocker?.(
  `ps -a --format "{{.ID}}|{{.Names}}|{{.Ports}}"`,
).catch?.(() => null);

// Use public API via listListening + destroy by name prefix
const { RemoteRunner } = require(resolve(ROOT, 'packages/remote-runner/dist/index.js'));
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: server.username,
  password: decryptCredential(server.credentialEncrypted),
});
const out = await runner.execute(
  `docker ps -a --format '{{.ID}}|{{.Names}}|{{.Ports}}'`,
  { timeoutMs: 30000 },
);
const lines = (out.stdout || '').split(/\r?\n/).filter(Boolean);
let removed = 0;
for (const line of lines) {
  const [id, name] = line.split('|');
  if (!name?.startsWith('launchos-')) continue;
  const keepThis = [...keep].some(
    (cid) => cid && (cid === id || cid.startsWith(id) || id.startsWith(cid.slice(0, 12))),
  );
  if (keepThis) {
    console.log(`KEEP_CONTAINER ${name}`);
    continue;
  }
  await runner.execute(`docker rm -f ${id}`, { timeoutMs: 30000 });
  removed += 1;
  console.log(`REMOVED ${name}`);
}
await runner.disconnect();
await prisma.$disconnect();
console.log(`DONE removed=${removed} kept=${keep.size}`);
