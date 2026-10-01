/**
 * Step 37 browser-ish regression: route HTML + project page Link targets in bundle.
 * node scripts/_tmp-step37-browser-regress.mjs --confirm
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

function curlCode(url) {
  return String(
    spawnSync('curl.exe', ['-sS', '--max-time', '25', '-o', 'NUL', '-w', '%{http_code}', url], {
      encoding: 'utf8',
    }).stdout || '',
  ).trim();
}

function curlBody(url) {
  return String(
    spawnSync('curl.exe', ['-sS', '--max-time', '25', url], { encoding: 'utf8', maxBuffer: 5_000_000 })
      .stdout || '',
  );
}

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: '116.62.198.184' } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
});

const remote = await runner.execute(
  shellCommand(`podman exec launchos-alpha-web sh -c '
set +e
echo ===PAGE_JS===
grep -o "projects/[^\"]*/deployments" /app/apps/web/.next/server/app/projects/\\[id\\]/page.js | head -5
grep -o "projects/[^\"]*/versions" /app/apps/web/.next/server/app/projects/\\[id\\]/page.js | head -5
grep -o "查看上线记录\\|查看全部版本\\|返回应用\\|上线记录\\|全部版本" /app/apps/web/.next/server/app/projects/\\[id\\]/page.js /app/apps/web/.next/server/app/projects/\\[id\\]/deployments/page.js /app/apps/web/.next/server/app/projects/\\[id\\]/versions/page.js 2>/dev/null | sort | uniq
echo ===ROUTE_DIRS===
test -d /app/apps/web/.next/server/app/projects/\\[id\\]/deployments/page && echo deployments_page=YES
test -d /app/apps/web/.next/server/app/projects/\\[id\\]/versions/page && echo versions_page=YES
echo ===EXISTING===
curl -sS -o /dev/null -w "alpha_home=%{http_code}\\n" --max-time 10 http://127.0.0.1:39082/
curl -sS -o /dev/null -w "hist=%{http_code}\\n" --max-time 10 http://127.0.0.1:39082/projects/${PROJECT_ID}/deployments
curl -sS -o /dev/null -w "vers=%{http_code}\\n" --max-time 10 http://127.0.0.1:39082/projects/${PROJECT_ID}/versions
curl -sS -o /dev/null -w "proj=%{http_code}\\n" --max-time 10 http://127.0.0.1:39082/projects/${PROJECT_ID}
'`),
  { timeoutMs: 90000 },
);

const pc = {
  home: curlCode('https://alpha.zsaos.com/'),
  proj: curlCode(`https://alpha.zsaos.com/projects/${PROJECT_ID}`),
  hist: curlCode(`https://alpha.zsaos.com/projects/${PROJECT_ID}/deployments`),
  vers: curlCode(`https://alpha.zsaos.com/projects/${PROJECT_ID}/versions`),
  ceshi: curlCode('https://web-ceshi.zsaos.com/'),
};
const histHtml = curlBody(`https://alpha.zsaos.com/projects/${PROJECT_ID}/deployments`);
const versHtml = curlBody(`https://alpha.zsaos.com/projects/${PROJECT_ID}/versions`);

const report = {
  remote: String(remote.stdout || ''),
  pc,
  histHasAppShell: /__NEXT_DATA__|launchos|上线|版本|html/i.test(histHtml),
  versHasAppShell: /__NEXT_DATA__|launchos|上线|版本|html/i.test(versHtml),
  histSnippet: histHtml.slice(0, 200),
  versSnippet: versHtml.slice(0, 200),
};
writeFileSync(join(ARTIFACT_DIR, 'step37-browser.json'), JSON.stringify(report, null, 2));
console.log(report.remote);
console.log(JSON.stringify({ pc, histHasAppShell: report.histHasAppShell, versHasAppShell: report.versHasAppShell }, null, 2));

await runner.disconnect();
await prisma.$disconnect();

const out = String(remote.stdout || '');
const pass =
  Number(pc.home) === 200 &&
  Number(pc.proj) === 200 &&
  Number(pc.hist) === 200 &&
  Number(pc.vers) === 200 &&
  Number(pc.ceshi) === 200 &&
  out.includes('deployments_page=YES') &&
  out.includes('versions_page=YES') &&
  /projects\/.*\/deployments/.test(out) &&
  /projects\/.*\/versions/.test(out) &&
  /查看上线记录/.test(out) &&
  /查看全部版本/.test(out) &&
  /返回应用/.test(out);
console.log(pass ? 'STEP37_BROWSER=PASS' : 'STEP37_BROWSER=FAIL');
process.exit(pass ? 0 : 1);
