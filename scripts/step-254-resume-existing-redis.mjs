/**
 * Step 25.4 resume existing Redis (no CreateInstance / no --confirm-billing).
 *
 *   node scripts/step-254-resume-existing-redis.mjs
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
const INSTANCE_ID = 'r-bp1e95c9abe63464';
const API = process.env.API_BASE || 'http://127.0.0.1:3001/api/v1';
const PROJECT_ID = process.env.E2E_PROJECT_ID || 'cmu3j24mv0001ri7wcsoa30hj';
const API_UNIT = process.env.E2E_API_UNIT_ID || 'cmu3j272x0005ri7wlxlbajeu';
const WEB_UNIT = process.env.E2E_WEB_UNIT_ID || 'cmu3j27340007ri7wcno1xrai';
const ENV_ID = process.env.E2E_ENV_ID || 'cmu3j5ppc000hri7wvxrjopit';
const SERVER_ID = process.env.E2E_SERVER_ID || 'cmu22cqo80007ri6wkt4krfsq';
const API_PUBLIC = process.env.E2E_API_URL || 'https://api-launchos.zsaos.com';
const WEB_PUBLIC = process.env.E2E_WEB_URL || 'https://web-launchos.zsaos.com';

const { PrismaClient } = require(resolve(root, 'packages/database/generated/client'));
const { decryptCredential } = require(resolve(root, 'packages/shared/dist/index.js'));
const { AlibabaCloudRedisProvider } = require(resolve(root, 'packages/providers/dist/index.js'));

function assertNoPlaintext(value, label) {
  const blob = typeof value === 'string' ? value : JSON.stringify(value);
  const hits = [];
  if (/redis:\/\/[^:\s]+:[^@\s]+@/i.test(blob)) hits.push('REDIS_URL');
  if (/accessKeySecret["']?\s*[:=]/i.test(blob)) hits.push('AK/SK');
  if (/("password"\s*:\s*"[^"*]+"|Password=[^&*\s]+)/i.test(blob) && !/Password=\*\*\*/.test(blob)) {
    hits.push('password');
  }
  if (hits.length) throw new Error(`plaintext secret in ${label}: ${hits.join(',')}`);
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
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  if (!res.ok) {
    throw new Error(
      Array.isArray(json?.message) ? json.message.join(',') : json?.message || res.statusText,
    );
  }
  assertNoPlaintext(json, `API ${path}`);
  return json;
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitProvision(token, timeoutMs = 20 * 60_000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await api(`/projects/${PROJECT_ID}/redis-provisions/${CR}`, { token });
    const phase = last.phase || last.statusRaw || last.status;
    if (last.statusRaw === 'RUNNING' || last.status === 'READY' || phase === 'DONE') {
      return last;
    }
    if (
      (last.statusRaw === 'FAILED' || last.status === 'FAILED' || phase === 'FAILED') &&
      !last.canRetry
    ) {
      return last;
    }
    if (last.statusRaw === 'FAILED' || last.status === 'FAILED' || phase === 'FAILED') {
      // Still retryable or mid-flight; keep polling briefly
      if (Date.now() - started > 30_000 && last.errorCode && last.errorCode !== 'PROVIDER_TIMEOUT') {
        return last;
      }
    }
    await sleep(5000);
  }
  return last;
}

async function waitDeployment(token, deploymentId, timeoutMs = 20 * 60_000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await api(`/projects/${PROJECT_ID}/deployments/${deploymentId}`, { token });
    if (['SUCCESS', 'FAILED', 'CANCELLED'].includes(last.status)) return last;
    await sleep(5000);
  }
  return last;
}

const prisma = new PrismaClient();
const report = {
  cloudResourceId: CR,
  providerResourceId: INSTANCE_ID,
  createInstanceCalled: false,
  confirmBilling: false,
};

