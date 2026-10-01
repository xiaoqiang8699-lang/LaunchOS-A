/**
 * Step 26.1 server-plan acceptance.
 * Never RunInstances / Create ECS.
 *
 *   node scripts/step-261-server-plan-acceptance.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
for (const line of readFileSync(resolve(root, '.env'), 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i <= 0) continue;
  const k = t.slice(0, i).trim();
  let v = t.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (process.env[k] === undefined) process.env[k] = v;
}

const API = process.env.API_BASE || 'http://127.0.0.1:3001/api/v1';
const PROJECT_ID = process.env.E2E_PROJECT_ID || 'cmu3j24mv0001ri7wcsoa30hj';

function assertNoSecret(json, label) {
  const blob = JSON.stringify(json);
  if (/AccessKey|accessKeySecret|passwordEncrypted|BEGIN RSA/i.test(blob) && /AK[A-Z0-9]{10,}/.test(blob)) {
    throw new Error(`credential leak in ${label}`);
  }
  if (/"password"\s*:\s*"[^"*]{4,}"/i.test(blob)) throw new Error(`password leak in ${label}`);
}

async function api(path, { method = 'GET', token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${API}${path}`, { method, headers, body: payload });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(
      Array.isArray(json?.message) ? json.message.join(',') : json?.message || res.statusText,
    );
  }
  assertNoSecret(json, path);
  return json;
}

const results = [];
function log(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const login = await api('/auth/login', {
  method: 'POST',
  body: {
    email: process.env.E2E_EMAIL || 'xiaoqiang8699@gmail.com',
    password: process.env.E2E_PASSWORD || 'Launchos123!',
  },
});
const token = login.accessToken;

const existing = await api(`/projects/${PROJECT_ID}/server-plan`, { token });
log('needServer', existing.needServer === true, String(existing.needServer));
log(
  'existing mode has server',
  Boolean(existing.existingServer?.host),
  existing.existingServer?.host || 'none',
);
log(
  'existing evaluation present',
  Boolean(existing.existingServer?.evaluation?.fit),
  existing.existingServer?.evaluation?.fit || 'none',
);
log('createBlocked', existing.createBlocked === true, existing.createBlockedReason);
log(
  'dependency region hangzhou',
  existing.recommendation?.regionId === 'cn-hangzhou' ||
    (existing.dependencyRegions || []).includes('cn-hangzhou'),
  `${existing.recommendation?.regionId} deps=${JSON.stringify(existing.dependencyRegions)}`,
);
log(
  'no public dynamic ports',
  existing.placement?.securityGroupPlan?.denyPublicDynamicContainerPorts === true &&
    JSON.stringify(existing.placement?.securityGroupPlan?.allowTcp) === JSON.stringify([22, 80, 443]),
  JSON.stringify(existing.placement?.securityGroupPlan),
);

const dry = await api(`/projects/${PROJECT_ID}/server-plan?simulateNoServer=1`, { token });
log('simulate no-server', dry.simulatedNoServer === true && !dry.existingServer, String(dry.existingServer));
log('readiness PLANNED or NOT_CONFIGURED', ['PLANNED', 'NOT_CONFIGURED'].includes(dry.readiness), dry.readiness);
log('region cn-hangzhou', dry.recommendation?.regionId === 'cn-hangzhou', dry.recommendation?.regionId);

const tiers = dry.tiers || [];
for (const profile of ['DEV', 'STANDARD', 'PRODUCTION']) {
  const tier = tiers.find((t) => t.profile === profile);
  const hasSku = Boolean(tier?.sku?.instanceType);
  const priceOk = !hasSku || tier.priceEstimate?.available === true || tier.unavailableReason;
  log(
    `tier ${profile}`,
    Boolean(tier) && priceOk,
    hasSku
      ? `${tier.sku.instanceType} hourly=${tier.priceEstimate?.hourlyPrice || 'n/a'}`
      : tier?.unavailableReason || 'no sku',
  );
  // Must not invent fake price without SKU
  if (!hasSku && tier?.priceEstimate?.available) {
    log(`tier ${profile} no fake price`, false, 'price without sku');
  }
}

log(
  'shared server message',
  /共享|Web|API/i.test(dry.recommendation?.deployModeLabel || dry.recommendation?.reason || ''),
  dry.recommendation?.deployModeLabel,
);

// Guard: response must not claim create happened
const blob = JSON.stringify(dry);
log('no RunInstances claim', !/RunInstances|server_created|正在创建云服务器实例/.test(blob), 'ok');

const failed = results.filter((r) => !r.ok);
console.log(`\nSummary: ${results.length - failed.length}/${results.length} passed`);
console.log(
  JSON.stringify(
    {
      existingHost: existing.existingServer?.host,
      existingFit: existing.existingServer?.evaluation?.fit,
      dryRegion: dry.recommendation?.regionId,
      dryProfile: dry.recommendation?.profile,
      prices: (dry.tiers || []).map((t) => ({
        profile: t.profile,
        sku: t.sku?.instanceType || null,
        hourly: t.priceEstimate?.hourlyPrice || null,
        monthly: t.priceEstimate?.monthlyEquivalent || null,
      })),
    },
    null,
    2,
  ),
);
if (failed.length) process.exitCode = 1;
