/**
 * Safe Alipay production query for one out_trade_no (no secrets printed).
 * node scripts/_tmp-m8-1a-alipay-query-one.mjs
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

const OUT = process.argv[2] || 'LOS-20261002-B30E293D';
const ARTIFACT = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT, { recursive: true });

const remoteJs = `const { PrismaClient } = require('@launchos/database');
const { decryptCredential } = require('@launchos/shared');
const { AlipayPaymentProvider } = require('@launchos/providers');
(async () => {
  const prisma = new PrismaClient();
  try {
    const account = await prisma.paymentProviderAccount.findUnique({
      where: { provider_environment: { provider: 'ALIPAY', environment: 'PRODUCTION' } },
    });
    if (!account) throw new Error('no production account');
    const privateKey = decryptCredential(account.credentialEncrypted);
    const provider = new AlipayPaymentProvider({
      appId: account.appId,
      gatewayUrl: account.gatewayUrl,
      privateKey,
      alipayPublicKey: account.publicKey,
      notifyUrl: account.notifyUrl,
      returnUrl: account.returnUrl,
    });
    const r = await provider.getCheckoutStatus(${JSON.stringify(OUT)});
    const safe = {
      ALIPAY_PROVIDER_ENVIRONMENT: String(account.gatewayUrl || '').includes('openapi.alipay.com') ? 'PRODUCTION' : 'OTHER',
      ALIPAY_TRADE_FOUND: r.state === 'SUCCEEDED' || r.state === 'PENDING' || r.state === 'FAILED' || r.state === 'CANCELED',
      ALIPAY_TRADE_STATUS: r.state,
      ALIPAY_TOTAL_AMOUNT: r.amountCents == null ? null : (r.amountCents / 100).toFixed(2),
      ALIPAY_PROVIDER_TRADE_NO_PRESENT: !!(r.providerTradeNo),
      OUT_TRADE_NO: ${JSON.stringify(OUT)},
      MERCHANT_ORDER_NO: r.merchantOrderNo || null,
    };
    process.stdout.write(JSON.stringify(safe));
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  process.stdout.write(JSON.stringify({ error: String(e && e.message || e) }));
  process.exit(1);
});
`;

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
await runner.writeTextFile('/opt/launchos/tmp/m81a-alipay-query-one.js', remoteJs);
const copied = await runner.execute(
  shellCommand(
    'podman cp /opt/launchos/tmp/m81a-alipay-query-one.js launchos-alpha-api:/app/apps/api/m81a-alipay-query-one.js',
  ),
  { timeoutMs: 20000 },
);
if (copied.exitCode !== 0) throw new Error('podman cp failed: ' + (copied.stderr || copied.stdout));
const ran = await runner.execute(
  shellCommand('podman exec -w /app/apps/api launchos-alpha-api node ./m81a-alipay-query-one.js'),
  { timeoutMs: 90000 },
);
await runner.disconnect();
const text = String(ran.stdout || '').trim();
writeFileSync(join(ARTIFACT, 'm8-1a-alipay-query-one.json'), text || String(ran.stderr || ''));
console.log(text || String(ran.stderr || ''));
if (ran.exitCode !== 0) process.exitCode = 1;
await prisma.$disconnect();
