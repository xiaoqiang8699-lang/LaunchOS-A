/**
 * M8-1A Production Readiness Audit — NO secrets printed, NO orders created, NO gates opened.
 * node scripts/_tmp-m8-1a-readiness-audit.mjs
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

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const {
  ALIPAY_PRODUCTION_GATEWAY,
  PAYMENT_TEST_MONTHLY_CENTS,
  PAYMENT_TEST_PLAN_CODE,
  readAlipayGates,
  isInternalTestPlan,
} = requireApi('@launchos/domain');

const TARGET_HOST = '116.62.198.184';
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });
const adminAuth = JSON.parse(readFileSync(join(ARTIFACT_DIR, 'admin-auth.json'), 'utf8'));
const userAuth = JSON.parse(readFileSync(join(ARTIFACT_DIR, '1002-auth.json'), 'utf8'));

function curl(url, host, opts = {}) {
  const { method = 'GET', headers = {}, body = null, maxTime = '30' } = opts;
  const args = ['-sS', '-L', '-X', method, '-w', '\n__STATUS__:%{http_code}', '--max-time', String(maxTime)];
  args.push('--resolve', `${host}:443:${TARGET_HOST}`);
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body != null) args.push('-H', 'content-type: application/json', '--data-binary', body);
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 4_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)/);
  return { status: m ? Number(m[1]) : 0, text: m ? out.slice(0, m.index) : out };
}
function parse(text) {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({
  where: { OR: [{ id: 'cmuma9i480001rij49yv4yw2q' }, { host: TARGET_HOST, scope: 'PLATFORM_MANAGED' }] },
});
if (!server) throw new Error('platform server missing');
const username = resolveServerSshUsername({ serverUsername: server.username, provider: server.provider });
const password = decryptCredential(server.credentialEncrypted);
const runner = new RemoteRunner();
await runner.connect({ host: server.host, port: server.port, username, password, readyTimeoutMs: 30000 });

const gateEnv = await runner.execute(
  shellCommand(
    `grep -E '^(REAL_PAYMENTS_ENABLED|PAYMENT_TEST_REAL_ENABLED|ALIPAY_PRODUCTION_ENABLED|ALIPAY_PRODUCTION_TEST_ENABLED|ALIPAY_SANDBOX_ONLY|ALIPAY_PRODUCTION_TEST_WORKSPACE_ID)=' /opt/launchos/config/alpha-api.env || true`,
  ),
  { timeoutMs: 15000 },
);

// Sanitized account rows only — never select private key material.
const alipayRows = await runner.execute(
  shellCommand(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT environment || '|' || status || '|' || CASE WHEN COALESCE(\\"appId\\",'')<>'' THEN '1' ELSE '0' END || '|' || CASE WHEN \\"credentialEncrypted\\" IS NULL OR \\"credentialEncrypted\\"='' THEN '0' ELSE '1' END || '|' || CASE WHEN \\"publicKey\\" IS NULL OR \\"publicKey\\"='' THEN '0' ELSE '1' END || '|' || CASE WHEN \\"gatewayUrl\\" = 'https://openapi.alipay.com/gateway.do' THEN '1' ELSE '0' END || '|' || CASE WHEN COALESCE(\\"notifyUrl\\",'') LIKE 'https://%' THEN '1' ELSE '0' END || '|' || CASE WHEN COALESCE(\\"returnUrl\\",'') LIKE 'https://%' THEN '1' ELSE '0' END || '|' || COALESCE(\\"notifyUrl\\",'') || '|' || COALESCE(\\"returnUrl\\",'') || '|' || COALESCE(\\"appReady\\"::text,'false') FROM \\"PaymentProviderAccount\\" WHERE provider='ALIPAY' ORDER BY environment"`,
  ),
  { timeoutMs: 20000 },
);

const planRow = await runner.execute(
  shellCommand(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT code || '|' || status || '|' || COALESCE(\\"priceMonthlyCents\\"::text,'') || '|' || COALESCE(\\"priceMonthly\\"::text,'') FROM \\"Plan\\" WHERE code='PAYMENT_TEST' LIMIT 1"`,
  ),
  { timeoutMs: 15000 },
);

const priceRows = await runner.execute(
  shellCommand(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT code || '|' || COALESCE(\\"priceMonthly\\"::text,'') || '|' || COALESCE(\\"priceYearly\\"::text,'') || '|' || COALESCE(\\"priceMonthlyCents\\"::text,'') FROM \\"Plan\\" WHERE code IN ('free','pro','team','PAYMENT_TEST') ORDER BY code"`,
  ),
  { timeoutMs: 15000 },
);

await runner.disconnect();
await prisma.$disconnect();

const adminLogin = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: adminAuth.email, password: adminAuth.password }),
});
const userLogin = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: userAuth.email || '1002@qq.com', password: userAuth.password }),
});
const adminToken = parse(adminLogin.text).accessToken;
const userToken = parse(userLogin.text).accessToken;
const adminHdr = { authorization: `Bearer ${adminToken}` };
const userHdr = { authorization: `Bearer ${userToken}` };

const health = curl('https://api-alpha.zsaos.com/api/v1/health', 'api-alpha.zsaos.com');
const billing = curl('https://api-alpha.zsaos.com/api/v1/account/billing', 'api-alpha.zsaos.com', { headers: userHdr });
const paymentTestAdmin = curl('https://api-alpha.zsaos.com/api/v1/admin/commercial/payment-test', 'api-alpha.zsaos.com', {
  headers: adminHdr,
});
const paymentTestUser = curl('https://api-alpha.zsaos.com/api/v1/admin/commercial/payment-test', 'api-alpha.zsaos.com', {
  headers: userHdr,
});
const alipayDetail = curl('https://api-alpha.zsaos.com/api/v1/admin/payment-providers/alipay', 'api-alpha.zsaos.com', {
  headers: adminHdr,
});
const notifyGet = curl('https://api-alpha.zsaos.com/api/v1/payments/webhooks/alipay', 'api-alpha.zsaos.com', {
  method: 'GET',
});
const notifyPost = curl('https://api-alpha.zsaos.com/api/v1/payments/webhooks/alipay', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: 'not=valid',
});
const returnPage = curl('https://alpha.zsaos.com/billing/payment/return', 'alpha.zsaos.com');
const paymentTestPage = curl('https://alpha.zsaos.com/admin/commercial/payment-test', 'alpha.zsaos.com');

const paymentTestPayload = parse(paymentTestAdmin.text);
const alipayDetailBody = parse(alipayDetail.text);

function parseAccountLine(line) {
  // env|status|app|key|pub|prodGateway|notifyHttps|returnHttps|notifyUrl|returnUrl|appReady
  const parts = String(line || '').split('|');
  if (parts.length < 11) return null;
  return {
    environment: parts[0],
    status: parts[1],
    appIdConfigured: parts[2] === '1',
    privateKeyConfigured: parts[3] === '1',
    publicKeyConfigured: parts[4] === '1',
    gatewayProduction: parts[5] === '1',
    notifyConfigured: parts[6] === '1',
    returnConfigured: parts[7] === '1',
    notifyUrl: parts[8] || '',
    returnUrl: parts[9] || '',
    appReady: parts[10] === 'true',
  };
}

const accounts = String(alipayRows.stdout || '')
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .map(parseAccountLine)
  .filter(Boolean);
const production = accounts.find((a) => a.environment === 'PRODUCTION') || null;
const sandbox = accounts.find((a) => a.environment === 'SANDBOX') || null;

const planParts = String(planRow.stdout || '').trim().split('|');
const planExists = planParts[0] === PAYMENT_TEST_PLAN_CODE;
const planStatus = planParts[1] || null;
const planCents = planParts[2] ? Number(planParts[2]) : null;

const gatesText = String(gateEnv.stdout || '');
const gatesFromEnv = {
  REAL_PAYMENTS_ENABLED: /REAL_PAYMENTS_ENABLED=true/.test(gatesText),
  PAYMENT_TEST_REAL_ENABLED: /PAYMENT_TEST_REAL_ENABLED=true/.test(gatesText),
  ALIPAY_PRODUCTION_TEST_ENABLED: /ALIPAY_PRODUCTION_TEST_ENABLED=true/.test(gatesText),
  ALIPAY_PRODUCTION_ENABLED: /ALIPAY_PRODUCTION_ENABLED=true/.test(gatesText),
  ALIPAY_SANDBOX_ONLY: !/ALIPAY_SANDBOX_ONLY=false/.test(gatesText),
  ALIPAY_PRODUCTION_TEST_WORKSPACE_ID: (/ALIPAY_PRODUCTION_TEST_WORKSPACE_ID=(.+)$/m.exec(gatesText)?.[1] || '').trim() !== '',
};

const expectedNotify = 'https://api-alpha.zsaos.com/api/v1/payments/webhooks/alipay';
const expectedReturn = 'https://alpha.zsaos.com/billing/payment/return';

const rsa2Ready =
  Boolean(production) &&
  production.appIdConfigured &&
  production.privateKeyConfigured &&
  production.publicKeyConfigured &&
  production.gatewayProduction &&
  (production.status === 'VERIFIED' || production.status === 'CONFIGURED');

const missing = [];
if (!production) missing.push('PaymentProviderAccount(environment=PRODUCTION)');
else {
  if (!production.appIdConfigured) missing.push('ALIPAY_APP_ID (PaymentProviderAccount.appId for PRODUCTION)');
  if (!production.privateKeyConfigured) missing.push('ALIPAY_PRIVATE_KEY (PaymentProviderAccount encrypted credential for PRODUCTION)');
  if (!production.publicKeyConfigured) missing.push('ALIPAY_PUBLIC_KEY (PaymentProviderAccount.publicKey for PRODUCTION)');
  if (!production.gatewayProduction) missing.push('ALIPAY_GATEWAY (= https://openapi.alipay.com/gateway.do)');
  if (!production.notifyConfigured) missing.push('ALIPAY_NOTIFY_URL (https public notify)');
  if (!production.returnConfigured) missing.push('ALIPAY_RETURN_URL (https public return)');
  if (production.notifyUrl && production.notifyUrl !== expectedNotify) {
    missing.push(`ALIPAY_NOTIFY_URL must equal ${expectedNotify}`);
  }
  if (production.returnUrl && production.returnUrl !== expectedReturn) {
    missing.push(`ALIPAY_RETURN_URL should equal ${expectedReturn}`);
  }
}
if (!gatesFromEnv.ALIPAY_PRODUCTION_TEST_WORKSPACE_ID) {
  missing.push('ALIPAY_PRODUCTION_TEST_WORKSPACE_ID (in /opt/launchos/config/alpha-api.env)');
}

const report = {
  stage: 'M8-1A Production Readiness Audit',
  ALIPAY_APP_ID_CONFIGURED: Boolean(production?.appIdConfigured),
  ALIPAY_PRIVATE_KEY_CONFIGURED: Boolean(production?.privateKeyConfigured),
  ALIPAY_PUBLIC_KEY_CONFIGURED: Boolean(production?.publicKeyConfigured),
  ALIPAY_GATEWAY_PRODUCTION: Boolean(production?.gatewayProduction),
  ALIPAY_NOTIFY_URL_CONFIGURED: Boolean(production?.notifyConfigured),
  ALIPAY_RETURN_URL_CONFIGURED: Boolean(production?.returnConfigured),
  ALIPAY_NOTIFY_URL_REACHABLE: notifyPost.status > 0 && notifyPost.status < 500,
  ALIPAY_RETURN_URL_REACHABLE: returnPage.status === 200 || returnPage.status === 307 || returnPage.status === 308,
  ALIPAY_RSA2_READY: rsa2Ready,
  ALIPAY_PROVIDER_ENVIRONMENT: production ? 'PRODUCTION' : sandbox ? 'SANDBOX_ONLY' : 'NONE',
  ALIPAY_PRODUCTION_STATUS: production?.status ?? null,
  ALIPAY_NOTIFY_URL_EXPECTED: expectedNotify,
  ALIPAY_RETURN_URL_EXPECTED: expectedReturn,
  ALIPAY_NOTIFY_URL_ACTUAL_SET: Boolean(production?.notifyUrl),
  ALIPAY_RETURN_URL_ACTUAL_SET: Boolean(production?.returnUrl),
  ALIPAY_NOTIFY_URL_MATCHES_EXPECTED: production?.notifyUrl === expectedNotify,
  ALIPAY_RETURN_URL_MATCHES_EXPECTED: production?.returnUrl === expectedReturn,
  notifyGetStatus: notifyGet.status,
  notifyPostStatus: notifyPost.status,
  PAYMENT_TEST_PLAN_EXISTS: planExists,
  PAYMENT_TEST_PLAN_STATUS: planStatus,
  PAYMENT_TEST_AMOUNT_FEN: planCents ?? PAYMENT_TEST_MONTHLY_CENTS,
  PAYMENT_TEST_AMOUNT_OK: planCents === 90,
  PAYMENT_TEST_HIDDEN: isInternalTestPlan(PAYMENT_TEST_PLAN_CODE),
  PAYMENT_TEST_INTERNAL_ONLY: planStatus === 'INTERNAL_TEST',
  REAL_PAYMENTS_ENABLED: gatesFromEnv.REAL_PAYMENTS_ENABLED,
  PAYMENT_TEST_REAL_ENABLED: gatesFromEnv.PAYMENT_TEST_REAL_ENABLED || gatesFromEnv.ALIPAY_PRODUCTION_TEST_ENABLED,
  ALIPAY_SANDBOX_ONLY: gatesFromEnv.ALIPAY_SANDBOX_ONLY,
  ALIPAY_PRODUCTION_TEST_WORKSPACE_ID_CONFIGURED: gatesFromEnv.ALIPAY_PRODUCTION_TEST_WORKSPACE_ID,
  health: health.status,
  billing: billing.status,
  paymentTestAdmin: paymentTestAdmin.status,
  paymentTestUser: paymentTestUser.status,
  paymentTestButtonEnabled: paymentTestPayload.buttonEnabled === true,
  paymentTestPage: paymentTestPage.status,
  alipayAdminDetail: alipayDetail.status,
  productionReadinessFromApi: alipayDetailBody.readiness
    ? { ready: alipayDetailBody.readiness.ready, blockerCount: (alipayDetailBody.readiness.blockers || []).length }
    : null,
  formalPrices: String(priceRows.stdout || '')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean),
  missingConfigNames: missing,
  PRODUCTION_ALIPAY_CONFIGURATION_REQUIRED: missing.length > 0 || !rsa2Ready,
  PRODUCTION_PAYMENT_TEST_ARMED: false,
  REAL_PAYMENT_ORDER_CREATED: false,
  REAL_PAYMENT_CHARGE_EXECUTED: false,
  GATE_OPENED: false,
  STOP_REASON:
    missing.length > 0 || !rsa2Ready
      ? 'PRODUCTION Alipay credentials / account incomplete — do not create orders or open PAYMENT_TEST_REAL_ENABLED'
      : null,
};

writeFileSync(join(ARTIFACT_DIR, 'm8-1a-readiness-audit.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

if (report.PRODUCTION_ALIPAY_CONFIGURATION_REQUIRED) {
  console.log('PRODUCTION_ALIPAY_CONFIGURATION_REQUIRED=true');
  console.log('MISSING_CONFIG_NAMES=');
  for (const name of missing) console.log(`- ${name}`);
  console.log('DO_NOT_PASTE_SECRETS_IN_CHAT=true');
  console.log('PRODUCTION_PAYMENT_TEST_ARMED=false');
  console.log('REAL_PAYMENT_ORDER_CREATED=false');
  process.exit(0);
}

console.log('PRODUCTION_ALIPAY_CONFIGURATION_REQUIRED=false');
console.log('NEXT=arm PAYMENT_TEST_REAL_ENABLED only after explicit confirm (not done in this audit)');
