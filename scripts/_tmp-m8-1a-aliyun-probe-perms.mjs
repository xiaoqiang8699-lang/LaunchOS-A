/**
 * Probe what Aliyun APIs this AK can call + ssh username variants.
 * node scripts/_tmp-m8-1a-aliyun-probe-perms.mjs
 */
import { createRequire } from 'node:module';
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
const requireRunner = createRequire(resolve(root, 'packages/remote-runner/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername } = requireApi('@launchos/shared');
const { Client } = requireRunner('ssh2');
const Ecs20140526 = requireProviders('@alicloud/ecs20140526');
const OpenApi = requireProviders('@alicloud/openapi-client');
const Util = requireProviders('@alicloud/tea-util');

const region = process.env.ALIYUN_REGION || 'cn-hangzhou';
const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: '116.62.198.184' } });
const meta = server.metadata || {};
const instanceId = meta.providerResourceId;
const password = decryptCredential(server.credentialEncrypted);
const resolved = resolveServerSshUsername({ serverUsername: server.username, provider: server.provider });

const account = await prisma.providerAccount.findFirst({
  where: { provider: { type: 'ALIYUN' }, credentialEncrypted: { not: null } },
  include: { provider: true },
  orderBy: { updatedAt: 'desc' },
});
const secrets = JSON.parse(decryptCredential(account.credentialEncrypted));
const config = new OpenApi.Config({ accessKeyId: secrets.accessKey, accessKeySecret: secrets.secretKey });
config.endpoint = `ecs.${region}.aliyuncs.com`;
const client = new Ecs20140526.default(config);

async function tryApi(label, fn) {
  try {
    const body = await fn();
    return { label, ok: true, summary: body };
  } catch (error) {
    return {
      label,
      ok: false,
      code: error?.code || null,
      action: error?.accessDeniedDetail?.AuthAction || null,
      message: error instanceof Error ? error.message.slice(0, 180) : String(error).slice(0, 180),
    };
  }
}

const apiResults = [];
apiResults.push(
  await tryApi('DescribeInstances', async () => {
    const r = await client.describeInstancesWithOptions(
      new Ecs20140526.DescribeInstancesRequest({ regionId: region, instanceIds: JSON.stringify([instanceId]) }),
      new Util.RuntimeOptions({}),
    );
    const inst = r.body?.instances?.instance?.[0];
    return {
      id: inst?.instanceId,
      status: inst?.status,
      public: inst?.publicIpAddress?.ipAddress,
      eip: inst?.eipAddress?.ipAddress,
    };
  }),
);
apiResults.push(
  await tryApi('DescribeInstanceAttribute', async () => {
    const r = await client.describeInstanceAttributeWithOptions(
      new Ecs20140526.DescribeInstanceAttributeRequest({ instanceId }),
      new Util.RuntimeOptions({}),
    );
    return { status: r.body?.status, hostName: r.body?.hostName };
  }),
);
apiResults.push(
  await tryApi('DescribeCloudAssistantStatus', async () => {
    const r = await client.describeCloudAssistantStatusWithOptions(
      new Ecs20140526.DescribeCloudAssistantStatusRequest({ regionId: region, instanceId: [instanceId] }),
      new Util.RuntimeOptions({}),
    );
    const item = r.body?.instanceCloudAssistantStatusSet?.instanceCloudAssistantStatus?.[0];
    return { status: item?.cloudAssistantStatus, version: item?.cloudAssistantVersion };
  }),
);

async function tryUser(username) {
  return new Promise((resolvePromise) => {
    const c = new Client();
    const timer = setTimeout(() => {
      try {
        c.end();
      } catch {}
      resolvePromise({ username, ok: false, error: 'timeout' });
    }, 12000);
    c.on('ready', () => {
      clearTimeout(timer);
      c.end();
      resolvePromise({ username, ok: true });
    })
      .on('error', (error) => {
        clearTimeout(timer);
        resolvePromise({ username, ok: false, error: error.message });
      })
      .connect({ host: '116.62.198.184', port: 22, username, password, readyTimeout: 10000, tryKeyboard: true });
  });
}

const users = [...new Set([resolved, server.username, 'root', 'ecs-user', 'admin'])];
const userResults = [];
for (const u of users) userResults.push(await tryUser(u));

console.log(
  JSON.stringify(
    {
      instanceId,
      resolvedUsername: resolved,
      dbUsername: server.username,
      passwordLen: password.length,
      apiResults,
      userResults,
    },
    null,
    2,
  ),
);
await prisma.$disconnect();
