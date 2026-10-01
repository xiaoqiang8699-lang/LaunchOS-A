/**
 * Trigger API unit redeploy for Step 25.5 regression (dependency gate + sync revision).
 * Does not Create/Delete cloud resources.
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
const ENV_ID = process.env.E2E_ENV_ID || 'cmu3j5ppc000hri7wvxrjopit';
const SERVER_ID = process.env.E2E_SERVER_ID || 'cmu22cqo80007ri6wkt4krfsq';

function assertNoSecret(json, label) {
  const blob = JSON.stringify(json);
  if (/redis:\/\/[^:\s]+:[^@\s]+@/i.test(blob)) throw new Error(`REDIS_URL leak in ${label}`);
  if (/postgres(ql)?:\/\/[^:\s]+:[^@\s]+@/i.test(blob)) {
    throw new Error(`DATABASE_URL leak in ${label}`);
  }
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
    err.payload = json;
    throw err;
  }
  assertNoSecret(json, path);
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const login = await api('/auth/login', {
  method: 'POST',
  body: {
    email: process.env.E2E_EMAIL || 'xiaoqiang8699@gmail.com',
    password: process.env.E2E_PASSWORD || 'Launchos123!',
  },
});
const token = login.accessToken;

const validation = await api(
  `/projects/${PROJECT_ID}/dependencies/units/${API_UNIT}/POSTGRESQL/validate-deploy`,
  { method: 'POST', token },
);
console.log('pre-deploy validation', JSON.stringify(validation));
if (!validation.ready) {
  console.error('Deploy blocked by dependencies');
  process.exit(1);
}

const created = await api(`/projects/${PROJECT_ID}/deployments`, {
  method: 'POST',
  token,
  body: {
    environmentId: ENV_ID,
    deployableUnitId: API_UNIT,
    hostingMode: 'my-server',
    serverInstanceId: SERVER_ID,
  },
});
console.log('deployment created', created.id);

const started = Date.now();
let final = null;
while (Date.now() - started < 20 * 60_000) {
  const d = await api(`/deployments/${created.id}`, { token });
  console.log(`status=${d.status} phase=${d.phase || d.currentPhase || ''}`);
  if (['SUCCESS', 'FAILED', 'CANCELLED'].includes(d.status)) {
    final = d;
    break;
  }
  await sleep(8000);
}

if (!final || final.status !== 'SUCCESS') {
  console.error('API redeploy did not succeed', final?.status, final?.errorCode || final?.errorMessage);
  process.exit(1);
}

const summary = await api(`/projects/${PROJECT_ID}/dependencies`, { token });
const apiUnit = summary.units.find((u) => u.unitId === API_UNIT);
console.log(
  JSON.stringify(
    {
      deploymentId: created.id,
      project: summary.project,
      apiDeps: apiUnit?.dependencies,
    },
    null,
    2,
  ),
);
