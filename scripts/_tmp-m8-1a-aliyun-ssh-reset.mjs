/**
 * Load Aliyun AK and locate ECS by public IP. No secrets printed.
 * Optionally reset root password and update local ServerInstance.
 * node scripts/_tmp-m8-1a-aliyun-ssh-reset.mjs [--reset]
 */
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
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
const requireProviders = createRequire(resolve(root, 'packages/providers/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { encryptCredential, decryptCredential, resolveServerSshUsername } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const Ecs20140526 = requireProviders('@alicloud/ecs20140526');
const OpenApi = requireProviders('@alicloud/openapi-client');
const Util = requireProviders('@alicloud/tea-util');

const TARGET_HOST = '116.62.198.184';
const doReset = process.argv.includes('--reset');

const ak = process.env.ALIYUN_ACCESS_KEY_ID || '';
const sk = process.env.ALIYUN_ACCESS_KEY_SECRET || '';
const region = process.env.ALIYUN_REGION || 'cn-hangzhou';

console.log(
  JSON.stringify({
    akPresent: ak.length > 8,
    skPresent: sk.length > 8,
    akFp: ak ? createHash('sha256').update(ak).digest('hex').slice(0, 8) : null,
    region,
    doReset,
  }),
);

if (!ak || !sk) {
  console.error('ALIYUN keys missing');
  process.exit(2);
}

const config = new OpenApi.Config({ accessKeyId: ak, accessKeySecret: sk });
config.endpoint = `ecs.${region}.aliyuncs.com`;
const client = new Ecs20140526.default(config);

const listed = await client.describeInstancesWithOptions(
  new Ecs20140526.DescribeInstancesRequest({
    regionId: region,
    pageSize: 100,
  }),
  new Util.RuntimeOptions({}),
);

const instances = listed.body?.instances?.instance || [];
const match = instances.find((item) => {
  const ips = [
    ...(item.publicIpAddress?.ipAddress || []),
    item.eipAddress?.ipAddress,
    ...(item.networkInterfaces?.networkInterface || []).flatMap((ni) => ni.primaryIpAddress || []),
  ].filter(Boolean);
  return ips.includes(TARGET_HOST) || item.instanceId === process.env.LAUNCHOS_GATEWAY_SERVER_ID;
});

if (!match) {
  console.log(
    JSON.stringify({
      found: false,
      count: instances.length,
      sample: instances.slice(0, 5).map((i) => ({
        id: i.instanceId,
        name: i.instanceName,
        status: i.status,
        public: i.publicIpAddress?.ipAddress || [],
        eip: i.eipAddress?.ipAddress || null,
      })),
    }),
  );
  process.exit(1);
}

console.log(
  JSON.stringify({
    found: true,
    instanceId: match.instanceId,
    name: match.instanceName,
    status: match.status,
    public: match.publicIpAddress?.ipAddress || [],
    eip: match.eipAddress?.ipAddress || null,
  }),
);

function makePassword() {
  // Aliyun ECS password rules: 8-30, upper+lower+digit+special
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const special = '!@#$%^&*()_+-=';
  const all = upper + lower + digits + special;
  const pick = (set) => set[randomBytes(1)[0] % set.length];
  let out = pick(upper) + pick(lower) + pick(digits) + pick(special);
  while (out.length < 20) out += pick(all);
  return out;
}

if (!doReset) {
  console.log('pass --reset to rotate ECS password and update local DB');
  process.exit(0);
}

const newPassword = makePassword();
await client.resetAccountPasswordWithOptions(
  new Ecs20140526.ResetAccountPasswordRequest({
    regionId: region,
    instanceId: match.instanceId,
    password: newPassword,
  }),
  new Util.RuntimeOptions({}),
);

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({
  where: { OR: [{ id: 'cmuma9i480001rij49yv4yw2q' }, { host: TARGET_HOST }] },
});
if (!server) throw new Error('local server row missing');
await prisma.serverInstance.update({
  where: { id: server.id },
  data: { credentialEncrypted: encryptCredential(newPassword) },
});

console.log(JSON.stringify({ resetSubmitted: true, waitingSec: 45 }));
await new Promise((r) => setTimeout(r, 45000));

const username = resolveServerSshUsername({ serverUsername: server.username, provider: server.provider });
const runner = new RemoteRunner();
try {
  await runner.connect({
    host: TARGET_HOST,
    port: server.port || 22,
    username,
    password: newPassword,
    readyTimeoutMs: 30000,
  });
  const r = await runner.execute({ command: 'echo SSH_OK && hostname' }, { timeoutMs: 15000 });
  console.log(JSON.stringify({ ssh: 'ok', stdout: String(r.stdout || '').trim().slice(0, 120) }));
  await runner.disconnect();
} catch (error) {
  console.log(JSON.stringify({ ssh: 'fail', error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally {
  // wipe local var
}
await prisma.$disconnect();
