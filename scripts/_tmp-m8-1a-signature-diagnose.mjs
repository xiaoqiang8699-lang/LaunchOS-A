/**
 * Inspect failed PAYMENT_TEST order + private-key self-sign (no secrets printed).
 * Does NOT create Alipay checkout.
 * node scripts/_tmp-m8-1a-signature-diagnose.mjs
 */
import { createRequire } from 'node:module';
import { createHash, createPublicKey, createPrivateKey } from 'node:crypto';
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
const { signAlipayContent, verifyAlipayContent, canonicalAlipayPayload, selfSignVerify, materialFingerprint } = requireApi('@launchos/providers');

const ARTIFACT = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT, { recursive: true });

function fingerprint(material) {
  return createHash('sha256').update(material.replace(/\s+/g, '')).digest('hex').slice(0, 16);
}

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({
  where: { id: 'cmuma9i480001rij49yv4yw2q' },
});
if (!server) throw new Error('platform managed server missing');
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername({ serverUsername: server.username, provider: server.provider }),
  password: decryptCredential(server.credentialEncrypted),
  readyTimeoutMs: 30000,
});

const orders = await runner.execute(
  shellCommand(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT p.id || '|' || p.status || '|' || COALESCE(p.\\"merchantOrderNo\\",'') || '|' || COALESCE(p.\\"amountCents\\"::text,'') || '|' || COALESCE(p.environment,'') || '|' || COALESCE(p.\\"isProductionTest\\"::text,'') || '|' || o.id || '|' || o.status || '|' || o.\\"orderNumber\\" FROM \\"Payment\\" p JOIN \\"CommercialOrder\\" o ON o.id=p.\\"orderId\\" WHERE p.provider='ALIPAY' AND (p.\\"isProductionTest\\"=true OR p.environment='PRODUCTION') ORDER BY p.\\"createdAt\\" DESC LIMIT 10"`,
  ),
  { timeoutMs: 20000 },
);

const account = await runner.execute(
  shellCommand(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT id || '|' || status || '|' || COALESCE(\\"appId\\",'') || '|' || COALESCE(\\"gatewayUrl\\",'') || '|' || CASE WHEN \\"credentialEncrypted\\" IS NULL OR \\"credentialEncrypted\\"='' THEN '0' ELSE '1' END || '|' || CASE WHEN \\"publicKey\\" IS NULL OR \\"publicKey\\"='' THEN '0' ELSE '1' END FROM \\"PaymentProviderAccount\\" WHERE provider='ALIPAY' AND environment='PRODUCTION' LIMIT 1"`,
  ),
  { timeoutMs: 15000 },
);

// Pull encrypted private key to Alpha process for self-sign only — never print it.
const keyBlob = await runner.execute(
  shellCommand(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT \\"credentialEncrypted\\" || E'\\n---SPLIT---\\n' || COALESCE(\\"publicKey\\",'') FROM \\"PaymentProviderAccount\\" WHERE provider='ALIPAY' AND environment='PRODUCTION' LIMIT 1"`,
  ),
  { timeoutMs: 15000 },
);

const localJwtFpBefore = fingerprint(String(process.env.JWT_SECRET || ''));
const jwtProbe = await runner.execute(
  shellCommand(
    `podman exec launchos-alpha-api sh -c 'printf %s "$JWT_SECRET" | wc -c; printf %s "$JWT_SECRET" | sha256sum | cut -c1-12'`,
  ),
  { timeoutMs: 15000 },
);
const alphaJwt = await runner.execute(
  shellCommand(`podman exec launchos-alpha-api printenv JWT_SECRET`),
  { timeoutMs: 15000 },
);
const alphaJwtValue = String(alphaJwt.stdout || '').replace(/\r?\n$/, '');
if (alphaJwtValue) process.env.JWT_SECRET = alphaJwtValue;

await runner.disconnect();

const orderLines = String(orders.stdout || '')
  .trim()
  .split(/\r?\n/)
  .filter(Boolean);
const latest = orderLines[0] ? orderLines[0].split('|') : null;

const blob = String(keyBlob.stdout || '');
const [enc, alipayPub] = blob.split('\n---SPLIT---\n');
let selfSign = false;
let derivedPubFp = null;
let alipayPubFp = null;
let privateKeyFp = null;
let privateKeyFormat = null;
let requestCanonIncludesSignType = false;
let bugRepro = null;
let decryptOk = false;

