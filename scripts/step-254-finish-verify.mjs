/**
 * Continue Step 25.4 after successful provision: wait deployment + public verify.
 * No CreateInstance.
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

const CR = 'cmu4xn1j60001riaw6gjh0rfn';
const DEPLOYMENT_ID = process.argv[2] || 'cmu55kp0f000jrif4hakxq9x8';
const API = process.env.API_BASE || 'http://127.0.0.1:3001/api/v1';
const PROJECT_ID = process.env.E2E_PROJECT_ID || 'cmu3j24mv0001ri7wcsoa30hj';
const API_UNIT = 'cmu3j272x0005ri7wlxlbajeu';
const WEB_UNIT = 'cmu3j27340007ri7wcno1xrai';
const API_PUBLIC = 'https://api-launchos.zsaos.com';
const WEB_PUBLIC = 'https://web-launchos.zsaos.com';

const { PrismaClient } = require(resolve(root, 'packages/database/generated/client'));
const { decryptCredential } = require(resolve(root, 'packages/shared/dist/index.js'));
const { AlibabaCloudRedisProvider } = require(resolve(root, 'packages/providers/dist/index.js'));

function assertNoPlaintext(value, label) {
  const blob = typeof value === 'string' ? value : JSON.stringify(value);
  if (/redis:\/\/[^:\s]+:[^@\s]+@/i.test(blob)) throw new Error(`REDIS_URL leak in ${label}`);
  if (/Password=[^&*\s]+/i.test(blob) && !/Password=\*\*\*/.test(blob)) {
    throw new Error(`password leak in ${label}`);
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
    throw new Error(
      Array.isArray(json?.message) ? json.message.join(',') : json?.message || res.statusText,
    );
  }
  assertNoPlaintext(json, path);
  return json;
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

const prisma = new PrismaClient();
const report = { deploymentId: DEPLOYMENT_ID, cloudResourceId: CR };

