/**
 * Step 31.4 — pull Alpha API logs for private-repo ANALYZE 500 (no secrets).
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const file of [resolve(root, '.env')]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');

function redact(t) {
  return String(t || '')
    .replace(/BEGIN [^\n]+PRIVATE KEY[\s\S]*?END [^\n]+PRIVATE KEY/g, '[PEM_REDACTED]')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|authorization)[=:][^\s"']+/gi, '$1=***')
    .replace(/x-access-token:[^\s@]+/gi, 'x-access-token:***')
    .replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//***:***@');
}

const DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(DIR, { recursive: true });

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: '116.62.198.184' } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
});

await runner.writeTextFile(
  '/opt/launchos/bin/step314-logs.sh',
  `#!/bin/bash
set -u
CTR=launchos-alpha-api
echo '===RECENT_ERRORS==='
podman logs --since 6h "$CTR" 2>&1 | sed -E 's/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer|authorization)[=:][^ ]+/\\1=***/gi; s/gh[pousr]_[A-Za-z0-9_]{20,}/***/g; s#x-access-token:[^[:space:]@]+#x-access-token:***#gi' | grep -Ei 'ERROR|Exception|analyze|GitError|GitHub|multi-demo|launchos-multi|Internal server|stack|fail|clone|installation' | tail -n 200
echo '===TAIL_RAW==='
podman logs --tail 300 "$CTR" 2>&1 | sed -E 's/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer|authorization)[=:][^ ]+/\\1=***/gi; s/gh[pousr]_[A-Za-z0-9_]{20,}/***/g; s#x-access-token:[^[:space:]@]+#x-access-token:***#gi' | tail -n 250
`,
);
const logs = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/bin/step314-logs.sh && /opt/launchos/bin/step314-logs.sh'),
  { timeoutMs: 120000 },
);
const out = redact(`${logs.stdout || ''}\n${logs.stderr || ''}`);
writeFileSync(join(DIR, 'step314-api-logs.txt'), out);
console.log(out.slice(0, 12000));

// DB: find recent project for launchos-multi-demo
const projects = await prisma.project.findMany({
  where: {
    OR: [
      { name: { contains: 'launchos-multi-demo', mode: 'insensitive' } },
      { sources: { some: { url: { contains: 'launchos-multi-demo' } } } },
    ],
  },
  orderBy: { updatedAt: 'desc' },
  take: 5,
  include: {
    sources: { orderBy: { updatedAt: 'desc' }, take: 3 },
    workspace: { select: { id: true, name: true } },
  },
});
const safeProjects = projects.map((p) => ({
  id: p.id,
  name: p.name,
  workspaceId: p.workspaceId,
  updatedAt: p.updatedAt,
  sources: (p.sources || []).map((s) => ({
    id: s.id,
    type: s.type,
    url: s.url,
    branch: s.branch,
    status: s.status,
    updatedAt: s.updatedAt,
    metaKeys: s.metadata && typeof s.metadata === 'object' ? Object.keys(s.metadata) : [],
  })),
}));
writeFileSync(join(DIR, 'step314-projects.json'), JSON.stringify(safeProjects, null, 2));
console.log('PROJECTS', JSON.stringify(safeProjects, null, 2));

await runner.disconnect();
await prisma.$disconnect();
