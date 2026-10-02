/**
 * Restore SSH password via ECS Cloud Assistant RunCommand only.
 * node scripts/_tmp-m8-1a-runcommand-ssh.mjs --confirm-run
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
if (!process.argv.includes('--confirm-run')) {
  console.error('pass --confirm-run');
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
const meta = server.metadata && typeof server.metadata === 'object' ? server.metadata : {};
const instanceId = meta.providerResourceId;
if (!instanceId) throw new Error('providerResourceId missing');

const account = await prisma.providerAccount.findFirst({
  where: { provider: { type: 'ALIYUN' }, credentialEncrypted: { not: null } },
  include: { provider: true },
  orderBy: { updatedAt: 'desc' },
});
const secrets = JSON.parse(decryptCredential(account.credentialEncrypted));
const ak = secrets.accessKey;
const sk = secrets.secretKey;

const config = new OpenApi.Config({ accessKeyId: ak, accessKeySecret: sk });
config.endpoint = `ecs.${region}.aliyuncs.com`;
const client = new Ecs20140526.default(config);

const special = '!@#$%^&*_+-=';
const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const lower = 'abcdefghijkmnopqrstuvwxyz';
const digits = '23456789';
const all = upper + lower + digits + special;
const pick = (set) => set[randomBytes(1)[0] % set.length];
let newPassword = pick(upper) + pick(lower) + pick(digits) + pick(special);
while (newPassword.length < 22) newPassword += pick(all);

const escaped = newPassword.replace(/'/g, `'\\''`);
const script = `#!/bin/bash
set -euo pipefail
echo 'root:${escaped}' | chpasswd
if [ -f /etc/ssh/sshd_config ]; then
  sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config || true
  sed -i 's/^#\\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config || true
  systemctl reload sshd 2>/dev/null || systemctl reload ssh 2>/dev/null || service sshd reload 2>/dev/null || true
fi
echo RECOVER_OK
`;

console.log(JSON.stringify({ instanceId, akFp: createHash('sha256').update(ak).digest('hex').slice(0, 8) }));

let commandId;
try {
  const run = await client.runCommandWithOptions(
    new Ecs20140526.RunCommandRequest({
      regionId: region,
      type: 'RunShellScript',
      commandContent: script,
      timeout: 60,
      contentEncoding: 'PlainText',
      instanceId: [instanceId],
      name: 'm81a-ssh-recover',
    }),
    new Util.RuntimeOptions({}),
  );
  commandId = run.body?.commandId;
  console.log(JSON.stringify({ runCommandSubmitted: true, commandId }));
} catch (error) {
  console.log(
    JSON.stringify({
      runCommandSubmitted: false,
      error: error instanceof Error ? error.message : String(error),
      code: error?.code || null,
      action: error?.accessDeniedDetail?.AuthAction || null,
    }),
  );
  await prisma.$disconnect();
  process.exit(1);
}

let invokeOk = false;
let output = '';
for (let i = 0; i < 24; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const desc = await client.describeInvocationResultsWithOptions(
    new Ecs20140526.DescribeInvocationResultsRequest({
      regionId: region,
      commandId,
      instanceId,
    }),
    new Util.RuntimeOptions({}),
  );
  const items = desc.body?.invocationResults?.invocationResult || [];
  const item = items[0];
  if (!item) {
    console.log(JSON.stringify({ poll: i + 1, status: 'pending' }));
    continue;
  }
  output = item.output || '';
  console.log(JSON.stringify({ poll: i + 1, status: item.invocationStatus, exit: item.exitCode }));
  if (['Success', 'Failed', 'PartialFailed', 'Timeout', 'Cancelled'].includes(item.invocationStatus)) {
    invokeOk = item.invocationStatus === 'Success' && Number(item.exitCode || 0) === 0;
    break;
  }
}

if (!invokeOk) {
  console.log(JSON.stringify({ invokeOk: false, output: String(output).slice(0, 800) }));
  await prisma.$disconnect();
  process.exit(1);
}

await prisma.serverInstance.update({
  where: { id: server.id },
  data: {
    credentialEncrypted: encryptCredential(newPassword),
    metadata: {
      ...meta,
      passwordPresent: true,
      passwordLength: newPassword.length,
      passwordRotatedAt: new Date().toISOString(),
      passwordRotateReason: 'm8-1a-runcommand-ssh-recover',
    },
  },
});

const username = resolveServerSshUsername({ serverUsername: server.username, provider: server.provider });
const runner = new RemoteRunner();
let sshOk = false;
for (let i = 0; i < 5; i++) {
  try {
    await runner.connect({
      host: TARGET_HOST,
      port: server.port || 22,
      username,
      password: newPassword,
      readyTimeoutMs: 25000,
    });
    const r = await runner.execute({ command: 'echo SSH_OK && hostname' }, { timeoutMs: 15000 });
    console.log(JSON.stringify({ ssh: 'ok', attempt: i + 1, out: String(r.stdout || '').trim() }));
    await runner.disconnect();
    sshOk = true;
    break;
  } catch (error) {
    console.log(JSON.stringify({ ssh: 'retry', attempt: i + 1, error: error instanceof Error ? error.message : String(error) }));
    await new Promise((r) => setTimeout(r, 10000));
  }
}

await prisma.$disconnect();
if (!sshOk) process.exit(1);
console.log('SSH_RECOVERED=true');
