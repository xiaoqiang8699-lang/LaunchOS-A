import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const ARTIFACT = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT, { recursive: true });
const WEB_REMOTE = 'localhost/launchos-alpha-web:m82';
const TARGET_HOST = '116.62.198.184';

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { id: 'cmuma9i480001rij49yv4yw2q' } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername({ serverUsername: server.username, provider: server.provider }),
  password: decryptCredential(server.credentialEncrypted),
  readyTimeoutMs: 30000,
});
async function remote(cmd, timeoutMs = 60000) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs });
  console.log('>>>', cmd.slice(0, 160), '=>', r.exitCode);
  console.log(((r.stdout || '') + (r.stderr || '')).slice(-2000));
  return r;
}

// Discover port from active gateway routes
const routes = await remote('grep -n "alpha.zsaos\\|39082\\|39100" /opt/launchos/gateway/active/launchos-routes.conf | head -n 40');
const portMatch = String(routes.stdout || '').match(/127\.0\.0\.1:(\d+)/);
const WEB_PORT = portMatch ? portMatch[1] : '39082';
console.log('WEB_PORT', WEB_PORT);

await remote(`/opt/launchos/bin/m5-run-web.sh launchos-alpha-web ${WEB_REMOTE} ${WEB_PORT}`, 180000);
await new Promise((r) => setTimeout(r, 3000));
await remote(`curl -sS -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:${WEB_PORT}/billing`);
await remote('curl -sS -o /dev/null -w "%{http_code}" --max-time 5 -H "Host: alpha.zsaos.com" -k https://127.0.0.1/billing');

await runner.disconnect();
await prisma.$disconnect();

function curlStatus(path) {
  const r = spawnSync(
    'curl.exe',
    ['-sS', '-o', 'NUL', '-w', '%{http_code}', '--max-time', '30', '--resolve', `alpha.zsaos.com:443:${TARGET_HOST}`, `https://alpha.zsaos.com${path}`],
    { encoding: 'utf8' },
  );
  return String(r.stdout || '').trim();
}
const pages = {};
for (const p of [
  '/overview',
  '/billing',
  '/plan',
  '/admin/commercial',
  '/admin/commercial/subscriptions',
  '/admin/subscriptions',
  '/admin/commercial/payment-test',
]) {
  pages[p] = Number(curlStatus(p));
}
console.log(JSON.stringify({ WEB_PORT, pages }, null, 2));
const reportPath = join(ARTIFACT, 'm8-2-promote-report.json');
if (existsSync(reportPath)) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  report.pages = pages;
  report.webPort = WEB_PORT;
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
}
