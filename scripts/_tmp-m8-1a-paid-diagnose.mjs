/**
 * Diagnose Alipay query/notify for pending PAYMENT_TEST (no secrets, no new order).
 * node scripts/_tmp-m8-1a-paid-diagnose.mjs
 */
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
const {
  signAlipayParams,
  extractSignedObject,
  verifyAlipayContent,
  canonicalAlipayPayload,
} = requireApi('@launchos/providers');
// extractSignedObject may not be exported — fallback via gateway if needed
const providers = requireApi('@launchos/providers');

const ARTIFACT = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT, { recursive: true });
const TARGET_HOST = '116.62.198.184';

function curl(url, host, opts = {}) {
  const { method = 'GET', headers = {}, body = null, maxTime = '60' } = opts;
  const args = ['-sS', '-L', '-X', method, '-w', '\n__STATUS__:%{http_code}', '--max-time', String(maxTime)];
  args.push('--resolve', `${host}:443:${TARGET_HOST}`);
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body != null) args.push('-H', 'content-type: application/json', '--data-binary', body);
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 8_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)/);
  return { status: m ? Number(m[1]) : 0, text: m ? out.slice(0, m.index) : out };
}

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

async function remote(cmd, timeoutMs = 30000) {
  return runner.execute(shellCommand(cmd), { timeoutMs });
}

const outTradeNos = ['LOS-20261002-B30E293D', 'LOS-20261002-B7AAC7B6'];

// Pull encrypted config + run query inside API container using node one-liner that prints SAFE fields only
const diagScript = `
const { createHash } = require('crypto');
const fs = require('fs');
async function main() {
  const { PrismaClient } = require('@launchos/database');
  const { decryptCredential } = require('@launchos/shared');
  const { AlipayPaymentProvider } = require('@launchos/providers');
  const prisma = new PrismaClient();
  const account = await prisma.paymentProviderAccount.findUnique({
    where: { provider_environment: { provider: 'ALIPAY', environment: 'PRODUCTION' } },
  });
  if (!account) throw new Error('no account');
  const privateKey = decryptCredential(account.credentialEncrypted);
  const provider = new AlipayPaymentProvider({
    appId: account.appId,
    gatewayUrl: account.gatewayUrl,
    privateKey,
    alipayPublicKey: account.publicKey,
    notifyUrl: account.notifyUrl,
    returnUrl: account.returnUrl,
  });
  const nos = ${JSON.stringify(outTradeNos)};
  const results = [];
  for (const no of nos) {
    const r = await provider.getCheckoutStatus(no);
    results.push({
      outTradeNo: no,
      state: r.state,
      amountCents: r.amountCents ?? null,
      providerTradeNoPresent: Boolean(r.providerTradeNo),
      subCode: r.subCode ?? null,
      keys: Object.keys(r || {}),
    });
  }
  // raw fetch one query for safe fields
  const fetch = globalThis.fetch;
  const { createSign } = require('crypto');
  function wrapPem(kind, value) {
    const trimmed = value.trim();
    if (trimmed.includes('BEGIN')) return trimmed;
    const body = trimmed.replace(/\\s+/g, '');
    const lines = body.match(/.{1,64}/g)?.join('\\n') ?? body;
    return '-----BEGIN ' + kind + '-----\\n' + lines + '\\n-----END ' + kind + '-----';
  }
  function signContent(content, key) {
    const candidates = key.includes('BEGIN') ? [key.trim()] : [
      wrapPem('PRIVATE KEY', key),
      wrapPem('RSA PRIVATE KEY', key),
    ];
    let last;
    for (const c of candidates) {
      try {
        const s = createSign('RSA-SHA256');
        s.update(content, 'utf8');
        return s.sign(c, 'base64');
      } catch (e) { last = e; }
    }
    throw last;
  }
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false }).formatToParts(now);
  const g = (t) => parts.find(p => p.type === t)?.value ?? '00';
  const ts = g('year')+'-'+g('month')+'-'+g('day')+' '+g('hour')+':'+g('minute')+':'+g('second');
  const params = {
    app_id: account.appId,
    method: 'alipay.trade.query',
    format: 'json',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: ts,
    version: '1.0',
    biz_content: JSON.stringify({ out_trade_no: nos[0] }),
  };
  const content = Object.keys(params).filter(k => params[k] !== '').sort().map(k => k+'='+params[k]).join('&');
  params.sign = signContent(content, privateKey);
  const body = new URLSearchParams(params).toString();
  const resp = await fetch(account.gatewayUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const text = await resp.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  const qr = parsed?.alipay_trade_query_response || null;
  console.log(JSON.stringify({
    notifyUrl: account.notifyUrl,
    returnUrl: account.returnUrl,
    gatewayUrl: account.gatewayUrl,
    appIdConfigured: Boolean(account.appId),
    publicKeyConfigured: Boolean(account.publicKey),
    results,
    rawHttpStatus: resp.status,
    rawHasSign: Boolean(parsed?.sign),
    rawCode: qr?.code ?? null,
    rawSubCode: qr?.sub_code ?? null,
    rawSubMsg: qr?.sub_msg ?? null,
    rawTradeStatus: qr?.trade_status ?? null,
    rawTotalAmount: qr?.total_amount ?? null,
    rawOutTradeNo: qr?.out_trade_no ?? null,
    rawTradeNoPresent: Boolean(qr?.trade_no),
    rawBodyLen: text.length,
    rawBodyHead: text.slice(0, 240),
  }, null, 2));
  await prisma.$disconnect();
}
main().catch((e) => { console.error(JSON.stringify({ error: String(e.message || e) })); process.exit(1); });
`;

