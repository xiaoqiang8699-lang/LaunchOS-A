/**
 * Quick PING probe with fixed script style. No Create. No secret logs.
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
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (process.env[k] === undefined) process.env[k] = v;
}

const CR = 'cmu4xn1j60001riaw6gjh0rfn';
const HOST = 'rc9abe63464.redis.rds.aliyuncs.com';
const PORT = 6379;
const { PrismaClient } = require(resolve(root, 'packages/database/generated/client'));
const { decryptCredential } = require(resolve(root, 'packages/shared/dist/index.js'));
const { AlibabaCloudRedisProvider } = require(resolve(root, 'packages/providers/dist/index.js'));
const { RemoteRunner } = require(resolve(root, 'packages/remote-runner/dist/index.js'));

function q(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

const prisma = new PrismaClient();
try {
  const cr = await prisma.cloudResource.findUnique({ where: { id: CR } });
  const m = cr.metadata || {};
  const server = await prisma.serverInstance.findUnique({
    where: { id: m.serverInstanceId || 'cmu22cqo80007ri6wkt4krfsq' },
  });
  const account = await prisma.providerAccount.findFirst({
    where: { status: 'ACTIVE', provider: { type: 'ALIYUN' }, workspaceId: cr.workspaceId },
    orderBy: { createdAt: 'asc' },
  });
  const secrets = JSON.parse(decryptCredential(account.credentialEncrypted));
  const provider = new AlibabaCloudRedisProvider({
    accessKey: secrets.accessKey,
    secretKey: secrets.secretKey,
    region: cr.region || 'cn-hangzhou',
  });
  await provider.setWhitelist({
    instanceId: 'r-bp1e95c9abe63464',
    securityIpList: server.host,
  });

  const password = decryptCredential(m.passwordEncrypted);
  const runner = new RemoteRunner();
  const stamp = Date.now();
  const passPath = `/tmp/launchos-redis-pass-${stamp}`;
  const scriptPath = `/tmp/launchos-redis-ping-${stamp}.sh`;
  await runner.connect({
    host: server.host,
    port: server.port,
    username: server.username,
    password: decryptCredential(server.credentialEncrypted),
  });
  await runner.writeTextFile(passPath, password.replace(/[\r\n]/g, ''), 0o600);
  const script = [
    '#!/bin/sh',
    'set -e',
    `HOST=${q(HOST)}`,
    `PORT=${q(String(PORT))}`,
    `PASSFILE=${q(passPath)}`,
    'docker run --rm --network host \\',
    '  -v "$PASSFILE:/run/redis-pass:ro,Z" \\',
    '  redis:7-alpine \\',
    '  sh -c \'redis-cli -h "$1" -p "$2" -a "$(cat /run/redis-pass)" --no-auth-warning PING\' _ "$HOST" "$PORT"',
    '',
  ].join('\n');
  await runner.writeTextFile(scriptPath, script, 0o700);
  const result = await runner.execute(`sh ${scriptPath}`, { timeoutMs: 90_000 });
  await runner.execute(`rm -f ${passPath} ${scriptPath}`, { timeoutMs: 5_000 });
  await runner.disconnect();
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  console.log(
    JSON.stringify(
      {
        exitCode: result.exitCode,
        hasPong: /\bPONG\b/i.test(output),
        stdout: String(result.stdout || '').slice(0, 200),
        stderr: String(result.stderr || '').slice(0, 400),
      },
      null,
      2,
    ),
  );
} finally {
  await prisma.$disconnect();
}
