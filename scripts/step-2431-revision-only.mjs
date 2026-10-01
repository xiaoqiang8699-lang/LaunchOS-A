/**
 * Focused revision propagation test (no deployments).
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const API = 'http://localhost:3001/api/v1';
const PROJECT_ID = 'cmu3j24mv0001ri7wcsoa30hj';
const WEB_UNIT = 'cmu3j27340007ri7wcno1xrai';
const API_UNIT = 'cmu3j272x0005ri7wlxlbajeu';
const A = 'https://placeholder.invalid/sentry-a';
const B = 'https://placeholder.invalid/sentry-b';
const C = 'https://placeholder.invalid/sentry-c';
const DB = 'postgresql://e2e:e2e@127.0.0.1:5432/e2e_test';

async function api(path, { method = 'GET', token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const res = await fetch(`${API}${path}`, { method, headers, body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || res.statusText);
  return json;
}

async function login() {
  const data = await api('/auth/login', {
    method: 'POST',
    body: { email: 'xiaoqiang8699@gmail.com', password: 'Launchos123!' },
  });
  return data.accessToken;
}

async function revs() {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { PrismaClient } = require(resolve(ROOT, 'packages/database/generated/client'));
  const p = new PrismaClient();
  const [web, apiU, project] = await Promise.all([
    p.deployableUnit.findUnique({ where: { id: WEB_UNIT }, select: { configRevision: true } }),
    p.deployableUnit.findUnique({ where: { id: API_UNIT }, select: { configRevision: true } }),
    p.project.findUnique({ where: { id: PROJECT_ID }, select: { sharedConfigRevision: true } }),
  ]);
  await p.$disconnect();
  return { web: web.configRevision, api: apiU.configRevision, shared: project.sharedConfigRevision };
}

async function cfg(token, unitId) {
  const data = await api(`/projects/${PROJECT_ID}/units/${unitId}/config-requirements`, { token });
  return data.requirements.find((r) => r.key === 'SENTRY_DSN');
}

const token = await login();
await api(`/projects/${PROJECT_ID}/config/DATABASE_URL`, {
  method: 'PUT',
  token,
  body: { value: DB },
});
await api(`/projects/${PROJECT_ID}/config/SENTRY_DSN`, { method: 'PUT', token, body: { value: A } });
try {
  await api(`/projects/${PROJECT_ID}/units/${API_UNIT}/config/SENTRY_DSN`, { method: 'DELETE', token });
} catch {}

const r1 = await revs();
const w1 = await cfg(token, WEB_UNIT);
const a1 = await cfg(token, API_UNIT);

await api(`/projects/${PROJECT_ID}/units/${API_UNIT}/config/SENTRY_DSN`, {
  method: 'PUT',
  token,
  body: { value: B },
});
const r2 = await revs();
const w2 = await cfg(token, WEB_UNIT);
const a2 = await cfg(token, API_UNIT);

await api(`/projects/${PROJECT_ID}/config/SENTRY_DSN`, { method: 'PUT', token, body: { value: C } });
const r3 = await revs();
const w3 = await cfg(token, WEB_UNIT);
const a3 = await cfg(token, API_UNIT);

await api(`/projects/${PROJECT_ID}/units/${API_UNIT}/config/SENTRY_DSN/restore-shared`, {
  method: 'POST',
  token,
});
const r4 = await revs();
const a4 = await cfg(token, API_UNIT);

console.log(
  JSON.stringify(
    {
      afterProjectA: { rev: r1, web: w1?.resolvedSource, api: a1?.resolvedSource },
      afterApiOverrideB: {
        rev: r2,
        web: w2?.resolvedSource,
        api: a2?.resolvedSource,
        apiOverride: a2?.hasUnitOverride,
        webRevDelta: r2.web - r1.web,
        apiRevDelta: r2.api - r1.api,
      },
      afterProjectC: {
        rev: r3,
        web: w3?.resolvedSource,
        api: a3?.resolvedSource,
        apiOverride: a3?.hasUnitOverride,
        webRevDelta: r3.web - r2.web,
        apiRevDelta: r3.api - r2.api,
        webNeedsRedeploy: w3?.needsRedeploy,
        apiNeedsRedeploy: a3?.needsRedeploy,
      },
      afterRestoreShared: {
        rev: r4,
        api: a4?.resolvedSource,
        apiRevDelta: r4.api - r3.api,
        apiNeedsRedeploy: a4?.needsRedeploy,
      },
    },
    null,
    2,
  ),
);
