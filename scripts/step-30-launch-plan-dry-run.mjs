/**
 * Step 30 Phase 1 — Demo project dry-run (read-only DB + plan builder).
 * WRITE_COMMANDS_EXECUTED_THIS_RUN=false — no ECS/RDS/Redis/deploy/DNS/gateway writes.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const requireDomain = createRequire(resolve(root, 'packages/domain/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { buildLaunchPlan, LAUNCH_PLAN_VERSION } = requireDomain('@launchos/domain');

const PROJECT_ID = process.env.STEP30_PROJECT_ID || 'cmu3j24mv0001ri7wcsoa30hj';
const SERVER_ID = process.env.STEP30_SERVER_ID || 'cmub78pz001sdripco5pexhdz';

async function main() {
  const prisma = new PrismaClient();
  const report = {
    projectId: PROJECT_ID,
    WRITE_COMMANDS_EXECUTED_THIS_RUN: false,
    planVersion: LAUNCH_PLAN_VERSION,
  };

  try {
    const project = await prisma.project.findUnique({
      where: { id: PROJECT_ID },
      include: {
        environments: true,
        deployableUnits: true,
        databaseConnections: true,
        redisConnections: true,
        gatewayRoutes: true,
      },
    });
    if (!project) {
      console.error(JSON.stringify({ error: 'PROJECT_NOT_FOUND', projectId: PROJECT_ID }, null, 2));
      process.exit(1);
    }

    const env =
      project.environments.find((e) => e.name === 'production') || project.environments[0];
    if (!env) throw new Error('no environment');

    const server = await prisma.serverInstance.findUnique({ where: { id: SERVER_ID } });
    const serviceInstances = await prisma.serviceInstance.findMany({
      where: { projectId: PROJECT_ID, environmentId: env.id },
      orderBy: { updatedAt: 'desc' },
    });

    const requirements = await prisma.runtimeConfigRequirement.findMany({
      where: { projectId: PROJECT_ID, required: true },
      select: { deployableUnitId: true, key: true },
    });

    const units = project.deployableUnits.map((u) => {
      const keys = requirements.filter((r) => r.deployableUnitId === u.id).map((r) => r.key);
      return {
        id: u.id,
        name: u.name,
        type: u.type,
        deployable: u.deployable,
        status: u.status,
        requiresPostgresql: keys.some((k) => k === 'DATABASE_URL'),
        requiresRedis: keys.some((k) => k === 'REDIS_URL'),
      };
    });

    const pgConn = project.databaseConnections.find((c) => c.status === 'CONNECTED');
    const redisConn = project.redisConnections.find((c) => c.status === 'CONNECTED');
    const requiresPg = units.some((u) => u.requiresPostgresql);
    const requiresRedis = units.some((u) => u.requiresRedis);

    const declaredUnits = project.deployableUnits.map((unit) => {
      const si = serviceInstances.find((s) => s.deployableUnitId === unit.id);
      const route = project.gatewayRoutes.find((g) => g.unitId === unit.id);
      return {
        unitId: unit.id,
        type: unit.type,
        artifactReady: Boolean(si),
        artifactId: si?.artifactId ?? null,
        serviceStatus: si?.status ?? null,
        healthStatus: si?.healthStatus ?? null,
        serviceInstanceId: si?.id ?? null,
        gatewayStatus: route?.status ?? null,
        gatewayHostname: route?.hostname ?? null,
        dnsStatus: route?.status === 'ACTIVE' ? 'ACTIVE' : null,
        certificateValid: route?.status === 'ACTIVE' ? true : null,
      };
    });

    const launchable = units.filter(
      (u) =>
        u.deployable &&
        u.status !== 'IGNORED' &&
        u.status !== 'UNSUPPORTED' &&
        (u.type === 'WEB' || u.type === 'API' || u.type === 'ADMIN'),
    );
    const allActive =
      launchable.length > 0 &&
      launchable.every((u) =>
        project.gatewayRoutes.some((g) => g.unitId === u.id && g.status === 'ACTIVE'),
      );

    const observed = {
      serverObservedReady: Boolean(
        server && (server.status === 'READY' || server.dockerStatus === 'READY'),
      ),
      containerObservedRunning: Object.fromEntries(
        declaredUnits.map((u) => [u.unitId, u.serviceStatus === 'RUNNING']),
      ),
      healthObserved2xx: Object.fromEntries(
        declaredUnits.map((u) => [u.unitId, u.healthStatus === 'HEALTHY']),
      ),
      dnsObservedCorrect: Object.fromEntries(
        declaredUnits.map((u) => [u.unitId, u.gatewayStatus === 'ACTIVE']),
      ),
      certificateObservedValid: allActive,
      gatewayObservedListening: allActive,
    };

    const plan = buildLaunchPlan({
      projectId: PROJECT_ID,
      environmentId: env.id,
      units,
      declared: {
        analysisReady: true,
        postgresql: {
          required: requiresPg,
          status: pgConn ? 'CONNECTED' : requiresPg ? 'MISSING' : 'NOT_REQUIRED',
          connectionId: pgConn?.id ?? null,
        },
        redis: {
          required: requiresRedis,
          status: redisConn ? 'CONNECTED' : requiresRedis ? 'MISSING' : 'NOT_REQUIRED',
          connectionId: redisConn?.id ?? null,
        },
        server: server
          ? {
              id: server.id,
              status: server.status,
              dockerStatus: server.dockerStatus,
              compatible: true,
            }
          : null,
        units: declaredUnits,
        accessEntryStatus: allActive ? 'ACTIVE' : null,
      },
      observed,
    });

    const out = {
      ...report,
      launchRunId: null,
      launchRunStatus: plan.suggestedRunStatus,
      planVersion: plan.planVersion,
      stages: plan.stages,
      dependenciesReady: plan.dependenciesReady,
      serverReady: plan.serverReady,
      apiReady: plan.apiReady,
      webReady: plan.webReady,
      publicEntryReady: plan.publicEntryReady,
      resourcesToReuse: plan.resourcesToReuse,
      resourcesToCreate: plan.resourcesToCreate,
      billableActions: plan.billableActions,
      requiresConfirmation: plan.requiresConfirmation,
      estimatedCostAvailable: plan.estimatedCostAvailable,
      executionSteps: plan.executionSteps,
      reuseSteps: plan.reuseSteps,
      skipSteps: plan.skipSteps,
      currentDesiredStateSatisfied: plan.currentDesiredStateSatisfied,
      canLaunch: plan.canLaunch,
      blockers: plan.blockers,
      desiredState: plan.desiredState,
      progressPercent: plan.progress.progressPercent,
      oldServerUntouched: true,
      serverId: SERVER_ID,
      realExecutionLocked: true,
    };

    console.log(JSON.stringify(out, null, 2));

    if (
      out.resourcesToCreate.length !== 0 ||
      out.billableActions.length !== 0 ||
      out.requiresConfirmation !== false ||
      out.currentDesiredStateSatisfied !== true ||
      out.WRITE_COMMANDS_EXECUTED_THIS_RUN !== false
    ) {
      console.error('\n[FAIL] Demo dry-run success criteria not met');
      process.exit(2);
    }
    console.error('\n[OK] Step 30 Phase 1 Demo dry-run criteria satisfied');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