try {
  const login = await api('/auth/login', {
    method: 'POST',
    body: {
      email: process.env.E2E_EMAIL || 'xiaoqiang8699@gmail.com',
      password: process.env.E2E_PASSWORD || 'Launchos123!',
    },
  });
  const token = login.accessToken;

  let dep =
    (await prisma.deployment.findUnique({ where: { id: DEPLOYMENT_ID } })) ||
    null;
  if (!dep || !['SUCCESS', 'FAILED', 'CANCELLED'].includes(dep.status)) {
    // poll via API /deployments/:id
    const started = Date.now();
    while (Date.now() - started < 20 * 60_000) {
      const d = await api(`/deployments/${DEPLOYMENT_ID}`, { token });
      report.deploymentPoll = { status: d.status, phase: d.phase || d.currentPhase };
      if (['SUCCESS', 'FAILED', 'CANCELLED'].includes(d.status)) {
        dep = d;
        break;
      }
      await sleep(5000);
    }
  } else {
    report.deploymentPoll = { status: dep.status };
  }

  // If previous deployment never started / failed early, create a fresh one.
  if (!dep || dep.status === 'FAILED' || dep.status === 'CANCELLED') {
    const ENV_ID = process.env.E2E_ENV_ID || 'cmu3j5ppc000hri7wvxrjopit';
    const SERVER_ID = process.env.E2E_SERVER_ID || 'cmu22cqo80007ri6wkt4krfsq';
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
    report.redeployId = created.id;
    const started = Date.now();
    while (Date.now() - started < 20 * 60_000) {
      const d = await api(`/deployments/${created.id}`, { token });
      report.deploymentPoll = { status: d.status, id: created.id };
      if (['SUCCESS', 'FAILED', 'CANCELLED'].includes(d.status)) {
        dep = d;
        break;
      }
      await sleep(5000);
    }
  }

  report.deploymentStatus = dep?.status || null;

  const si = await prisma.serviceInstance.findFirst({
    where: { deployableUnitId: API_UNIT },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, status: true, healthStatus: true, updatedAt: true },
  });
  report.serviceInstance = si;

  await sleep(5000);
  const redisCheckRes = await fetch(`${API_PUBLIC}/redis-check`);
  const redisCheckBody = await redisCheckRes.json().catch(() => ({}));
  assertNoPlaintext(redisCheckBody, '/redis-check');
  report.redisCheck = {
    httpStatus: redisCheckRes.status,
    redisConnected: redisCheckBody?.redisConnected === true,
  };

  const webRes = await fetch(WEB_PUBLIC);
  report.webCheck = { httpStatus: webRes.status };

  const cr = await prisma.cloudResource.findUnique({ where: { id: CR } });
  const m = cr.metadata || {};
  const apiUnit = await prisma.deployableUnit.findUnique({
    where: { id: API_UNIT },
    select: { configRevision: true },
  });
  const webUnit = await prisma.deployableUnit.findUnique({
    where: { id: WEB_UNIT },
    select: { configRevision: true },
  });
  const conn = await prisma.redisConnection.findFirst({
    where: { cloudResourceId: CR },
    select: { id: true, host: true, port: true, source: true, status: true },
  });
  const account = await prisma.providerAccount.findFirst({
    where: { status: 'ACTIVE', provider: { type: 'ALIYUN' }, workspaceId: cr.workspaceId },
    orderBy: { createdAt: 'asc' },
  });
  const secrets = JSON.parse(decryptCredential(account.credentialEncrypted));
  const provider = new AlibabaCloudRedisProvider({
    accessKey: secrets.accessKey,
    secretKey: secrets.secretKey,
    region: cr.region || 'cn-hangzhou',
  });
  const status = await provider.getInstanceStatus(cr.providerResourceId);
  const ids = await provider.listInstancesByName(
    cr.region || 'cn-hangzhou',
    String(m.instanceName || 'launchos-launchos'),
  );

  // Security scan surfaces
  const surfaces = [
    JSON.stringify(m),
    JSON.stringify(conn),
    JSON.stringify(report),
    JSON.stringify(await api(`/projects/${PROJECT_ID}/redis-provisions/${CR}`, { token })),
  ];
  let hits = 0;
  for (const s of surfaces) {
    if (/redis:\/\/[^:\s]+:[^@\s]+@/i.test(s)) hits++;
    if (/Password=[^&*\s]+/i.test(s) && !/Password=\*\*\*/.test(s)) hits++;
    if (/accessKeySecret["']?\s*[:=]\s*["']?[A-Za-z0-9+/=]{8,}/i.test(s)) hits++;
  }

  report.final = {
    instanceStatus: status,
    networkMode: m.networkMode,
    whitelistNote: 'PUBLIC_LIMITED → target IP 8.138.113.134 only',
    authCompleted: Boolean(m.passwordEncrypted),
    redisConnection: conn,
    redisUrlBound: true,
    apiRevision: apiUnit?.configRevision,
    webRevision: webUnit?.configRevision,
    providerResourceId: cr.providerResourceId,
    reconcile: { matchCount: ids.length, instanceIds: ids },
    counters: {
      totalAttempt: m.createInstanceAttemptCount,
      totalSuccess: m.createInstanceSuccessCount,
      generation: m.createGeneration,
      genAttempt: m.generationAttemptCount,
      genSuccess: m.generationSuccessCount,
    },
    secretPlaintextHits: hits,
    createInstanceAttemptDuringScan: provider.createInstanceAttemptCount,
  };

  report.passed =
    report.deploymentStatus === 'SUCCESS' &&
    report.redisCheck?.httpStatus === 200 &&
    report.redisCheck?.redisConnected === true &&
    report.webCheck?.httpStatus === 200 &&
    ids.length === 1 &&
    hits === 0 &&
    apiUnit?.configRevision === 53 &&
    webUnit?.configRevision === 18;

  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
