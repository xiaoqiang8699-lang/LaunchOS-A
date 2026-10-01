/**
 * Step 37 verify after promote (web already loaded).
 * node scripts/_tmp-step37-verify.mjs --confirm
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

const PROJECT_ID = 'cmunsm2lk00ctrl01nnu1pwyd';
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

const script = `#!/bin/bash
set +e
echo LOCAL=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 http://127.0.0.1:39082/)
echo PUBLIC=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://alpha.zsaos.com/)
echo HIST=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://alpha.zsaos.com/projects/${PROJECT_ID}/deployments)
echo VERS=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://alpha.zsaos.com/projects/${PROJECT_ID}/versions)
echo PROJ=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://alpha.zsaos.com/projects/${PROJECT_ID})
podman inspect launchos-alpha-web --format '{{.Config.Image}} {{.State.Status}}'
ls /app/apps/web/.next/server/app/projects 2>/dev/null || podman exec launchos-alpha-web ls /app/apps/web/.next/server/app/projects 2>/dev/null | head
podman exec launchos-alpha-web sh -c 'find /app/apps/web/.next/server/app/projects -maxdepth 3 -type d 2>/dev/null | head -40'
`;

await runner.writeTextFile('/opt/launchos/tmp/step37-verify.sh', script);
const r = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/tmp/step37-verify.sh && /opt/launchos/tmp/step37-verify.sh'),
  { timeoutMs: 90000 },
);
console.log(r.stdout || '');
if (r.stderr) console.log('stderr', String(r.stderr).slice(0, 500));

const deps = await prisma.deployment.findMany({
  where: { projectId: PROJECT_ID },
  orderBy: { createdAt: 'desc' },
  take: 12,
  select: {
    id: true,
    version: true,
    status: true,
    sourceRevision: true,
    errorMessage: true,
    failureCode: true,
    createdAt: true,
  },
});
const versions = await prisma.applicationVersion.findMany({
  where: { projectId: PROJECT_ID },
  orderBy: { createdAt: 'desc' },
  take: 12,
  select: {
    id: true,
    version: true,
    status: true,
    commitSha: true,
    deploymentId: true,
    createdAt: true,
  },
});

const pcHist = spawnSync(
  'curl.exe',
  [
    '-sS',
    '--max-time',
    '25',
    '-o',
    'NUL',
    '-w',
    '%{http_code}',
    `https://alpha.zsaos.com/projects/${PROJECT_ID}/deployments`,
  ],
  { encoding: 'utf8' },
);
const pcVers = spawnSync(
  'curl.exe',
  [
    '-sS',
    '--max-time',
    '25',
    '-o',
    'NUL',
    '-w',
    '%{http_code}',
    `https://alpha.zsaos.com/projects/${PROJECT_ID}/versions`,
  ],
  { encoding: 'utf8' },
);

const report = {
  verify: String(r.stdout || ''),
  pcHist: String(pcHist.stdout || ''),
  pcVers: String(pcVers.stdout || ''),
  deployments: deps,
  versions,
};
writeFileSync(join(ARTIFACT_DIR, 'step37-regress.json'), JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    {
      pcHist: report.pcHist,
      pcVers: report.pcVers,
      depSample: deps.slice(0, 5),
      versionSample: versions.slice(0, 5),
    },
    null,
    2,
  ),
);

await runner.disconnect();
await prisma.$disconnect();

const localCode = Number((String(r.stdout || '').match(/LOCAL=(\d+)/) || [])[1] || 0);
const publicCode = Number((String(r.stdout || '').match(/PUBLIC=(\d+)/) || [])[1] || 0);
const histCode = Number((String(r.stdout || '').match(/HIST=(\d+)/) || [])[1] || 0);
const versCode = Number((String(r.stdout || '').match(/VERS=(\d+)/) || [])[1] || 0);
const hasRouteDirs = /deployments|versions/.test(String(r.stdout || ''));
const pass =
  localCode === 200 &&
  publicCode === 200 &&
  histCode === 200 &&
  versCode === 200 &&
  Number(report.pcHist) === 200 &&
  Number(report.pcVers) === 200 &&
  deps.some((d) => d.status === 'SUCCESS') &&
  versions.length > 0 &&
  hasRouteDirs;
console.log(pass ? 'STEP37_REGRESS=PASS' : 'STEP37_REGRESS=FAIL');
process.exit(pass ? 0 : 1);
