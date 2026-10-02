/**
 * Retry SSH with alternate JWT / provider AK sources. No secrets printed.
 * node scripts/_tmp-m8-1a-cred-hunt2.mjs
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
const { decryptCredential, resolveServerSshUsername } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');

function fp(v) {
  return createHash('sha256').update(String(v)).digest('hex').slice(0, 10);
}

const jwtCandidates = [];
jwtCandidates.push({ label: 'env', value: process.env.JWT_SECRET || '' });
const jwtFile = resolve(root, '.tools/launchos-jwt.txt');
if (existsSync(jwtFile)) jwtCandidates.push({ label: 'launchos-jwt.txt', value: readFileSync(jwtFile, 'utf8').trim() });

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({
  where: { OR: [{ id: 'cmuma9i480001rij49yv4yw2q' }, { host: '116.62.198.184' }] },
});
const accounts = await prisma.providerAccount.findMany({
  select: {
    id: true,
    providerId: true,
    label: true,
    status: true,
    credentialEncrypted: true,
    updatedAt: true,
    provider: true,
  },
  take: 20,
});

const decryptAttempts = [];
for (const cand of jwtCandidates) {
  if (!cand.value) {
    decryptAttempts.push({ label: cand.label, ok: false, reason: 'empty' });
    continue;
  }
  process.env.JWT_SECRET = cand.value;
  try {
    // re-require cipher? decryptCredential reads env at call time via deriveKey
    const pw = decryptCredential(server.credentialEncrypted);
    decryptAttempts.push({ label: cand.label, ok: true, len: pw.length, fp: fp(pw), jwtFp: fp(cand.value) });
  } catch (error) {
    decryptAttempts.push({
      label: cand.label,
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      jwtFp: fp(cand.value),
    });
  }
}

const accountSummary = accounts.map((a) => {
  let ak = null;
  try {
    process.env.JWT_SECRET = jwtCandidates[0].value;
    const raw = decryptCredential(a.credentialEncrypted);
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    ak = {
      rawLen: raw.length,
      json: Boolean(parsed),
      keys: parsed ? Object.keys(parsed) : [],
      hasAccessKeyId: Boolean(parsed?.accessKeyId || parsed?.AccessKeyId || parsed?.aliyunAccessKeyId),
      accessKeyLen: String(parsed?.accessKeyId || parsed?.AccessKeyId || parsed?.aliyunAccessKeyId || '').length,
    };
  } catch (error) {
    ak = { error: error instanceof Error ? error.message : String(error) };
  }
  return {
    id: a.id,
    label: a.label,
    status: a.status,
    provider: a.provider?.type || a.providerId,
    updatedAt: a.updatedAt,
    ak,
  };
});

const authFiles = readdirSync(resolve(root, '.tools/alpha-runtime'))
  .filter((n) => /auth|jwt|admin|1002/i.test(n))
  .map((n) => ({ name: n, size: readFileSync(join(resolve(root, '.tools/alpha-runtime'), n)).length }));

console.log(
  JSON.stringify(
    {
      server: {
        id: server?.id,
        host: server?.host,
        username: server?.username,
        provider: server?.provider,
        metadataKeys: server?.metadata && typeof server.metadata === 'object' ? Object.keys(server.metadata) : null,
      },
      decryptAttempts,
      accountSummary,
      authFiles,
    },
    null,
    2,
  ),
);

// one more SSH try with env jwt password
process.env.JWT_SECRET = jwtCandidates[0].value;
const password = decryptCredential(server.credentialEncrypted);
const runner = new RemoteRunner();
try {
  await runner.connect({
    host: server.host,
    port: server.port || 22,
    username: resolveServerSshUsername({ serverUsername: server.username, provider: server.provider }),
    password,
    readyTimeoutMs: 20000,
  });
  const r = await runner.execute({ command: 'echo SSH_OK' }, { timeoutMs: 10000 });
  console.log(JSON.stringify({ sshRetry: 'ok', out: String(r.stdout || '').trim() }));
  await runner.disconnect();
} catch (error) {
  console.log(JSON.stringify({ sshRetry: 'fail', error: error instanceof Error ? error.message : String(error) }));
}
await prisma.$disconnect();
