/**
 * Diagnose why Target Server cannot SELECT 1 (SSH only, no secrets printed).
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
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
const { decryptCredential } = require(resolve(root, 'packages/shared/dist/index.js'));
const { AlibabaCloudDatabaseProvider } = require(
  resolve(root, 'packages/providers/dist/index.js'),
);
const { RemoteRunner } = require(resolve(root, 'packages/remote-runner/dist/index.js'));

const prisma = new PrismaClient();
const resource = await prisma.cloudResource.findUnique({
  where: { id: 'cmu4110xm0001ric027vr0tc3' },
});
const meta = resource.metadata || {};
const server = await prisma.serverInstance.findUnique({
  where: { id: meta.serverInstanceId },
});
const account = await prisma.providerAccount.findFirst({
  where: { status: 'ACTIVE', provider: { type: 'ALIYUN' } },
  orderBy: { createdAt: 'asc' },
});
const secrets = JSON.parse(decryptCredential(account.credentialEncrypted));
const provider = new AlibabaCloudDatabaseProvider({
  accessKey: secrets.accessKey,
  secretKey: secrets.secretKey,
  region: 'cn-hangzhou',
});
const conn = await provider.getConnectionInfo(resource.providerResourceId, true);
const host = conn.host;
const port = conn.port;

const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: server.username,
  password: decryptCredential(server.credentialEncrypted),
});

async function run(cmd, timeoutMs = 20_000) {
  try {
    const r = await runner.execute(cmd, { timeoutMs });
    return {
      exitCode: r.exitCode,
      out: String(r.stdout || '').slice(0, 300),
      err: String(r.stderr || '').slice(0, 300),
    };
  } catch (e) {
    return { error: String(e?.message || e).slice(0, 200) };
  }
}

const hostSafe = host.replace(/[^a-zA-Z0-9.-]/g, '');
const results = {
  hostMasked: `${hostSafe.slice(0, 28)}***`,
  port,
  docker: await run('docker version --format "{{.Server.Version}}"'),
  images: await run('docker images postgres --format "{{.Repository}}:{{.Tag}}" | head'),
  getent: await run(`getent hosts ${hostSafe} || nslookup ${hostSafe} || true`),
  nc: await run(`timeout 5 bash -lc "echo > /dev/tcp/${hostSafe}/${port}" 2>&1; echo exit:$?`),
  nc2: await run(
    `timeout 8 bash -lc "exec 3<>/dev/tcp/${hostSafe}/${port} && echo ok || echo fail" 2>&1; echo exit:$?`,
  ),
};

console.log(JSON.stringify(results, null, 2));
await prisma.$disconnect();
