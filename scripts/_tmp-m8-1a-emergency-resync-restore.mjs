/**
 * Emergency restore API from last known-good resync tar while notifyfix2 rebuilds.
 * Preserves ARM gates. No new orders.
 * node scripts/_tmp-m8-1a-emergency-resync-restore.mjs --confirm
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
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
if (!process.argv.includes('--confirm')) {
  console.error('pass --confirm');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');

const WS = 'cmunqotx500cbrl013xbhpio2';
const API_TAG = 'launchos-alpha-api:m81pay';
const API_REMOTE = `localhost/${API_TAG}`;
const ARTIFACT = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT, { recursive: true });

const names = readdirSync(ARTIFACT);
const hit = names.find((f) => f.includes('m81a-resync') && f.endsWith('.tar'));
if (!hit) throw new Error('resync tar not found');
const tarLocal = join(ARTIFACT, hit);
const tarRemote = '/opt/launchos/tmp/launchos-alpha-api-m81a-resync.tar';
console.log('using', hit, statSync(tarLocal).size);

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
async function remoteOk(cmd, label, timeoutMs = 60000) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs });
  if (r.exitCode !== 0) throw new Error(`${label}: ${(r.stderr || r.stdout || '').slice(0, 3000)}`);
  return r;
}
async function remote(cmd, timeoutMs = 60000) {
  return runner.execute(shellCommand(cmd), { timeoutMs });
}

await runner.writeTextFile(
  '/opt/launchos/tmp/m81a-preserve-arm-gates.sh',
  [
    '#!/bin/bash',
    'set -euo pipefail',
    'for f in /opt/launchos/config/alpha-api.env /opt/launchos/config/alpha-worker.env; do',
    '  [ -f "$f" ] || continue',
    '  if grep -q "^REAL_PAYMENTS_ENABLED=" "$f"; then sed -i "s/^REAL_PAYMENTS_ENABLED=.*/REAL_PAYMENTS_ENABLED=false/" "$f"; else echo "REAL_PAYMENTS_ENABLED=false" >> "$f"; fi',
    '  if grep -q "^ALIPAY_PRODUCTION_ENABLED=" "$f"; then sed -i "s/^ALIPAY_PRODUCTION_ENABLED=.*/ALIPAY_PRODUCTION_ENABLED=false/" "$f"; else echo "ALIPAY_PRODUCTION_ENABLED=false" >> "$f"; fi',
    '  if grep -q "^PAYMENT_TEST_REAL_ENABLED=" "$f"; then sed -i "s/^PAYMENT_TEST_REAL_ENABLED=.*/PAYMENT_TEST_REAL_ENABLED=true/" "$f"; else echo "PAYMENT_TEST_REAL_ENABLED=true" >> "$f"; fi',
    '  if grep -q "^ALIPAY_PRODUCTION_TEST_ENABLED=" "$f"; then sed -i "s/^ALIPAY_PRODUCTION_TEST_ENABLED=.*/ALIPAY_PRODUCTION_TEST_ENABLED=true/" "$f"; else echo "ALIPAY_PRODUCTION_TEST_ENABLED=true" >> "$f"; fi',
    '  if grep -q "^ALIPAY_SANDBOX_ONLY=" "$f"; then sed -i "s/^ALIPAY_SANDBOX_ONLY=.*/ALIPAY_SANDBOX_ONLY=false/" "$f"; else echo "ALIPAY_SANDBOX_ONLY=false" >> "$f"; fi',
    `  if grep -q "^ALIPAY_PRODUCTION_TEST_WORKSPACE_ID=" "$f"; then sed -i "s/^ALIPAY_PRODUCTION_TEST_WORKSPACE_ID=.*/ALIPAY_PRODUCTION_TEST_WORKSPACE_ID=${WS}/" "$f"; else echo "ALIPAY_PRODUCTION_TEST_WORKSPACE_ID=${WS}" >> "$f"; fi`,
    'done',
    '',
  ].join('\n'),
);
await remoteOk('chmod 700 /opt/launchos/tmp/m81a-preserve-arm-gates.sh && /opt/launchos/tmp/m81a-preserve-arm-gates.sh', 'gates', 20000);

const remoteHas = await remote(`test -f ${tarRemote} && echo HAS || echo NEED`);
if (String(remoteHas.stdout || '').includes('NEED')) {
  console.log('upload resync tar');
  await runner.upload(tarLocal, tarRemote, { timeoutMs: 900000 });
} else {
  console.log('remote resync tar present');
}

await remoteOk(
  `podman load -i ${tarRemote} && (podman tag docker.io/library/${API_TAG} ${API_REMOTE} 2>/dev/null || podman tag ${API_TAG} ${API_REMOTE} 2>/dev/null || true)`,
  'load',
  300000,
);
await remoteOk(`/opt/launchos/bin/m5-run-api.sh launchos-alpha-api 39110 ${API_REMOTE}`, 'restart', 180000);

let ready = false;
for (let i = 0; i < 40; i++) {
  const probe = await remote('curl -sf --max-time 3 http://127.0.0.1:39110/api/v1/health || echo HEALTH_FAIL', 15000);
  const out = String(probe.stdout || '');
  if (probe.exitCode === 0 && !out.includes('HEALTH_FAIL')) {
    ready = true;
    console.log('RESTORED_OK', out.slice(0, 200));
    break;
  }
  if (i % 5 === 0) console.log('waiting', i, out.slice(0, 80));
  await new Promise((r) => setTimeout(r, 3000));
}
if (!ready) {
  const logs = await remote('podman logs --tail 60 launchos-alpha-api 2>&1 || true', 20000);
  console.error(String(logs.stdout || '').slice(-2000));
  throw new Error('restore failed');
}
await runner.disconnect();
await prisma.$disconnect();
