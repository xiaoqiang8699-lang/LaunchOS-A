/**
 * Step 37: fetch web-ceshi deployment/version rows via alpha-api container.
 * node scripts/_tmp-step37-data2.mjs --confirm
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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
if (!process.argv.includes('--confirm')) {
  console.error('pass --confirm');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');

const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: '116.62.198.184' } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
});

const remoteJs = `
import { createRequire } from 'node:module';
const require = createRequire('/app/apps/api/package.json');
const { PrismaClient } = require('@launchos/database');
const prisma = new PrismaClient();
const p = await prisma.project.findFirst({ where: { name: 'web-ceshi' }, orderBy: { createdAt: 'desc' } });
if (!p) { console.log('NO_PROJECT'); process.exit(2); }
console.log('PROJECT=' + p.id + '|' + p.name);
const deps = await prisma.deployment.findMany({
  where: { projectId: p.id },
  orderBy: { createdAt: 'desc' },
  take: 12,
  select: { id: true, version: true, status: true, sourceRevision: true, errorMessage: true, failureCode: true, createdAt: true },
});
const vers = await prisma.applicationVersion.findMany({
  where: { projectId: p.id },
  orderBy: { createdAt: 'desc' },
  take: 12,
  select: { id: true, version: true, status: true, commitSha: true, deploymentId: true, createdAt: true },
});
console.log('DEPS=' + JSON.stringify(deps));
console.log('VERS=' + JSON.stringify(vers));
await prisma.$disconnect();
`;

await runner.writeTextFile('/opt/launchos/tmp/step37-query.mjs', remoteJs);
const r = await runner.execute(
  shellCommand(
    'podman cp /opt/launchos/tmp/step37-query.mjs launchos-alpha-api:/tmp/step37-query.mjs && podman exec -w /app launchos-alpha-api node /tmp/step37-query.mjs',
  ),
  { timeoutMs: 90000 },
);
console.log(r.stdout || '');
if (r.exitCode !== 0) {
  console.error(String(r.stderr || '').slice(0, 2000));
  await runner.disconnect();
  await prisma.$disconnect();
  process.exit(1);
}

const projectId = (String(r.stdout || '').match(/PROJECT=([a-z0-9]+)/) || [])[1] || '';
const depsMatch = String(r.stdout || '').match(/DEPS=(\[[\s\S]*?\])\s*VERS=/);
const versMatch = String(r.stdout || '').match(/VERS=(\[[\s\S]*\])\s*$/);
let deps = [];
let vers = [];
try {
  deps = JSON.parse(depsMatch?.[1] || '[]');
  vers = JSON.parse(versMatch?.[1] || '[]');
} catch {
  deps = [];
  vers = [];
}

const pc = {
  hist: String(
    spawnSync(
      'curl.exe',
      ['-sS', '--max-time', '20', '-o', 'NUL', '-w', '%{http_code}', `https://alpha.zsaos.com/projects/${projectId}/deployments`],
      { encoding: 'utf8' },
    ).stdout || '',
  ),
  vers: String(
    spawnSync(
      'curl.exe',
      ['-sS', '--max-time', '20', '-o', 'NUL', '-w', '%{http_code}', `https://alpha.zsaos.com/projects/${projectId}/versions`],
      { encoding: 'utf8' },
    ).stdout || '',
  ),
  proj: String(
    spawnSync(
      'curl.exe',
      ['-sS', '--max-time', '20', '-o', 'NUL', '-w', '%{http_code}', `https://alpha.zsaos.com/projects/${projectId}`],
      { encoding: 'utf8' },
    ).stdout || '',
  ),
};

const linkCheck = await runner.execute(
  shellCommand(
    `podman exec launchos-alpha-web sh -c "grep -R '/projects/.*/deployments' /app/apps/web/.next/server/app/projects/[id]/page* 2>/dev/null | head -5; grep -R '查看上线记录\\\\|/versions' /app/apps/web/.next/server/app/projects/[id]/page.js 2>/dev/null | head -5"`,
  ),
  { timeoutMs: 60000 },
);

const report = { projectId, pc, deps, vers, linkCheck: String(linkCheck.stdout || '').slice(0, 2000) };
writeFileSync(join(ARTIFACT_DIR, 'step37-data.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ projectId, pc, depCount: deps.length, verCount: vers.length, sampleDeps: deps.slice(0, 4), sampleVers: vers.slice(0, 4) }, null, 2));

await runner.disconnect();
await prisma.$disconnect();

const hasSuccess = deps.some((d) => d.status === 'SUCCESS' && String(d.version || '').startsWith('v'));
const hasFailed = deps.some((d) => d.status === 'FAILED');
const hasCurrentVersion = vers.some((v) => v.status === 'ACTIVE');
const pass =
  Boolean(projectId) &&
  Number(pc.hist) === 200 &&
  Number(pc.vers) === 200 &&
  Number(pc.proj) === 200 &&
  hasSuccess &&
  hasFailed &&
  hasCurrentVersion &&
  deps.length > 0;
console.log(pass ? 'STEP37_DATA=PASS' : 'STEP37_DATA=FAIL');
process.exit(pass ? 0 : 1);
