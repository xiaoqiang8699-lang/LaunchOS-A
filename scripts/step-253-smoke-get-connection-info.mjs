/**
 * Smoke-test getConnectionInfo against bound RDS (read-only aside from Describe).
 * Does not CreateDBInstance.
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
const info = await provider.getConnectionInfo('pgm-bp14j1lljy571v8h', true);
console.log(
  JSON.stringify(
    {
      hostMasked: info.host ? `${String(info.host).slice(0, 22)}***` : null,
      port: info.port,
      networkType: info.networkType,
      looksPrivate: !/public/i.test(String(info.host || '')),
    },
    null,
    2,
  ),
);
await prisma.$disconnect();
