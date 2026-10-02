/**
 * Reset Alpha ECS SSH password via Aliyun ProviderAccount AK.
 * Updates local ServerInstance credential. No secrets printed.
 * node scripts/_tmp-m8-1a-aliyun-ssh-reset2.mjs --confirm-reset
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
if (!process.argv.includes('--confirm-reset')) {
  console.error('pass --confirm-reset');
  process.exit(2);
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
const region = process.env.ALIYUN_REGION || 'cn-hangzhou';

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({
  where: { OR: [{ id: 'cmuma9i480001rij49yv4yw2q' }, { host: TARGET_HOST }] },
});
if (!server) throw new Error('server missing');
const meta = server.metadata && typeof server.metadata === 'object' ? server.metadata : {};

const account = await prisma.providerAccount.findFirst({
  where: { provider: { type: 'ALIYUN' }, credentialEncrypted: { not: null } },
  include: { provider: true },
  orderBy: { updatedAt: 'desc' },
});
if (!account?.credentialEncrypted) throw new Error('ALIYUN provider account missing');
const secrets = JSON.parse(decryptCredential(account.credentialEncrypted));
const ak = secrets.accessKey || secrets.accessKeyId || secrets.AccessKeyId;
const sk = secrets.secretKey || secrets.accessKeySecret || secrets.AccessKeySecret;
if (!ak || !sk) throw new Error('AK/SK missing in provider account');

console.log(
  JSON.stringify({
    akFp: createHash('sha256').update(ak).digest('hex').slice(0, 8),
    region,
    cloudResourceId: meta.cloudResourceId || null,
    providerResourceId: meta.providerResourceId || null,
  }),
);

const config = new OpenApi.Config({ accessKeyId: ak, accessKeySecret: sk });
config.endpoint = `ecs.${region}.aliyuncs.com`;
const client = new Ecs20140526.default(config);

let instanceId = meta.providerResourceId || meta.cloudResourceId || null;
if (!instanceId || !String(instanceId).startsWith('i-')) {
  const listed = await client.describeInstancesWithOptions(
    new Ecs20140526.DescribeInstancesRequest({ regionId: region, pageSize: 100 }),
    new Util.RuntimeOptions({}),
  );
  const instances = listed.body?.instances?.instance || [];
  const match = instances.find((item) => {
    const ips = [
      ...(item.publicIpAddress?.ipAddress || []),
      item.eipAddress?.ipAddress,
    ].filter(Boolean);
    return ips.includes(TARGET_HOST);
  });
  if (!match) {
    console.log(
      JSON.stringify({
        found: false,
        count: instances.length,
        sample: instances.slice(0, 8).map((i) => ({
          id: i.instanceId,
          name: i.instanceName,
          status: i.status,
          public: i.publicIpAddress?.ipAddress || [],
          eip: i.eipAddress?.ipAddress || null,
        })),
      }),
    );
    throw new Error('ECS instance not found by IP');
  }
  instanceId = match.instanceId;
  console.log(JSON.stringify({ foundByIp: true, instanceId, status: match.status, name: match.instanceName }));
} else {
  console.log(JSON.stringify({ foundByMeta: true, instanceId }));
}

function makePassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const special = '!@#$%^&*_+-=';
  const all = upper + lower + digits + special;
  const pick = (set) => set[randomBytes(1)[0] % set.length];
  let out = pick(upper) + pick(lower) + pick(digits) + pick(special);
  while (out.length < 22) out += pick(all);
  return out;
}

const newPassword = makePassword();
await client.modifyInstanceAttributeWithOptions(
  new Ecs20140526.ModifyInstanceAttributeRequest({
    regionId: region,
    instanceId,
    password: newPassword,
  }),
  new Util.RuntimeOptions({}),
);

await prisma.serverInstance.update({
  where: { id: server.id },
  data: {
    credentialEncrypted: encryptCredential(newPassword),
    metadata: {
      ...meta,
      providerResourceId: instanceId,
      passwordPresent: true,
      passwordLength: newPassword.length,
      passwordRotatedAt: new Date().toISOString(),
      passwordRotateReason: 'm8-1a-signature-fix-ssh-recover',
    },
  },
});

console.log(JSON.stringify({ resetSubmitted: true, waitSec: 60 }));
await new Promise((r) => setTimeout(r, 60000));

const username = resolveServerSshUsername({ serverUsername: server.username, provider: server.provider });
const runner = new RemoteRunner();
let sshOk = false;
for (let i = 0; i < 6; i++) {
  try {
    await runner.connect({
      host: TARGET_HOST,
      port: server.port || 22,
      username,
      password: newPassword,
      readyTimeoutMs: 25000,
    });
    const r = await runner.execute({ command: 'echo SSH_OK && hostname && date -Is' }, { timeoutMs: 15000 });
    console.log(JSON.stringify({ ssh: 'ok', attempt: i + 1, out: String(r.stdout || '').trim().slice(0, 200) }));
    await runner.disconnect();
    sshOk = true;
    break;
  } catch (error) {
    console.log(
      JSON.stringify({
        ssh: 'retry',
        attempt: i + 1,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    await new Promise((r) => setTimeout(r, 15000));
  }
}

await prisma.$disconnect();
if (!sshOk) {
  console.error('SSH still failing after password reset');
  process.exit(1);
}
console.log('SSH_RECOVERED=true');
