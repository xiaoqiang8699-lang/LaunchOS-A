/**
 * node scripts/_tmp-m5-server-snapshot.mjs
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const file of [resolve(root, '.env'), resolve(root, '.secrets/alpha-data-plane.env')]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');

const HOST = '116.62.198.184';
const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: HOST } });
if (!server) throw new Error('server missing');
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
});

async function run(label, cmd) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs: 60000 });
  const out = String(r.stdout || '').trim();
  console.log(`===${label}===\n${out}\n`);
  return out;
}

const nproc = await run('CPU', 'nproc; free -m | head -3; df -h / | tail -1; uptime');
const runtimes = await run(
  'RUNTIME',
  "podman ps -a --format '{{.Names}}|{{.Status}}' 2>/dev/null | head -60",
);
const ports = await run('PORTS', "ss -lnt | grep ':39' | wc -l; ss -lnt | grep ':39' | head -30");
const images = await run(
  'IMAGES',
  "podman images --format '{{.Repository}}:{{.Tag}}|{{.Size}}' 2>/dev/null | head -30",
);
const diskExtra = await run(
  'DISK_OPT',
  'du -sh /opt/launchos/artifacts 2>/dev/null; du -sh /opt/launchos/artifacts/launchos-image-archives 2>/dev/null; df -BG / | tail -1',
);

const si = await prisma.serviceInstance.groupBy({
  by: ['status'],
  where: { serverInstanceId: server.id },
  _count: true,
});
const activeDeps = await prisma.deployment.count({
  where: { status: { in: ['CREATED', 'QUEUED', 'RUNNING'] } },
});
const artifacts = await prisma.artifact.aggregate({ _count: true, _sum: { size: true } });

const snapshot = {
  serverId: server.id,
  host: HOST,
  nproc,
  runtimes,
  ports,
  images,
  diskExtra,
  serviceInstances: si,
  activeDeployments: activeDeps,
  artifacts: { count: artifacts._count, sizeBytes: artifacts._sum.size },
  metadata: server.metadata,
};
mkdirSync(join(root, '.tools/alpha-runtime'), { recursive: true });
writeFileSync(join(root, '.tools/alpha-runtime/m5-server-snapshot.json'), JSON.stringify(snapshot, null, 2));
await runner.disconnect().catch(() => undefined);
await prisma.$disconnect();
console.log('SNAPSHOT_OK');
