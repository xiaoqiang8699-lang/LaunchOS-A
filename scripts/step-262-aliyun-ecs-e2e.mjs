/**
 * Step 26.2 Aliyun ECS provision E2E.
 * Default: DRY_RUN (RunInstances=0).
 * Inspect existing CR (read-only):
 *   node scripts/step-262-aliyun-ecs-e2e.mjs --cloud-resource-id=cmuas8iiz0001riown1l1a0o3
 *   node scripts/step-262-aliyun-ecs-e2e.mjs --cloud-resource-id cmuas8iiz0001riown1l1a0o3
 * Real create: --confirm-billing
 *
 * Do not call process.exit(). On Windows, exiting while undici keep-alive
 * sockets are closing trips libuv UV_HANDLE_CLOSING.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseStep262Argv } from './lib/step-262-cli.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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

const { cloudResourceId: CLI_CLOUD_RESOURCE_ID, confirmBilling: CONFIRM } = parseStep262Argv(
  process.argv,
);
console.log(`CLI cloudResourceId=${CLI_CLOUD_RESOURCE_ID || 'null'}`);

const API = process.env.API_BASE || 'http://127.0.0.1:3001/api/v1';
const PROJECT_ID = process.env.E2E_PROJECT_ID || 'cmu3j24mv0001ri7wcsoa30hj';

function assertNoSecret(json, label) {
  const blob = JSON.stringify(json);
  if (/AccessKeyId":\s*"LTAI|accessKeySecret|BEGIN (RSA |OPENSSH )?PRIVATE KEY/i.test(blob)) {
    throw new Error(`secret leak in ${label}`);
  }
  if (/"password"\s*:\s*"[^"*]{6,}"/i.test(blob)) throw new Error(`password leak in ${label}`);
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

/** Close the global undici dispatcher once. Never also destroy() or process.exit(). */
async function closeFetchDispatcher() {
  try {
    const undici = await import('undici');
    const dispatcher = undici.getGlobalDispatcher?.();
    if (dispatcher && typeof dispatcher.close === 'function') {
      await dispatcher.close();
    }
  } catch {
    // Node's built-in fetch may not expose undici; natural drain is enough.
  }
}

async function readQueueJobState(cloudResourceId, createGeneration) {
  const require = createRequire(resolve(root, 'apps/api/package.json'));
  const { Queue } = require('bullmq');
  const IORedis = require('ioredis');
  const { SERVER_PROVISION_QUEUE, serverProvisionJobId } = require('@launchos/shared');
  const connection = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: null,
  });
  const queue = new Queue(SERVER_PROVISION_QUEUE, { connection });
  try {
    const gen = Math.max(1, Number(createGeneration || 1));
    const jobId = serverProvisionJobId(cloudResourceId, gen);
    const job = await queue.getJob(jobId);
    if (!job) {
      return { queueJobId: jobId, queueJobState: null };
    }
    return { queueJobId: jobId, queueJobState: await job.getState() };
  } finally {
    await queue.close().catch(() => undefined);
    await connection.quit().catch(() => undefined);
  }
}

async function printTargetCloudResourceStatus(token, cloudResourceId) {
  const st = await api(`/projects/${PROJECT_ID}/server/provisions/${cloudResourceId}`, {
    token,
  });
  const queue = await readQueueJobState(cloudResourceId, st.createGeneration);
  const target = {
    resumeCloudResourceId: st.cloudResourceId || cloudResourceId,
    status: st.status ?? null,
    phase: st.phase ?? null,
    createGeneration: st.createGeneration ?? null,
    queueJobState: queue.queueJobState,
    queueJobId: queue.queueJobId,
    runInstancesAttemptCount: st.runInstancesAttemptCount ?? 0,
    runInstancesSuccessCount: st.runInstancesSuccessCount ?? 0,
    providerResourceId: st.providerResourceId ?? null,
    publicIp: st.publicIp ?? null,
    privateIp: st.privateIp ?? null,
    serverInstanceId: st.serverInstanceId ?? null,
    serverReadiness: st.serverReadiness ?? null,
    failedPhase: st.failedPhase ?? null,
    failedOperation: st.failedOperation ?? null,
    providerErrorCode: st.providerErrorCode ?? null,
    providerRequestId: st.providerRequestId ?? null,
    failedAt: st.failedAt ?? null,
  };
  console.log('\n=== TARGET CLOUD RESOURCE STATUS ===');
  console.log(JSON.stringify(target, null, 2));
  return target;
}

