/**
 * Find usable Aliyun/SSH credentials without printing secrets.
 * node scripts/_tmp-m8-1a-cred-hunt.mjs
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
const { decryptCredential } = requireApi('@launchos/shared');

function fp(v) {
  return createHash('sha256').update(String(v)).digest('hex').slice(0, 10);
}

const prisma = new PrismaClient();

const servers = await prisma.serverInstance.findMany({
  select: {
    id: true,
    host: true,
    username: true,
    provider: true,
    providerInstanceId: true,
    status: true,
    credentialEncrypted: true,
    updatedAt: true,
  },
  take: 20,
});

const accounts = await prisma.cloudProviderAccount?.findMany?.({ take: 20 }).catch(() => null);
let providerAccounts = [];
try {
  providerAccounts = await prisma.providerAccount.findMany({
    select: {
      id: true,
      provider: true,
      displayName: true,
      status: true,
      credentialEncrypted: true,
      updatedAt: true,
    },
    take: 30,
  });
} catch {
  try {
    providerAccounts = await prisma.cloudAccount.findMany({ take: 30 });
  } catch {
    providerAccounts = [];
  }
}

const serverSummary = servers.map((s) => {
  let decOk = false;
  let len = 0;
  try {
    const p = decryptCredential(s.credentialEncrypted);
    decOk = true;
    len = p.length;
  } catch (e) {
    decOk = false;
  }
  return {
    id: s.id,
    host: s.host,
    username: s.username,
    provider: s.provider,
    providerInstanceId: s.providerInstanceId,
    status: s.status,
    updatedAt: s.updatedAt,
    decOk,
    len,
  };
});

const authFiles = [];
const runtime = resolve(root, '.tools/alpha-runtime');
for (const name of readdirSync(runtime)) {
  if (!/auth|jwt|secret|password|cred/i.test(name)) continue;
  const full = join(runtime, name);
  const text = readFileSync(full, 'utf8');
  authFiles.push({
    name,
    size: text.length,
    looksJson: text.trim().startsWith('{'),
    hasPasswordKey: /password/i.test(text),
    hasToken: /accessToken|token/i.test(text),
    fp: fp(text),
  });
}

// jwt file
const jwtPath = resolve(root, '.tools/launchos-jwt.txt');
let jwtInfo = null;
if (existsSync(jwtPath)) {
  const jwt = readFileSync(jwtPath, 'utf8').trim();
  jwtInfo = { len: jwt.length, fp: fp(jwt), sameAsEnv: jwt === process.env.JWT_SECRET };
}

console.log(
  JSON.stringify(
    {
      serverSummary,
      providerAccountCount: providerAccounts.length,
      providerAccounts: providerAccounts.map((a) => ({
        id: a.id,
        provider: a.provider,
        displayName: a.displayName,
        status: a.status,
        hasCred: Boolean(a.credentialEncrypted),
        updatedAt: a.updatedAt,
      })),
      authFiles,
      jwtInfo,
      models: Object.keys(prisma).filter((k) => !k.startsWith('$') && !k.startsWith('_')).slice(0, 80),
    },
    null,
    2,
  ),
);
await prisma.$disconnect();
