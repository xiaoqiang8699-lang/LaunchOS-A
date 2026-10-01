/**
 * Redeploy API to Target Server via API→BullMQ (no CreateDBInstance).
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
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1);
  }
  if (process.env[k] === undefined) process.env[k] = v;
}

const API = process.env.API_BASE || 'http://127.0.0.1:3001/api/v1';
const PROJECT_ID = 'cmu3j24mv0001ri7wcsoa30hj';
const API_UNIT = 'cmu3j272x0005ri7wlxlbajeu';
const WEB_UNIT = 'cmu3j27340007ri7wcno1xrai';
const ENV_ID = 'cmu3j5ppc000hri7wvxrjopit';
const SERVER_ID = 'cmu22cqo80007ri6wkt4krfsq';
const CR_ID = 'cmu4110xm0001ric027vr0tc3';

const { PrismaClient } = require(resolve(root, 'packages/database/generated/client'));
const { redactSecrets } = require(resolve(root, 'packages/shared/dist/index.js'));

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
  const blob = JSON.stringify(json);
  if (/accessKeySecret|secretKey|passwordEncrypted|postgres:\/\/[^:]+:[^@]+@/i.test(blob)) {
    throw new Error('possible secret leak in API response');
  }
  return json;
}

const prisma = new PrismaClient();
const login = await api('/auth/login', {
  method: 'POST',
  body: {
    email: process.env.E2E_EMAIL || 'xiaoqiang8699@gmail.com',
    password: process.env.E2E_PASSWORD || 'Launchos123!',
  },
});
const token = login.accessToken;

const webSvcBefore = await prisma.serviceInstance.findFirst({
  where: { projectId: PROJECT_ID, deployableUnitId: WEB_UNIT, status: 'RUNNING' },
  orderBy: { updatedAt: 'desc' },
  select: { id: true, containerId: true, status: true, healthStatus: true },
});
const webRevBefore = (
  await api(`/projects/${PROJECT_ID}/units/${WEB_UNIT}/config-requirements`, { token })
).summary?.configRevision;

const deployment = await api(`/projects/${PROJECT_ID}/deployments`, {
  method: 'POST',
  token,
  body: {
    environmentId: ENV_ID,
    deployableUnitId: API_UNIT,
    hostingMode: 'my-server',
    serverInstanceId: SERVER_ID,
  },
});
console.log(JSON.stringify({ deploymentId: deployment.id, status: deployment.status }, null, 2));

let dep = deployment;
const started = Date.now();
while (Date.now() - started < 12 * 60_000) {
  dep = await api(`/deployments/${deployment.id}`, { token });
  console.log(`deploy status=${dep.status}`);
  if (['SUCCESS', 'FAILED', 'CANCELLED'].includes(dep.status)) break;
  await new Promise((r) => setTimeout(r, 5000));
}

if (dep.status === 'FAILED') {
  const row = await prisma.deployment.findUnique({ where: { id: deployment.id } });
  console.log('error', redactSecrets(String(row?.errorMessage || '')).slice(0, 500));
}

const apiSvc = await prisma.serviceInstance.findFirst({
  where: { projectId: PROJECT_ID, deployableUnitId: API_UNIT },
  orderBy: { updatedAt: 'desc' },
  select: {
    id: true,
    status: true,
    healthStatus: true,
    containerId: true,
    serverInstanceId: true,
    externalPort: true,
    internalPort: true,
  },
});
const webSvcAfter = await prisma.serviceInstance.findFirst({
  where: { projectId: PROJECT_ID, deployableUnitId: WEB_UNIT, status: 'RUNNING' },
  orderBy: { updatedAt: 'desc' },
  select: { id: true, containerId: true, status: true, healthStatus: true },
});
const webRevAfter = (
  await api(`/projects/${PROJECT_ID}/units/${WEB_UNIT}/config-requirements`, { token })
).summary?.configRevision;
const apiRev = (
  await api(`/projects/${PROJECT_ID}/units/${API_UNIT}/config-requirements`, { token })
).summary?.configRevision;
const conn = await prisma.databaseConnection.findFirst({
  where: { cloudResourceId: CR_ID },
  select: { id: true, status: true, source: true, cloudResourceId: true },
});
const cr = await prisma.cloudResource.findUnique({
  where: { id: CR_ID },
  select: { status: true, providerResourceId: true },
});

let dbCheck = null;
for (let i = 0; i < 18; i++) {
  try {
    const res = await fetch('https://api-launchos.zsaos.com/db-check', {
      headers: { Accept: 'application/json' },
    });
    dbCheck = { status: res.status, body: await res.json().catch(() => null) };
    if (res.status === 200 && dbCheck.body?.databaseConnected === true) break;
  } catch (err) {
    dbCheck = { error: String(err?.message || err).slice(0, 200) };
  }
  await new Promise((r) => setTimeout(r, 5000));
}
let web = null;
try {
  const res = await fetch('https://web-launchos.zsaos.com');
  web = { status: res.status };
} catch (err) {
  web = { error: String(err?.message || err).slice(0, 200) };
}

console.log(
  JSON.stringify(
    {
      deployment: { id: dep.id, status: dep.status },
      apiService: apiSvc,
      webBefore: webSvcBefore,
      webAfter: webSvcAfter,
      webContainerUnchanged: webSvcBefore?.containerId === webSvcAfter?.containerId,
      revisions: { apiRev, webRevBefore, webRevAfter },
      cloudResource: cr,
      databaseConnection: conn,
      dbCheck,
      web,
    },
    null,
    2,
  ),
);

await prisma.$disconnect();
process.exit(
  dep.status === 'SUCCESS' &&
    dbCheck?.status === 200 &&
    dbCheck?.body?.databaseConnected === true &&
    web?.status === 200
    ? 0
    : 2,
);
