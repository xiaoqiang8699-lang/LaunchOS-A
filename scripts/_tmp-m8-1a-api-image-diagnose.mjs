/**
 * Inspect broken API image + try fallback images. Preserve ARM gates.
 * node scripts/_tmp-m8-1a-api-image-diagnose.mjs
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');

const ARTIFACT = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT, { recursive: true });
const WS = 'cmunqotx500cbrl013xbhpio2';

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
  return { exitCode: r.exitCode, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
}

const fullLogs = await remote('podman logs --tail 80 launchos-alpha-api 2>&1 || true', 30000);
console.log('===FULL_LOGS===');
console.log(fullLogs.stdout.slice(-5000));

const missing = await remote(
  `podman exec launchos-alpha-api sh -c 'node -e "console.log(require(\\"/app/apps/api/dist/main.js\\"))"' 2>&1 | head -n 40 || true`,
  30000,
);
console.log('===REQUIRE_MAIN===');
console.log(missing.stdout.slice(0, 3000));

const headMain = await remote(
  `podman exec launchos-alpha-api sh -c 'head -n 20 /app/apps/api/dist/main.js; echo ---; ls /app/node_modules/@nestjs/common 2>&1 | head; ls /app/apps/api/node_modules 2>&1 | head; ls /app/node_modules 2>&1 | head'`,
  30000,
);
console.log('===MAIN_HEAD===');
console.log(headMain.stdout.slice(0, 4000));

// Preserve gates helper
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
await remote('chmod 700 /opt/launchos/tmp/m81a-preserve-arm-gates.sh && /opt/launchos/tmp/m81a-preserve-arm-gates.sh', 20000);

// Try fallback images in order: resync (query fix), pending, original m81pay from older ID if available
const candidates = [
  'localhost/launchos-alpha-api:m81pay',
];

// List image IDs / history
const images = await remote(`podman images --digests --format '{{.ID}} {{.Repository}}:{{.Tag}} {{.CreatedAt}} {{.Size}}' | grep -E 'm81|alpha-api' | head -n 40`, 30000);
console.log('===IMAGES===');
console.log(images.stdout);

// Check if older tars exist locally we'll need to upload - for now try restarting with explicit image and check history
const history = await remote(`podman image history --no-trunc localhost/launchos-alpha-api:m81pay 2>&1 | head -n 15`, 30000);
console.log('===HISTORY===');
console.log(history.stdout.slice(0, 2000));

// Payments while API down (postgres still up)
const paymentsSql = `SELECT p.id || '|' || p.status || '|' || COALESCE(p.\"merchantOrderNo\",'') || '|' || CASE WHEN COALESCE(p.\"providerTradeNo\",'')<>'' THEN '1' ELSE '0' END || '|' || COALESCE(p.\"amountCents\"::text,'') || '|' || p.\"createdAt\"::text || '|' || COALESCE(p.\"paidAt\"::text,'') || '|' || COALESCE(p.\"lastQueryState\",'') || '|' || COALESCE(p.\"failureCode\",'') FROM \"Payment\" p JOIN \"CommercialOrder\" o ON o.id=p.\"orderId\" JOIN \"Plan\" pl ON pl.id=o.\"planId\" WHERE o.\"workspaceId\"='${WS}' AND (pl.code='PAYMENT_TEST' OR p.\"isProductionTest\"=true) ORDER BY p.\"createdAt\" DESC LIMIT 10`;
const payments = await remote(`podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc ${JSON.stringify(paymentsSql)}`, 20000);
console.log('===PAYMENTS===');
console.log(payments.stdout);

writeFileSync(
  join(ARTIFACT, 'm81a-api-image-diagnose.txt'),
  [fullLogs.stdout, missing.stdout, headMain.stdout, images.stdout, history.stdout, payments.stdout].join('\n----\n'),
);

await runner.disconnect();
await prisma.$disconnect();