try {
  const privateKey = decryptCredential(String(enc || '').trim());
  decryptOk = true;
  privateKeyFp = fingerprint(privateKey);
  privateKeyFormat = privateKey.includes('BEGIN RSA PRIVATE KEY')
    ? 'PKCS1_PEM'
    : privateKey.includes('BEGIN PRIVATE KEY')
      ? 'PKCS8_PEM'
      : privateKey.includes('BEGIN')
        ? 'OTHER_PEM'
        : 'RAW_BASE64';

  selfSign = selfSignVerify(privateKey, 'launchos-alipay-signature-self-test');
  alipayPubFp = fingerprint(String(alipayPub || '').trim());
  try {
    const keyObj = (() => {
      if (privateKey.includes('BEGIN')) return createPrivateKey(privateKey);
      try {
        return createPrivateKey(
          `-----BEGIN PRIVATE KEY-----\n${privateKey.replace(/\s+/g, '').match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----`,
        );
      } catch {
        return createPrivateKey(
          `-----BEGIN RSA PRIVATE KEY-----\n${privateKey.replace(/\s+/g, '').match(/.{1,64}/g).join('\n')}\n-----END RSA PRIVATE KEY-----`,
        );
      }
    })();
    const pubPem = createPublicKey(keyObj).export({ type: 'spki', format: 'pem' }).toString();
    derivedPubFp = fingerprint(pubPem);
  } catch {
    derivedPubFp = null;
  }

  const demo = {
    app_id: 'x',
    method: 'alipay.trade.page.pay',
    charset: 'utf-8',
    sign_type: 'RSA2',
    biz_content: '{"a":1}',
    version: '1.0',
    format: 'json',
    timestamp: '2026-10-02 14:00:00',
  };
  const requestCanon = canonicalAlipayPayload(demo, 'request');
  const notifyCanon = canonicalAlipayPayload(demo, 'notify');
  requestCanonIncludesSignType = requestCanon.includes('sign_type=');
  bugRepro = {
    requestCanonHasSignType: requestCanonIncludesSignType,
    notifyCanonHasSignType: notifyCanon.includes('sign_type='),
    officialRequiresSignTypeInRequestSign: true,
    selfSignVerify: selfSign,
  };
} catch (error) {
  selfSign = false;
  bugRepro = { error: error instanceof Error ? error.message : String(error) };
}

const report = {
  PAYMENT_TEST_ORDER_COUNT_CREATED_DURING_FAILED_ATTEMPT: orderLines.length,
  LATEST_PAYMENT_ORDER_ID: latest?.[0] ?? null,
  LATEST_PAYMENT_STATUS: latest?.[1] ?? null,
  LATEST_OUT_TRADE_NO: latest?.[2] ?? null,
  LATEST_AMOUNT_CENTS: latest?.[3] ?? null,
  LATEST_ENVIRONMENT: latest?.[4] ?? null,
  LATEST_IS_PRODUCTION_TEST: latest?.[5] ?? null,
  LATEST_COMMERCIAL_ORDER_ID: latest?.[6] ?? null,
  LATEST_COMMERCIAL_ORDER_STATUS: latest?.[7] ?? null,
  PRODUCTION_ACCOUNT: String(account.stdout || '').trim(),
  ALPHA_JWT_FP: alphaJwtValue ? fingerprint(alphaJwtValue) : null,
  LOCAL_ENV_JWT_FP: localJwtFpBefore,
  JWT_PROBE: String(jwtProbe.stdout || '').trim(),
  CREDENTIAL_DECRYPT_OK: decryptOk,
  RSA2_SELF_SIGN_VERIFY: selfSign,
  PRIVATE_KEY_FORMAT: privateKeyFormat,
  APPLICATION_PRIVATE_KEY_FINGERPRINT: privateKeyFp,
  DERIVED_APPLICATION_PUBLIC_KEY_FINGERPRINT: derivedPubFp,
  ALIPAY_PUBLIC_KEY_FINGERPRINT: alipayPubFp,
  KEYS_ARE_DIFFERENT_ROLES: privateKeyFp && alipayPubFp ? privateKeyFp !== alipayPubFp : null,
  REQUEST_CANON_BUG: bugRepro,
  ROOT_CAUSE:
    requestCanonIncludesSignType === false
      ? 'REQUEST_SIGN_EXCLUDES_SIGN_TYPE'
      : 'REQUEST_SIGN_EXCLUDES_SIGN_TYPE_FIXED',
  REQUEST_SIGN_INCLUDES_SIGN_TYPE: requestCanonIncludesSignType,
};

writeFileSync(join(ARTIFACT, 'm8-1a-signature-diagnose.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await prisma.$disconnect();