try {
  // --- 1. Confirm provider instance ---
  const cr0 = await prisma.cloudResource.findUnique({ where: { id: CR } });
  if (!cr0) throw new Error('CloudResource missing');
  if (cr0.providerResourceId !== INSTANCE_ID) {
    throw new Error(`providerResourceId mismatch: ${cr0.providerResourceId}`);
  }
  const meta0 = cr0.metadata && typeof cr0.metadata === 'object' ? { ...cr0.metadata } : {};
  if (meta0.createInstanceCompleted !== true) {
    throw new Error('createInstanceCompleted must be true before resume');
  }
  if (!meta0.passwordEncrypted) {
    throw new Error('passwordEncrypted missing — cannot regenerate');
  }

  // Ensure only API unit is bound.
  const unitIds = Array.isArray(meta0.unitIds)
    ? meta0.unitIds.filter((id) => id === API_UNIT)
    : [API_UNIT];
  if (!unitIds.includes(API_UNIT) || unitIds.some((id) => id === WEB_UNIT)) {
    await prisma.cloudResource.update({
      where: { id: CR },
      data: {
        metadata: {
          ...meta0,
          unitIds: [API_UNIT],
          serverInstanceId: meta0.serverInstanceId || SERVER_ID,
        },
      },
    });
  } else if (!meta0.serverInstanceId) {
    await prisma.cloudResource.update({
      where: { id: CR },
      data: {
        metadata: { ...meta0, serverInstanceId: SERVER_ID, unitIds: [API_UNIT] },
      },
    });
  }

  const account = await prisma.providerAccount.findFirst({
    where: { status: 'ACTIVE', provider: { type: 'ALIYUN' }, workspaceId: cr0.workspaceId },
    orderBy: { createdAt: 'asc' },
  });
  const secrets = JSON.parse(decryptCredential(account.credentialEncrypted));
  const provider = new AlibabaCloudRedisProvider({
    accessKey: secrets.accessKey,
    secretKey: secrets.secretKey,
    region: cr0.region || 'cn-hangzhou',
  });
  let inst = await provider.getInstanceStatus(INSTANCE_ID);
  report.instanceStatusBefore = inst;
  if (inst.status !== 'RUNNING') {
    // wait up to 5 min — never Create
    const waitStart = Date.now();
    while (inst.status !== 'RUNNING' && Date.now() - waitStart < 5 * 60_000) {
      await sleep(10_000);
      inst = await provider.getInstanceStatus(INSTANCE_ID);
    }
  }
  if (inst.status !== 'RUNNING') {
    throw new Error(`Redis not RUNNING after wait: ${inst.rawStatus || inst.status}`);
  }
  const byName = await provider.listInstancesByName(
    cr0.region || 'cn-hangzhou',
    String(meta0.instanceName || 'launchos-launchos'),
  );
  report.reconcileBefore = { matchCount: byName.length, instanceIds: byName };
  if (byName.length !== 1 || byName[0] !== INSTANCE_ID) {
    throw new Error(`expected exactly one Redis ${INSTANCE_ID}, got ${JSON.stringify(byName)}`);
  }

  const apiUnitBefore = await prisma.deployableUnit.findUnique({
    where: { id: API_UNIT },
    select: { configRevision: true },
  });
  const webUnitBefore = await prisma.deployableUnit.findUnique({
    where: { id: WEB_UNIT },
    select: { configRevision: true },
  });
  report.apiRevisionBefore = apiUnitBefore?.configRevision ?? null;
  report.webRevisionBefore = webUnitBefore?.configRevision ?? null;

  // --- Login + retry (resume from PREPARING_NETWORK, skip Create) ---
  const login = await api('/auth/login', {
    method: 'POST',
    body: {
      email: process.env.E2E_EMAIL || 'xiaoqiang8699@gmail.com',
      password: process.env.E2E_PASSWORD || 'Launchos123!',
    },
  });
  const token = login.accessToken;

  const resumed = await api(`/projects/${PROJECT_ID}/redis-provisions/${CR}/retry`, {
    method: 'POST',
    token,
  });
  report.resumeResponse = {
    id: resumed.id,
    status: resumed.status,
    statusRaw: resumed.statusRaw,
    phase: resumed.phase,
    providerResourceId: resumed.providerResourceId,
    createInstanceAttemptCount: resumed.createInstanceAttemptCount,
    createInstanceSuccessCount: resumed.createInstanceSuccessCount,
    createGeneration: resumed.createGeneration,
  };
  assertNoPlaintext(resumed, 'retry response');

  // Guard: attempt count must not jump from a new Create (still 8 until worker finishes)
  const crMid = await prisma.cloudResource.findUnique({ where: { id: CR } });
  if (crMid.providerResourceId !== INSTANCE_ID) {
    throw new Error('providerResourceId changed unexpectedly during resume');
  }
  if (Number(crMid.metadata?.createGeneration || 2) > 2) {
    throw new Error('createGeneration advanced — forbidden');
  }

  console.log(JSON.stringify({ stage: 'resumed', resume: report.resumeResponse }, null, 2));

  const provisioned = await waitProvision(token);
  report.provisionFinal = {
    status: provisioned?.status,
    statusRaw: provisioned?.statusRaw,
    phase: provisioned?.phase,
    networkMode: provisioned?.networkMode,
    connectionHost: provisioned?.connectionHost,
    connectionPort: provisioned?.connectionPort,
    redisConnectionId: provisioned?.redisConnectionId,
    errorCode: provisioned?.errorCode,
    errorMessage: provisioned?.errorMessage,
    providerResourceId: provisioned?.providerResourceId,
    createInstanceAttemptCount: provisioned?.createInstanceAttemptCount,
    createInstanceSuccessCount: provisioned?.createInstanceSuccessCount,
  };
  console.log(JSON.stringify({ stage: 'provisioned', ...report.provisionFinal }, null, 2));

  if (provisioned?.statusRaw !== 'RUNNING' && provisioned?.phase !== 'DONE') {
    const crFail = await prisma.cloudResource.findUnique({ where: { id: CR } });
    report.failureMeta = {
      phase: crFail?.metadata?.phase,
      errorCode: crFail?.metadata?.errorCode,
      technicalMessage: String(crFail?.metadata?.technicalMessage || '').slice(0, 800),
      providerErrorCode: crFail?.metadata?.providerErrorCode,
      networkMode: crFail?.metadata?.networkMode,
    };
    throw new Error(
      `provision did not complete: ${provisioned?.statusRaw}/${provisioned?.phase} ${provisioned?.errorCode || ''}`,
    );
  }

  // Capture after provision
  const crDone = await prisma.cloudResource.findUnique({ where: { id: CR } });
  const metaDone = crDone.metadata || {};
  report.networkMode = metaDone.networkMode || provisioned.networkMode;
  report.connectionHost = metaDone.connectionHost || provisioned.connectionHost;
  report.connectionPort = metaDone.connectionPort || provisioned.connectionPort;
  report.redisConnectionId = metaDone.redisConnectionId || provisioned.redisConnectionId;
  report.authCompleted = Boolean(metaDone.passwordEncrypted);
  report.pingImpliedByPhase = metaDone.phase === 'DONE';

  const conn = await prisma.redisConnection.findFirst({
    where: { cloudResourceId: CR },
  });
  report.redisConnection = conn
    ? {
        id: conn.id,
        host: conn.host,
        port: conn.port,
        source: conn.source,
        status: conn.status,
        databaseIndex: conn.databaseIndex,
        hasPasswordEncrypted: Boolean(conn.passwordEncrypted),
      }
    : null;

  const redisBindings = await prisma.runtimeConfigValue.findMany({
    where: { key: 'REDIS_URL', deployableUnitId: { in: [API_UNIT, WEB_UNIT] } },
    select: {
      deployableUnitId: true,
      provider: true,
      providerRef: true,
      isSensitive: true,
      valueEncrypted: true,
    },
  });
  report.redisUrlBoundApi = redisBindings.some(
    (b) =>
      b.deployableUnitId === API_UNIT &&
      b.provider === 'REDIS_CONNECTION' &&
      b.providerRef === conn?.id,
  );
  report.redisUrlBoundWeb = redisBindings.some((b) => b.deployableUnitId === WEB_UNIT);
  // Never decrypt REDIS_URL into report
  report.redisUrlBindingSafe = redisBindings.map((b) => ({
    deployableUnitId: b.deployableUnitId,
    provider: b.provider,
    providerRef: b.providerRef,
    isSensitive: b.isSensitive,
    encryptedLen: b.valueEncrypted?.length || 0,
  }));

  const apiUnitAfterBind = await prisma.deployableUnit.findUnique({
    where: { id: API_UNIT },
    select: { configRevision: true },
  });
  const webUnitAfterBind = await prisma.deployableUnit.findUnique({
    where: { id: WEB_UNIT },
    select: { configRevision: true },
  });
  report.apiRevisionAfterBind = apiUnitAfterBind?.configRevision ?? null;
  report.webRevisionAfterBind = webUnitAfterBind?.configRevision ?? null;

  // Whitelist snapshot (best-effort via connection info / placement meta)
  report.whitelistHint = {
    networkMode: report.networkMode,
    vpcId: metaDone.vpcId || null,
    vSwitchId: metaDone.vSwitchId || null,
    note: 'Whitelist set by worker setWhitelist from placement; 0.0.0.0/0 forbidden by sanitize',
  };

  // --- Redeploy API via normal API → BullMQ → Worker ---
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
  report.deploymentId = deployment.id;
  const finished = await waitDeployment(token, deployment.id);
  report.deploymentStatus = finished?.status;
  report.serviceHealth = {
    status: finished?.status,
    // detailed SI/health fetched below
  };

  const si = await prisma.serviceInstance.findFirst({
    where: { deployableUnitId: API_UNIT },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, status: true, healthStatus: true, updatedAt: true },
  });
  report.serviceInstance = si;

  await sleep(4000);
  const redisCheckRes = await fetch(`${API_PUBLIC}/redis-check`);
  const redisCheckBody = await redisCheckRes.json().catch(() => ({}));
  assertNoPlaintext(redisCheckBody, '/redis-check');
  report.redisCheck = {
    httpStatus: redisCheckRes.status,
    redisConnected: redisCheckBody?.redisConnected === true,
    bodyKeys: Object.keys(redisCheckBody || {}),
  };

  const webRes = await fetch(WEB_PUBLIC);
  report.webCheck = { httpStatus: webRes.status };

  // Uniqueness again
  const byNameAfter = await provider.listInstancesByName(
    cr0.region || 'cn-hangzhou',
    String(meta0.instanceName || 'launchos-launchos'),
  );
  report.reconcileAfter = { matchCount: byNameAfter.length, instanceIds: byNameAfter };

  const crFinal = await prisma.cloudResource.findUnique({ where: { id: CR } });
  const mFinal = crFinal.metadata || {};
  report.counters = {
    totalAttempt: mFinal.createInstanceAttemptCount,
    totalSuccess: mFinal.createInstanceSuccessCount,
    generation: mFinal.createGeneration,
    genAttempt: mFinal.generationAttemptCount,
    genSuccess: mFinal.generationSuccessCount,
  };
  report.providerCreateCountersDuringResume = {
    attempt: provider.createInstanceAttemptCount,
    success: provider.createInstanceSuccessCount,
  };

  // Security scan of key surfaces (no secrets expected)
  const scanTargets = [
    JSON.stringify(report),
    JSON.stringify(provisioned),
    JSON.stringify(finished),
    JSON.stringify(report.redisConnection),
  ];
  let plaintextHits = 0;
  for (const t of scanTargets) {
    if (/redis:\/\/[^:\s]+:[^@\s]+@/i.test(t)) plaintextHits++;
    if (/Password=[^&*\s]+/i.test(t) && !/Password=\*\*\*/.test(t)) plaintextHits++;
  }
  report.secretPlaintextHits = plaintextHits;

  report.passed =
    report.instanceStatusBefore?.status === 'RUNNING' &&
    report.networkMode &&
    report.authCompleted &&
    report.pingImpliedByPhase &&
    Boolean(report.redisConnection?.id) &&
    report.redisUrlBoundApi === true &&
    report.redisUrlBoundWeb === false &&
    report.apiRevisionAfterBind > report.apiRevisionBefore &&
    report.webRevisionAfterBind === report.webRevisionBefore &&
    report.deploymentStatus === 'SUCCESS' &&
    report.redisCheck?.redisConnected === true &&
    report.webCheck?.httpStatus === 200 &&
    report.reconcileAfter?.matchCount === 1 &&
    report.providerCreateCountersDuringResume.attempt === 0 &&
    report.secretPlaintextHits === 0;

  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
