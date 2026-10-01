import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const { PrismaClient } = require(resolve(ROOT, 'packages/database/generated/client'));
const { RuntimeConfigResolver } = require(resolve(ROOT, 'packages/deployment/dist/index.js'));

const API = 'http://localhost:3001/api/v1';
const PROJECT_ID = 'cmu3j24mv0001ri7wcsoa30hj';
const WEB_UNIT = 'cmu3j27340007ri7wcno1xrai';
const API_UNIT = 'cmu3j272x0005ri7wlxlbajeu';

async function login() {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'xiaoqiang8699@gmail.com',
      password: 'Launchos123!',
    }),
  });
  const data = await res.json();
  return data.accessToken;
}

async function unitConfig(token, unitId) {
  const res = await fetch(
    `${API}/projects/${PROJECT_ID}/units/${unitId}/config-requirements`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return res.json();
}

function pick(reqs, key) {
  return reqs.requirements.find((r) => r.key === key);
}

const token = await login();
const web = await unitConfig(token, WEB_UNIT);
const api = await unitConfig(token, API_UNIT);
const cfgCheck = await fetch('https://api-launchos.zsaos.com/config-check').then((r) => r.json());
const webHttps = await fetch('https://web-launchos.zsaos.com/').then((r) => r.status);

const prisma = new PrismaClient();
const [webUnit, apiUnit, project, webSvc, apiSvc] = await Promise.all([
  prisma.deployableUnit.findUnique({ where: { id: WEB_UNIT }, select: { configRevision: true } }),
  prisma.deployableUnit.findUnique({ where: { id: API_UNIT }, select: { configRevision: true } }),
  prisma.project.findUnique({ where: { id: PROJECT_ID }, select: { sharedConfigRevision: true } }),
  prisma.serviceInstance.findFirst({
    where: { deployableUnitId: WEB_UNIT, status: 'RUNNING' },
    orderBy: { updatedAt: 'desc' },
    select: { configRevision: true, status: true, healthStatus: true },
  }),
  prisma.serviceInstance.findFirst({
    where: { deployableUnitId: API_UNIT, status: 'RUNNING' },
    orderBy: { updatedAt: 'desc' },
    select: { configRevision: true, status: true, healthStatus: true },
  }),
]);
const resolver = new RuntimeConfigResolver(prisma);
const webRuntime = await resolver.resolve({
  projectId: PROJECT_ID,
  deployableUnitId: WEB_UNIT,
  phase: 'RUNTIME',
});
const webBuild = await resolver.resolve({
  projectId: PROJECT_ID,
  deployableUnitId: WEB_UNIT,
  phase: 'BUILD',
});
await prisma.$disconnect();

console.log(
  JSON.stringify(
    {
      projectSharedConfigRevision: project?.sharedConfigRevision,
      web: {
        revision: webUnit?.configRevision,
        serviceRevision: webSvc?.configRevision,
        service: webSvc,
        sentry: pick(web, 'SENTRY_DSN'),
        databaseReq: pick(web, 'DATABASE_URL'),
        resolverRuntimeKeys: webRuntime.keys,
        resolverBuildKeys: webBuild.keys,
        https: webHttps,
      },
      api: {
        revision: apiUnit?.configRevision,
        serviceRevision: apiSvc?.configRevision,
        service: apiSvc,
        sentry: pick(api, 'SENTRY_DSN'),
        database: pick(api, 'DATABASE_URL'),
      },
      liveConfigCheck: cfgCheck,
    },
    null,
    2,
  ),
);