async function main() {
  const login = await api('/auth/login', {
    method: 'POST',
    body: {
      email: process.env.E2E_EMAIL || 'xiaoqiang8699@gmail.com',
      password: process.env.E2E_PASSWORD || 'Launchos123!',
    },
  });
  const token = login.accessToken;

  // When a CR is specified and billing is not confirmed: status-only path (no create).
  if (CLI_CLOUD_RESOURCE_ID && !CONFIRM) {
    const dry = await api(`/projects/${PROJECT_ID}/server/provision/dry-run?profile=STANDARD`, {
      token,
    });
    console.log('=== DRY RUN (capability/price preview only) ===');
    console.log(
      JSON.stringify(
        {
          RUN_INSTANCES_CALLED: dry.RUN_INSTANCES_CALLED,
          allReady: dry.gates?.allReady,
          region: dry.currentResolvedServerPlan?.regionId,
          instanceType: dry.currentResolvedServerPlan?.instanceType,
          priceHourly: dry.priceEstimate?.hourlyPrice ?? null,
        },
        null,
        2,
      ),
    );
    if (dry.RUN_INSTANCES_CALLED !== false) {
      throw new Error('dry-run must keep RUN_INSTANCES_CALLED=false');
    }

    const target = await printTargetCloudResourceStatus(token, CLI_CLOUD_RESOURCE_ID);
    console.log('\nSTATUS_ONLY complete. No create / no --confirm-billing.');
    console.log(
      `ECS created=${Boolean(target.providerResourceId)} attempts=${target.runInstancesAttemptCount}`,
    );
    return 0;
  }

  const dry = await api(`/projects/${PROJECT_ID}/server/provision/dry-run?profile=STANDARD`, {
    token,
  });
  console.log('=== DRY RUN ===');
  const readiness = {
    'ecs.read': dry.capabilityReadiness?.['ecs.read'] || dry.gates?.ecsRead,
    'ecs.price': dry.capabilityReadiness?.['ecs.price'] || dry.gates?.ecsPrice,
    'ecs.instanceCreate':
      dry.capabilityReadiness?.['ecs.instanceCreate'] || dry.gates?.instanceCreate,
    'ecs.securityGroupRead':
      dry.capabilityReadiness?.['ecs.securityGroupRead'] || dry.gates?.securityGroupRead,
    'ecs.securityGroupCreate':
      dry.capabilityReadiness?.['ecs.securityGroupCreate'] || dry.gates?.securityGroupCreate,
    'ecs.securityGroupAuthorize':
      dry.capabilityReadiness?.['ecs.securityGroupAuthorize'] ||
      dry.gates?.securityGroupAuthorize,
    'ecs.imageRead': dry.capabilityReadiness?.['ecs.imageRead'] || dry.gates?.imageRead,
    'vpc.read': dry.capabilityReadiness?.['vpc.read'] || dry.gates?.vpcRead,
    billing: dry.capabilityReadiness?.billing || dry.gates?.billingReady,
  };
  console.log(
    JSON.stringify(
      {
        RUN_INSTANCES_CALLED: dry.RUN_INSTANCES_CALLED,
        canCreate: dry.canCreate,
        allReady: dry.gates?.allReady,
        gates: dry.gates,
        readiness,
        region: dry.currentResolvedServerPlan?.regionId,
        zone: dry.currentResolvedServerPlan?.zoneId,
        instanceType: dry.currentResolvedServerPlan?.instanceType,
        imageId: dry.currentResolvedServerPlan?.imageId,
        price: dry.priceEstimate,
        securityGroupPlan: dry.securityGroupPlan,
        login: dry.login,
        preview: dry.runInstancesRequestPreview,
        capability: dry.capabilityReadiness,
      },
      null,
      2,
    ),
  );

  if (dry.RUN_INSTANCES_CALLED !== false) {
    throw new Error('dry-run must keep RUN_INSTANCES_CALLED=false');
  }
  const hourly = dry.priceEstimate?.hourlyPrice;
  if (!hourly) throw new Error('real price missing');
  const ports = dry.securityGroupPlan?.allowedPorts || [];
  if (JSON.stringify(ports) !== JSON.stringify([22, 80, 443])) {
    throw new Error(`security group ports must be 22/80/443, got ${JSON.stringify(ports)}`);
  }
  if (!['REUSE', 'CREATE', 'READ_DENIED'].includes(dry.securityGroupPlan?.mode)) {
    throw new Error('securityGroupPlan.mode must be REUSE, CREATE, or READ_DENIED');
  }
  const denied = JSON.stringify(dry.securityGroupPlan?.deniedPublicPorts || []);
  for (const forbidden of ['3000', '3001', '39000-39999']) {
    if (!denied.includes(forbidden)) {
      throw new Error(`denied public ports missing ${forbidden}`);
    }
    if (ports.map(String).includes(forbidden)) {
      throw new Error(`public port ${forbidden} must not be allowed`);
    }
  }
  if (dry.login?.loginMode !== 'PASSWORD') {
    throw new Error(`expected PASSWORD v1 fallback, got ${dry.login?.loginMode}`);
  }
  if (dry.gates?.allReady && dry.gates?.securityGroupCreate === false) {
    throw new Error('false green: allReady true while securityGroupCreate is not READY');
  }
  if (dry.gates?.allReady && dry.capabilityReadiness?.['ecs.imageRead'] !== 'READY') {
    throw new Error('false green: allReady true while ecs.imageRead is not READY');
  }
  if (
    dry.gates?.imageReady === true &&
    dry.capabilityReadiness?.['ecs.imageRead'] === 'MISSING_PERMISSION' &&
    dry.gates?.allReady === true
  ) {
    throw new Error('false green: imageReady must not imply ecs.imageRead READY');
  }

  let blocked = false;
  try {
    await api(`/projects/${PROJECT_ID}/server/provision`, {
      method: 'POST',
      token,
      body: { source: 'MANAGED_CREATE', profile: 'STANDARD', confirmBilling: false },
    });
  } catch {
    blocked = true;
    console.log('PASS billing gate without confirm — blocked');
  }
  if (!blocked) throw new Error('confirmBilling=false must block');

  if (!CONFIRM) {
    console.log('\nDRY_RUN complete. Pass --confirm-billing to create a real ECS (costs money).');
    console.log('Existing server 8.138.113.134 is untouched.');
    console.log(`price hourly=${hourly} monthly=${dry.priceEstimate?.monthlyEquivalent || '-'}`);
    console.log(
      JSON.stringify(
        {
          RUN_INSTANCES_CALLED: false,
          allReady: dry.gates?.allReady === true,
          resumeCloudResourceId: dry.resume?.resumeCloudResourceId || null,
          createGeneration: dry.resume?.createGeneration ?? null,
          queueJobState: dry.resume?.queueJobState ?? null,
          queueJobId: dry.resume?.queueJobId ?? null,
          currentErrorCleared: dry.resume?.currentErrorCleared ?? null,
          runInstancesAttemptCount: dry.resume?.runInstancesAttemptCount ?? 0,
          errorHistoryCount: dry.resume?.errorHistoryCount ?? 0,
          runInstancesRequestValid: dry.runInstancesRequestValid,
          missingFields: dry.missingFields,
          securityGroupId:
            dry.resolvedRunInstancesRequest?.SecurityGroupId ||
            dry.securityGroupPlan?.securityGroupId ||
            null,
          passwordPresent: dry.passwordPresent,
        },
        null,
        2,
      ),
    );
    if (!dry.gates?.allReady) {
      console.log('GATES_NOT_READY', JSON.stringify(dry.gates?.blockers || []));
    }
    return 0;
  }

  if (!dry.canCreate) {
    console.error('Cannot create: gates not ready', dry.gates);
    return 1;
  }

  console.log('\n=== REAL CREATE (--confirm-billing) ===');
  const created = await api(`/projects/${PROJECT_ID}/server/provision`, {
    method: 'POST',
    token,
    body: { source: 'MANAGED_CREATE', profile: 'STANDARD', confirmBilling: true },
  });
  console.log('created', created.cloudResourceId, created.phase);

  const started = Date.now();
  let final = null;
  while (Date.now() - started < 25 * 60_000) {
    const st = await api(`/projects/${PROJECT_ID}/server/provisions/${created.cloudResourceId}`, {
      token,
    });
    console.log(
      `status=${st.status} phase=${st.phase} attempts=${st.runInstancesAttemptCount}/${st.runInstancesSuccessCount} ip=${st.publicIp || '-'}`,
    );
    if (st.status === 'RUNNING' || st.status === 'FAILED') {
      final = st;
      break;
    }
    await new Promise((r) => setTimeout(r, 8000));
  }

  if (!final || final.status !== 'RUNNING') {
    console.error('ECS provision did not reach RUNNING', final);
    return 1;
  }

  console.log(
    JSON.stringify(
      {
        cloudResourceId: final.cloudResourceId,
        providerResourceId: final.providerResourceId,
        publicIp: final.publicIp,
        privateIp: final.privateIp,
        serverReadiness: final.serverReadiness,
        serverInstanceId: final.serverInstanceId,
        runInstancesAttemptCount: final.runInstancesAttemptCount,
        runInstancesSuccessCount: final.runInstancesSuccessCount,
      },
      null,
      2,
    ),
  );
  console.log('Step 26.2 real create reached READY_FOR_INITIALIZATION (no software install).');
  return 0;
}

const code = await main().catch((error) => {
  console.error(error?.message || error);
  return 1;
});
await closeFetchDispatcher();
process.exitCode = code;
