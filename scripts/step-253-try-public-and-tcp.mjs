/**
 * Try allocate public endpoint + test TCP from target (no CreateDBInstance).
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
const requireP = createRequire(resolve(root, 'packages/providers/package.json'));
const rdsPkg = requireP('@alicloud/rds20140815');
const openapi = requireP('@alicloud/openapi-core');

const ID = 'pgm-bp14j1lljy571v8h';
const prisma = new PrismaClient();
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

// Also set whitelist on default array
const config = new openapi.$OpenApiUtil.Config({
  accessKeyId: secrets.accessKey,
  accessKeySecret: secrets.secretKey,
});
config.endpoint = 'rds.aliyuncs.com';
const rds = new rdsPkg.default(config);
try {
  await rds.modifySecurityIps(
    new rdsPkg.ModifySecurityIpsRequest({
      DBInstanceId: ID,
      securityIps: '172.16.0.0/12,8.138.113.134',
      DBInstanceIPArrayName: 'default',
      modifyMode: 'Cover',
    }),
  );
  console.log('updated default whitelist');
} catch (e) {
  console.log('whitelist default err', String(e?.message || e).slice(0, 300));
}

let publicInfo = null;
try {
  publicInfo = await provider.allocatePublicConnection(ID, 5432);
  console.log(
    JSON.stringify(
      {
        publicHostMasked: publicInfo.host
          ? `${String(publicInfo.host).slice(0, 28)}***`
          : null,
        port: publicInfo.port,
        networkType: publicInfo.networkType,
      },
      null,
      2,
    ),
  );
} catch (e) {
  console.log('allocate err', String(e?.message || e).slice(0, 400));
}

const privateInfo = await provider.getConnectionInfo(ID, true);
const resource = await prisma.cloudResource.findUnique({
  where: { id: 'cmu4110xm0001ric027vr0tc3' },
});
const meta = resource.metadata || {};
const server = await prisma.serverInstance.findUnique({
  where: { id: meta.serverInstanceId },
});
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: server.username,
  password: decryptCredential(server.credentialEncrypted),
});

async function tcp(host, port) {
  const h = host.replace(/[^a-zA-Z0-9.-]/g, '');
  try {
    const r = await runner.execute(
      `timeout 8 bash -lc "exec 3<>/dev/tcp/${h}/${port} && echo ok || echo fail"; echo exit:$?`,
      { timeoutMs: 15_000 },
    );
    return { out: String(r.stdout || '').trim(), err: String(r.stderr || '').slice(0, 100) };
  } catch (e) {
    return { error: String(e?.message || e).slice(0, 200) };
  }
}

console.log(
  JSON.stringify(
    {
      tcpPrivate: await tcp(privateInfo.host, privateInfo.port),
      tcpPublic: publicInfo ? await tcp(publicInfo.host, publicInfo.port) : null,
    },
    null,
    2,
  ),
);
await prisma.$disconnect();
