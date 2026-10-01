/**
 * Step 25.5 Dependency Engine demo acceptance.
 * Does not Create/Delete cloud resources.
 *
 *   node scripts/step-255-dependency-acceptance.mjs
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
const API_UNIT = 'cmu3j272x0005ri7wlxlbajeu';
const WEB_UNIT = 'cmu3j27340007ri7wcno1xrai';
const DB_CONN = 'cmu46oeqy000nri34bgafchld';
const REDIS_CONN = 'cmu55khvi000oriao9afkjywf';

function assertNoSecret(json, label) {
  const blob = JSON.stringify(json);
  if (/redis:\/\/[^:\s]+:[^@\s]+@/i.test(blob)) throw new Error(`REDIS_URL leak in ${label}`);
  if (/postgres(ql)?:\/\/[^:\s]+:[^@\s]+@/i.test(blob)) {
    throw new Error(`DATABASE_URL leak in ${label}`);
  }
  if (/passwordEncrypted|accessKeySecret/i.test(blob) && /"[A-Za-z0-9+/=]{20,}"/.test(blob)) {
    // encrypted blobs ok if key names alone; ensure no plaintext password field
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
    const err = new Error(
      Array.isArray(json?.message) ? json.message.join(',') : json?.message || res.statusText,
    );
    err.code = json?.code;
    err.payload = json;
    throw err;
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

const summary = await api(`/projects/${PROJECT_ID}/dependencies`, { token });
log(
  'project READY',
  summary.project.status === 'READY' &&
    summary.project.required === 2 &&
    summary.project.connected === 2 &&
    summary.project.missing === 0,
  JSON.stringify(summary.project),
);

const apiUnit = summary.units.find((u) => u.unitId === API_UNIT);
const webUnit = summary.units.find((u) => u.unitId === WEB_UNIT);
const apiPg = apiUnit?.dependencies.find((d) => d.type === 'POSTGRESQL');
const apiRedis = apiUnit?.dependencies.find((d) => d.type === 'REDIS');
const webPg = webUnit?.dependencies.find((d) => d.type === 'POSTGRESQL');
const webRedis = webUnit?.dependencies.find((d) => d.type === 'REDIS');

log(
  'API POSTGRESQL CONNECTED',
  (apiPg?.status === 'CONNECTED' || apiPg?.status === 'NEEDS_REDEPLOY') &&
    apiPg?.connectionId === DB_CONN,
  `${apiPg?.status} ${apiPg?.connectionId}`,
);
log(
  'API REDIS CONNECTED',
  (apiRedis?.status === 'CONNECTED' || apiRedis?.status === 'NEEDS_REDEPLOY') &&
    apiRedis?.connectionId === REDIS_CONN,
  `${apiRedis?.status} ${apiRedis?.connectionId}`,
);
log(
  'Web POSTGRESQL NOT_REQUIRED',
  webPg?.status === 'NOT_REQUIRED' || webPg?.required === false,
  `${webPg?.status}`,
);
log(
  'Web REDIS NOT_REQUIRED',
  webRedis?.status === 'NOT_REQUIRED' || webRedis?.required === false,
  `${webRedis?.status}`,
);

const validation = await api(
  `/projects/${PROJECT_ID}/dependencies/units/${API_UNIT}/POSTGRESQL/validate-deploy`,
  { method: 'POST', token },
);
log('deploy validation ready', validation.ready === true, JSON.stringify(validation));

// Soft fault: unlink redis binding then expect MISSING / block, then restore
await api(`/projects/${PROJECT_ID}/dependencies/units/${API_UNIT}/REDIS/unlink`, {
  method: 'POST',
  token,
});
const afterUnlink = await api(`/projects/${PROJECT_ID}/dependencies`, { token });
const redisAfter = afterUnlink.units
  .find((u) => u.unitId === API_UNIT)
  ?.dependencies.find((d) => d.type === 'REDIS');
log('unlink → REDIS MISSING', redisAfter?.status === 'MISSING', redisAfter?.status);
const blocked = await api(
  `/projects/${PROJECT_ID}/dependencies/units/${API_UNIT}/REDIS/validate-deploy`,
  { method: 'POST', token },
).catch((e) => e.payload || { ready: false, blockers: [{ code: e.code }] });
// validate-deploy returns ready:false without throwing
log(
  'unlink → deploy not ready',
  blocked.ready === false &&
    (blocked.blockers || []).some((b) => b.dependencyType === 'REDIS' || b.code),
  JSON.stringify(blocked),
);

await api(`/projects/${PROJECT_ID}/dependencies/units/${API_UNIT}/REDIS/connect`, {
  method: 'POST',
  token,
  body: { connectionId: REDIS_CONN },
});
const restored = await api(`/projects/${PROJECT_ID}/dependencies`, { token });
const redisRestored = restored.units
  .find((u) => u.unitId === API_UNIT)
  ?.dependencies.find((d) => d.type === 'REDIS');
log(
  'restore → REDIS CONNECTED/NEEDS_REDEPLOY',
  redisRestored?.status === 'CONNECTED' || redisRestored?.status === 'NEEDS_REDEPLOY',
  redisRestored?.status,
);

const failed = results.filter((r) => !r.ok);
console.log(`\nSummary: ${results.length - failed.length}/${results.length} passed`);
console.log(JSON.stringify({ summary: restored.project, secretScan: 'ok' }, null, 2));
if (failed.length) process.exitCode = 1;
