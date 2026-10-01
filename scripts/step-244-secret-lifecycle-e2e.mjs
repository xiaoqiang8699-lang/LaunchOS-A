/**
 * Step 24.4 — Secret lifecycle & security E2E (no secret plaintext in output).
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const { PrismaClient } = require(resolve(ROOT, 'packages/database/generated/client'));

const API = process.env.API_BASE || 'http://localhost:3001/api/v1';
const PROJECT_ID = process.env.E2E_PROJECT_ID || 'cmu3j24mv0001ri7wcsoa30hj';
const WEB_UNIT = process.env.E2E_WEB_UNIT || 'cmu3j27340007ri7wcno1xrai';
const API_UNIT = process.env.E2E_API_UNIT || 'cmu3j272x0005ri7wlxlbajeu';

const JWT_ROTATE = process.env.E2E_JWT_ROTATE || 'e2e244jwtrotate-token-xk9';
const SENTRY_A = process.env.E2E_SENTRY_A || 'e2e244sentry-value-alpha';
const SENTRY_B = process.env.E2E_SENTRY_B || 'e2e244sentry-value-beta';

const FORBIDDEN = [JWT_ROTATE, SENTRY_A, SENTRY_B];

const results = [];
const log = (step, ok, detail) => {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step}: ${detail}`);
};

function assertNoPlaintext(payload) {
  const text = JSON.stringify(payload);
  for (const needle of FORBIDDEN) {
    if (text.includes(needle)) {
      throw new Error(`plaintext leak detected: ${needle.slice(0, 8)}...`);
    }
  }
}

async function api(path, { method = 'GET', token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const res = await fetch(`${API}${path}`, { method, headers, body });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(json?.message || res.statusText);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  assertNoPlaintext(json);
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

function reqByKey(payload, key) {
  return payload.requirements.find((item) => item.key === key);
}

async function main() {
  const token = await login();
  const prisma = new PrismaClient();

  try {
    const webBefore = await api(`/projects/${PROJECT_ID}/units/${WEB_UNIT}/config-requirements`, { token });
    const apiBefore = await api(`/projects/${PROJECT_ID}/units/${API_UNIT}/config-requirements`, { token });
    const webRevBefore = webBefore.summary?.configRevision ?? 0;
    const apiRevBefore = apiBefore.summary?.configRevision ?? 0;

    await api(`/projects/${PROJECT_ID}/units/${API_UNIT}/config/JWT_SECRET`, {
      method: 'PUT',
      token,
      body: { value: JWT_ROTATE },
    });
    const apiAfterRotate = await api(`/projects/${PROJECT_ID}/units/${API_UNIT}/config-requirements`, { token });
    const jwtReq = reqByKey(apiAfterRotate, 'JWT_SECRET');
    log(
      'JWT rotation dirty API',
      apiAfterRotate.summary.configRevision > apiRevBefore && jwtReq?.needsRedeploy === true,
      `rev ${apiRevBefore}->${apiAfterRotate.summary.configRevision} needsRedeploy=${jwtReq?.needsRedeploy}`,
    );

    const webAfterJwt = await api(`/projects/${PROJECT_ID}/units/${WEB_UNIT}/config-requirements`, { token });
    log(
      'Web unaffected by JWT rotation',
      webAfterJwt.summary.configRevision === webRevBefore,
      `web rev stayed ${webRevBefore}`,
    );

    await api(`/projects/${PROJECT_ID}/config/SENTRY_DSN`, {
      method: 'PUT',
      token,
      body: { value: SENTRY_A },
    });
    const sharedAfter = await api(`/projects/${PROJECT_ID}/config`, { token });
    const sentry = sharedAfter.configs.find((item) => item.key === 'SENTRY_DSN');
    const webPending = sentry?.unitApplyStatuses?.find((u) => u.id === WEB_UNIT)?.applyStatus;
    const apiPending = sentry?.unitApplyStatuses?.find((u) => u.id === API_UNIT)?.applyStatus;
    log(
      'Shared SENTRY both pending',
      webPending === 'pending' && apiPending === 'pending',
      `web=${webPending} api=${apiPending}`,
    );

    await api(`/projects/${PROJECT_ID}/config/SENTRY_DSN`, {
      method: 'PUT',
      token,
      body: { value: SENTRY_B },
    });
    const sharedB = await api(`/projects/${PROJECT_ID}/config`, { token });
    const sentryB = sharedB.configs.find((item) => item.key === 'SENTRY_DSN');

    await api(`/projects/${PROJECT_ID}/units/${API_UNIT}/config/JWT_SECRET/rotation-policy`, {
      method: 'PATCH',
      token,
      body: { rotationIntervalDays: 30 },
    });
    const apiUnitRow = await prisma.deployableUnit.findUnique({
      where: { id: API_UNIT },
      select: { configRevision: true },
    });
    await prisma.serviceInstance.updateMany({
      where: { deployableUnitId: API_UNIT, status: 'RUNNING' },
      data: { configRevision: apiUnitRow?.configRevision ?? 0 },
    });
    const overdueAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await prisma.runtimeConfigValue.updateMany({
      where: {
        projectId: PROJECT_ID,
        key: 'JWT_SECRET',
        scopeType: 'UNIT',
        scopeId: API_UNIT,
      },
      data: { lastRotatedAt: overdueAt },
    });
    const overduePayload = await api(`/projects/${PROJECT_ID}/units/${API_UNIT}/config-requirements`, { token });
    const overdueReq = reqByKey(overduePayload, 'JWT_SECRET');
    log(
      'Overdue reminder only',
      overdueReq?.rotationStatus === 'OVERDUE',
      `status=${overdueReq?.rotationStatus}`,
    );

    const auditBefore = await api(`/projects/${PROJECT_ID}/config/audit?key=JWT_SECRET`, { token });
    const actions = new Set(auditBefore.events.map((e) => e.action));
    log(
      'Audit has CREATE/UPDATE',
      actions.has('CREATED') || actions.has('UPDATED'),
      `actions=${[...actions].join(',')}`,
    );

    const impact = await api(
      `/projects/${PROJECT_ID}/units/${API_UNIT}/config/JWT_SECRET/delete-impact`,
      { token },
    );
    log('Delete impact lists API unit', impact.affectedUnits?.some((u) => u.id === API_UNIT), impact.message);

    await api(`/projects/${PROJECT_ID}/units/${API_UNIT}/config/JWT_SECRET`, {
      method: 'DELETE',
      token,
    });
    const auditAfterDelete = await api(`/projects/${PROJECT_ID}/config/audit?key=JWT_SECRET`, { token });
    log(
      'Audit DELETE recorded',
      auditAfterDelete.events.some((e) => e.action === 'DELETED'),
      `count=${auditAfterDelete.events.length}`,
    );

    await api(`/projects/${PROJECT_ID}/units/${API_UNIT}/config/JWT_SECRET`, {
      method: 'PUT',
      token,
      body: { value: JWT_ROTATE },
    });

    log(
      'Shared per-unit statuses present',
      Boolean(sentryB?.unitApplyStatuses?.length),
      `units=${sentryB?.unitApplyStatuses?.length ?? 0}`,
    );
  } finally {
    await prisma.$disconnect();
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\nSummary: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
