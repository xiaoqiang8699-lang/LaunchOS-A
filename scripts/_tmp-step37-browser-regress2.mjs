/**
 * Step 37 browser regress v2
 * node scripts/_tmp-step37-browser-regress2.mjs --confirm
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
cd /tmp
podman exec launchos-alpha-web sh -c 'find /app/apps/web/.next/server/app/projects -maxdepth 3 -type d' > /tmp/step37-dirs.txt
podman exec launchos-alpha-web sh -c 'grep -R "deployments" /app/apps/web/.next/server/app/projects --include="*.js" | head -20' > /tmp/step37-grep-dep.txt
podman exec launchos-alpha-web sh -c 'grep -R "versions" /app/apps/web/.next/server/app/projects --include="*.js" | head -20' > /tmp/step37-grep-ver.txt
podman exec launchos-alpha-web sh -c 'grep -R "上线记录\\|全部版本\\|返回应用" /app/apps/web/.next -n --include="*.js" | head -40' > /tmp/step37-grep-static.txt
podman exec launchos-alpha-web sh -c 'grep -R "/deployments\\|/versions" /app/apps/web/.next/static/chunks --include="*.js" | grep -E "projects/\\$\{|/projects/" | head -20' >> /tmp/step37-grep-static.txt
podman exec launchos-alpha-web sh -c 'grep -R "projects/.*/deployments\\|projects/.*/versions" /app/apps/web/.next/static/chunks --include="*.js" | head -20' >> /tmp/step37-grep-static.txt
echo LOCAL_HOME=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:39082/)
echo LOCAL_HIST=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:39082/projects/${PROJECT_ID}/deployments)
echo LOCAL_VERS=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:39082/projects/${PROJECT_ID}/versions)
echo LOCAL_PROJ=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:39082/projects/${PROJECT_ID})
echo ===DIRS===
grep -E 'deployments|versions' /tmp/step37-dirs.txt || true
echo ===STATIC===
wc -c /tmp/step37-grep-static.txt
head -c 4000 /tmp/step37-grep-static.txt
echo
`;
await runner.writeTextFile('/opt/launchos/tmp/step37-browser.sh', script);
const r = await runner.execute(shellCommand('chmod 700 /opt/launchos/tmp/step37-browser.sh && /opt/launchos/tmp/step37-browser.sh'), {
  timeoutMs: 120000,
});
console.log(r.stdout || '');
if (r.stderr) console.log('stderr', String(r.stderr).slice(0, 800));

const pc = {
  home: String(spawnSync('curl.exe', ['-sS', '--max-time', '20', '-o', 'NUL', '-w', '%{http_code}', 'https://alpha.zsaos.com/'], { encoding: 'utf8' }).stdout || '').trim(),
  hist: String(spawnSync('curl.exe', ['-sS', '--max-time', '20', '-o', 'NUL', '-w', '%{http_code}', `https://alpha.zsaos.com/projects/${PROJECT_ID}/deployments`], { encoding: 'utf8' }).stdout || '').trim(),
  vers: String(spawnSync('curl.exe', ['-sS', '--max-time', '20', '-o', 'NUL', '-w', '%{http_code}', `https://alpha.zsaos.com/projects/${PROJECT_ID}/versions`], { encoding: 'utf8' }).stdout || '').trim(),
  proj: String(spawnSync('curl.exe', ['-sS', '--max-time', '20', '-o', 'NUL', '-w', '%{http_code}', `https://alpha.zsaos.com/projects/${PROJECT_ID}`], { encoding: 'utf8' }).stdout || '').trim(),
  ceshi: String(spawnSync('curl.exe', ['-sS', '--max-time', '20', '-o', 'NUL', '-w', '%{http_code}', 'https://web-ceshi.zsaos.com/'], { encoding: 'utf8' }).stdout || '').trim(),
};

writeFileSync(join(ARTIFACT_DIR, 'step37-browser.json'), JSON.stringify({ remote: r.stdout, pc }, null, 2));
console.log(JSON.stringify({ pc }, null, 2));

await runner.disconnect();
await prisma.$disconnect();

const out = String(r.stdout || '');
const staticPart = out.split('===STATIC===')[1] || '';
const hasCopy =
  staticPart.includes('上线记录') ||
  staticPart.includes('全部版本') ||
  staticPart.includes('返回应用') ||
  staticPart.includes('/deployments') ||
  staticPart.includes('/versions');
const pass =
  Number(pc.home) === 200 &&
  Number(pc.hist) === 200 &&
  Number(pc.vers) === 200 &&
  Number(pc.proj) === 200 &&
  Number(pc.ceshi) === 200 &&
  out.includes('[id]/deployments') &&
  out.includes('[id]/versions') &&
  out.includes('LOCAL_HIST=200') &&
  out.includes('LOCAL_VERS=200') &&
  hasCopy;
console.log(pass ? 'STEP37_BROWSER=PASS' : 'STEP37_BROWSER=FAIL');
if (!pass) {
  console.log('DEBUG_STATIC', staticPart.slice(0, 1000));
}
process.exit(pass ? 0 : 1);
