/**
 * Step 25.3 Aliyun RDS E2E.
 *
 * Dry-run / readiness (default):
 *   node scripts/step-253-aliyun-rds-e2e.mjs
 *
 * Real billable create (explicit):
 *   node scripts/step-253-aliyun-rds-e2e.mjs --confirm-billing
 *
 * Never prints secrets. Does not auto-delete RDS.
 */
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { PrismaClient } = require(resolve(root, 'packages/database/generated/client'));

const CONFIRM_BILLING = process.argv.includes('--confirm-billing');
const API = process.env.API_BASE || 'http://127.0.0.1:3001/api/v1';
const PROJECT_ID = process.env.E2E_PROJECT_ID || 'cmu3j24mv0001ri7wcsoa30hj';
const API_UNIT = process.env.E2E_API_UNIT || 'cmu3j272x0005ri7wlxlbajeu';
const WEB_UNIT = process.env.E2E_WEB_UNIT || 'cmu3j27340007ri7wcno1xrai';
const ENV_ID = process.env.E2E_ENV_ID || 'cmu3j5ppc000hri7wvxrjopit';
const SERVER_ID = process.env.E2E_SERVER_ID || 'cmu22cqo80007ri6wkt4krfsq';

const results = [];
const log = (step, ok, detail) => {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step}: ${detail}`);
};

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
    err.status = res.status;
    err.body = json;
    throw err;
  }
  const blob = JSON.stringify(json);
  if (/accessKeySecret|secretKey|passwordEncrypted|postgres:\/\/[^:]+:[^@]+@/i.test(blob)) {
    throw new Error('possible secret leak in API response');
  }
  return json;
}

async function login() {
  const data = await api('/auth/login', {
    method: 'POST',
    body: {
      email: process.env.E2E_EMAIL || 'xiaoqiang8699@gmail.com',
      password: process.env.E2E_PASSWORD || 'Launchos123!',
    },
  });
  return data.accessToken;
}

async function waitProvision(token, id, timeoutMs = 25 * 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = await api(`/projects/${PROJECT_ID}/database-provisions/${id}`, { token });
    if (status.statusRaw === 'RUNNING' || status.status === '可用') return status;
    if (status.statusRaw === 'FAILED' || status.status === '创建失败') return status;
    await new Promise((r) => setTimeout(r, 8000));
  }
  throw new Error('provision timeout');
}

async function waitDeployment(token, deploymentId, timeoutMs = 240_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const dep = await api(`/deployments/${deploymentId}`, { token });
    if (['SUCCESS', 'FAILED', 'CANCELLED'].includes(dep.status)) return dep;
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error('deployment timeout');
}

const token = await login();
const prisma = new PrismaClient();

try {
  const readiness = await api('/providers/aliyun/readiness', { token });
  log(
    'readiness endpoint',
    readiness.provider === 'ALIYUN',
    `configured=${readiness.credentialsConfigured} blocked=${readiness.rdsCreateBlocked}`,
  );

  const accounts = await api('/provider-accounts', { token });
  const dns = (accounts || []).find((a) => a.provider?.type === 'ALIYUN_DNS');
  if (dns) {
    try {
      await api(`/provider-accounts/${dns.id}/capabilities`, { token });
      log('DNS blocked for RDS capabilities', false, 'unexpected success');
    } catch (err) {
      log(
        'DNS blocked for RDS capabilities',
        err.status === 400,
        err.body?.code || err.message,
      );
    }
  } else {
    log('DNS blocked for RDS capabilities', true, 'no DNS account');
  }

  if (!CONFIRM_BILLING) {
    console.log('\nDry-run only. Pass --confirm-billing to create a real billable RDS.');
    if (readiness.rdsCreateBlocked) {
      log('create gated', true, 'RDS create blocked until permissions ready');
    } else {
      log('create ready', true, 'permissions look ready; re-run with --confirm-billing');
    }
  } else if (readiness.rdsCreateBlocked) {
    log(
      'billing create blocked by readiness',
      false,
      `rds=${readiness.capabilities?.rds?.status}`,
    );
    console.log('\nStop: fix ALIYUN ProviderAccount RAM permissions, then re-check.');
    process.exitCode = 1;
  } else {
    const listed = await api(`/projects/${PROJECT_ID}/database-connections`, { token });
    for (const conn of listed.connections || []) {
      try {
        await api(`/projects/${PROJECT_ID}/database-connections/${conn.id}`, {
          method: 'DELETE',
          token,
        });
      } catch {
        // ignore
      }
    }

    const webBefore = await api(`/projects/${PROJECT_ID}/units/${WEB_UNIT}/config-requirements`, {
      token,
    });
    const apiBefore = await api(`/projects/${PROJECT_ID}/units/${API_UNIT}/config-requirements`, {
      token,
    });
    const webRev = webBefore.summary?.configRevision ?? 0;
    const apiRev = apiBefore.summary?.configRevision ?? 0;
    const options = await api(`/projects/${PROJECT_ID}/database-provisions/options`, { token });

    const first = await api(`/projects/${PROJECT_ID}/database-provisions`, {
      method: 'POST',
      token,
      body: {
        tier: 'DEV',
        region: options.suggestedRegion,
        databaseName: options.suggestedDatabaseName,
        unitIds: [API_UNIT],
        confirmBilling: true,
        confirmReplaceManual: true,
        serverInstanceId: SERVER_ID,
      },
    });
    log('create accepted', Boolean(first.id), `id=${first.id}`);

    const finished = await waitProvision(token, first.id);
    log(
      'provision finished',
      finished.statusRaw === 'RUNNING' || finished.status === '可用',
      `status=${finished.status} phase=${finished.phase}`,
    );

    if (finished.statusRaw === 'RUNNING' || finished.status === '可用') {
      const apiAfter = await api(`/projects/${PROJECT_ID}/units/${API_UNIT}/config-requirements`, {
        token,
      });
      const dbReq = apiAfter.requirements.find((r) => r.key === 'DATABASE_URL');
      log(
        'DATABASE_URL bound',
        dbReq?.configured === true && apiAfter.summary.configRevision > apiRev,
        `rev ${apiRev}->${apiAfter.summary.configRevision}`,
      );
      const webAfter = await api(`/projects/${PROJECT_ID}/units/${WEB_UNIT}/config-requirements`, {
        token,
      });
      log(
        'Web unaffected',
        webAfter.summary.configRevision === webRev,
        `webRev=${webAfter.summary.configRevision}`,
      );

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
      const dep = await waitDeployment(token, deployment.id);
      log('redeploy API', dep.status === 'SUCCESS', `status=${dep.status}`);
      if (dep.status === 'SUCCESS') {
        await new Promise((r) => setTimeout(r, 4000));
        const check = await fetch(
          process.env.E2E_API_URL || 'https://api-launchos.zsaos.com/db-check',
        ).then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) }));
        log(
          '/db-check',
          check.body?.databaseConnected === true,
          `connected=${check.body?.databaseConnected}`,
        );
        const webHttp = await fetch(
          process.env.E2E_WEB_URL || 'https://web-launchos.zsaos.com',
        ).then((res) => res.status);
        log('Web HTTPS', webHttp === 200, `status=${webHttp}`);
      }

      const resource = await prisma.cloudResource.findUnique({ where: { id: first.id } });
      const maskedId = resource?.providerResourceId
        ? `${String(resource.providerResourceId).slice(0, 4)}***`
        : 'none';
      console.log(
        `resource created providerResourceId=${maskedId} status=${resource?.status} (NOT auto-deleted)`,
      );
    }
  }
} finally {
  await prisma.$disconnect();
}

const failed = results.filter((item) => !item.ok);
console.log(`\nSummary: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exitCode = 1;