await runner.writeTextFile('/opt/launchos/tmp/m81a-paid-diag.js', diagScript);
const run = await remote(
  `podman cp /opt/launchos/tmp/m81a-paid-diag.js launchos-alpha-api:/tmp/m81a-paid-diag.js && podman exec -w /app launchos-alpha-api node /tmp/m81a-paid-diag.js`,
  60000,
);

const logs = await remote(
  `podman logs --since 4h launchos-alpha-api 2>&1 | grep -E 'alipay|webhook|notify|LOS-20261002-B30E293D|LOS-20261002-B7AAC7B6|invalid-signature|trade.query|PAYMENT' | tail -n 80`,
  30000,
);

const notifyProbe = curl('https://api-alpha.zsaos.com/api/v1/payments/webhooks/alipay', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: 'out_trade_no=probe&sign=x',
});

const account = await remote(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT COALESCE(\\"notifyUrl\\",'') || '|' || COALESCE(\\"returnUrl\\",'') || '|' || COALESCE(\\"gatewayUrl\\",'') || '|' || COALESCE(\\"appId\\",'') || '|' || status FROM \\"PaymentProviderAccount\\" WHERE provider='ALIPAY' AND environment='PRODUCTION'"`,
  15000,
);

const events = await remote(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT \\"eventType\\" || '|' || COUNT(*)::text FROM \\"SubscriptionEvent\\" WHERE \\"workspaceId\\"='cmunqotx500cbrl013xbhpio2' GROUP BY \\"eventType\\" ORDER BY \\"eventType\\""`,
  15000,
);

await runner.disconnect();
await prisma.$disconnect();

const report = {
  diagExit: run.exitCode,
  diagStdout: String(run.stdout || '').trim(),
  diagStderr: String(run.stderr || '').trim().slice(0, 2000),
  logs: String(logs.stdout || '').trim().split(/\r?\n/).filter(Boolean).slice(-80),
  notifyProbeStatus: notifyProbe.status,
  notifyProbeBody: notifyProbe.text.slice(0, 200),
  account: String(account.stdout || '').trim(),
  subscriptionEvents: String(events.stdout || '').trim().split(/\r?\n/).filter(Boolean),
};

writeFileSync(join(ARTIFACT, 'm8-1a-paid-diagnose.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
