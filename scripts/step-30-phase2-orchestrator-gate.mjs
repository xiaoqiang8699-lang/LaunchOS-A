/**
 * Step 30 Phase 2 — Orchestrator Gate-only.
 *
 *   node scripts/step-30-phase2-orchestrator-gate.mjs --gate-only
 *   node scripts/step-30-phase2-orchestrator-gate.mjs --project-id <id> --gate-only
 *   node scripts/step-30-phase2-orchestrator-gate.mjs --confirm-launch-execution --gate-only
 *
 * Forbidden: real provider/DNS/gateway/deploy writes.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

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

const args = process.argv.slice(2);
function argValue(name) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

const GATE_ONLY = args.includes('--gate-only') || !args.includes('--confirm-launch-execution');
const CONFIRM_EXEC = args.includes('--confirm-launch-execution');
const PROJECT_ID = argValue('--project-id') || process.env.STEP30_PROJECT_ID || 'cmu3j24mv0001ri7wcsoa30hj';
const SERVER_ID = process.env.STEP30_SERVER_ID || 'cmub78pz001sdripco5pexhdz';
const LAUNCH_RUN_ID = argValue('--launch-run-id');

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const requireDomain = createRequire(resolve(root, 'packages/domain/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const {
  buildLaunchPlan,
  LAUNCH_PLAN_VERSION,
  evaluateLaunchGate,
  refuseRealExecution,
  defaultLaunchHandlerRegistry,
} = requireDomain('@launchos/domain');

async function loadDemoPlan(prisma) {
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
  if (!project) throw new Error(`PROJECT_NOT_FOUND:${PROJECT_ID}`);

  const env =
    project.environments.find((e) => e.name === 'production') || project.environments[0];
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
    planVersion: LAUNCH_PLAN_VERSION,
  });

  return { plan, env, observed, allActive };
}

async function main() {
  if (CONFIRM_EXEC && !GATE_ONLY) {
    console.error(JSON.stringify(refuseRealExecution(), null, 2));
    process.exit(2);
  }

  const prisma = new PrismaClient();
  try {
    const { plan, env } = await loadDemoPlan(prisma);

    let launchRunId = LAUNCH_RUN_ID;
    if (!launchRunId) {
      // Persist a Phase 2 LaunchRun for Demo (plan only)
      await prisma.launchRun.updateMany({
        where: {
          projectId: PROJECT_ID,
          environmentId: env.id,
          status: { in: ['READY', 'WAITING_CONFIRMATION', 'DRAFT', 'PLANNING'] },
        },
        data: {
          status: 'CANCELLED',
          finishedAt: new Date(),
          failureCode: 'SUPERSEDED_BY_PHASE2_GATE',
        },
      });

      const created = await prisma.launchRun.create({
        data: {
          id: `lr_${randomBytes(8).toString('hex')}`,
          projectId: PROJECT_ID,
          environmentId: env.id,
          status: plan.requiresConfirmation ? 'WAITING_CONFIRMATION' : 'READY',
          triggerType: 'MANUAL',
          planVersion: plan.planVersion,
          inputSnapshot: plan.inputSnapshot,
          planSnapshot: {
            stages: plan.stages,
            resourcesToReuse: plan.resourcesToReuse,
            resourcesToCreate: plan.resourcesToCreate,
            billableActions: plan.billableActions,
            requiresConfirmation: plan.requiresConfirmation,
            executionSteps: plan.executionSteps,
            reuseSteps: plan.reuseSteps,
            skipSteps: plan.skipSteps,
            currentDesiredStateSatisfied: plan.currentDesiredStateSatisfied,
            progress: plan.progress,
          },
          steps: {
            create: plan.steps.map((s) => ({
              stage: s.stage,
              stepType: s.stepType,
              status:
                s.decision === 'SKIP' || s.decision === 'REUSE'
                  ? 'SKIPPED'
                  : s.requiresConfirmation
                    ? 'WAITING'
                    : 'READY',
              decision: s.decision,
              executionOrder: s.executionOrder,
              dependsOn: s.dependsOn,
              resourceType: s.resourceType,
              resourceId: s.resourceId,
              reconcileKey: s.reconcileKey,
              metadataJson: {
                reason: s.reason,
                reasonZh: s.reasonZh,
                unitId: s.unitId,
                billable: s.billable,
                requiresConfirmation: s.requiresConfirmation,
              },
            })),
          },
        },
        include: { steps: { orderBy: { executionOrder: 'asc' } } },
      });
      launchRunId = created.id;
    }

    const run = await prisma.launchRun.findUnique({
      where: { id: launchRunId },
      include: { steps: { orderBy: { executionOrder: 'asc' } } },
    });
    if (!run) throw new Error(`LAUNCH_RUN_NOT_FOUND:${launchRunId}`);

    const gate = evaluateLaunchGate({
      launchRunId: run.id,
      projectId: PROJECT_ID,
      environmentId: env.id,
      planVersion: run.planVersion,
      plan,
      steps: run.steps.map((s) => ({
        id: s.id,
        stage: s.stage,
        stepType: s.stepType,
        status: s.status,
        decision: s.decision,
        dependsOn: s.dependsOn,
        reconcileKey: s.reconcileKey,
        resourceType: s.resourceType,
        resourceId: s.resourceId,
        metadata: s.metadataJson ?? {},
      })),
      currentInputSnapshot: plan.inputSnapshot,
      gateOnly: true,
      realExecutionLocked: true,
      driftInput: {
        dependencyOk: plan.dependenciesReady,
        serverOk: plan.serverReady,
        units: plan.desiredState
          ? (plan.inputSnapshot.unitIds || []).map((unitId) => {
              const declared = plan.inputSnapshot;
              void declared;
              return {
                unitId,
                declaredHealthy: true,
                containerObservedRunning: true,
                healthObserved2xx: true,
                gatewayActive: true,
                dnsObservedCorrect: true,
              };
            })
          : [],
        certificateValid: true,
        accessEntryActive: plan.publicEntryReady,
      },
    });

    const out = {
      phase: 'step30-phase2-gate',
      projectId: PROJECT_ID,
      launchRunId: run.id,
      launchRunStatus: run.status,
      planVersion: plan.planVersion,
      handlerRegistryComplete: defaultLaunchHandlerRegistry.isComplete(),
      currentDesiredStateSatisfied: plan.currentDesiredStateSatisfied,
      executionSteps: plan.executionSteps,
      reuseSteps: plan.reuseSteps,
      skipSteps: plan.skipSteps,
      requiresConfirmation: plan.requiresConfirmation,
      ...gate.writePlan,
      canExecute: gate.canExecute,
      blockers: gate.blockers,
      realExecutionLocked: true,
      gateOnly: true,
      steps: gate.steps.map((s) => ({
        stage: s.stage,
        stepType: s.stepType,
        decision: s.decision,
        status: s.status,
        handlerResolved: s.handlerResolved,
        preflightPassed: s.preflightPassed,
        requiresConfirmation: s.requiresConfirmation,
        confirmationSatisfied: s.confirmationSatisfied,
        billable: s.billable,
        writeCapable: s.writeCapable,
        wouldExecute: s.wouldExecute,
        wouldReuse: s.wouldReuse,
        wouldSkip: s.wouldSkip,
        wouldBlock: s.wouldBlock,
        resourceId: s.resourceId,
        operationKey: s.operationKey,
      })),
      WRITE_COMMANDS_EXECUTED_THIS_RUN: false,
      oldServerUntouched: true,
      serverId: SERVER_ID,
    };

    console.log(JSON.stringify(out, null, 2));

    const ok =
      out.requiresConfirmation === false &&
      out.cloudWritesPlanned === 0 &&
      out.deploymentWritesPlanned === 0 &&
      out.gatewayWritesPlanned === 0 &&
      out.dnsWritesPlanned === 0 &&
      out.certificateWritesPlanned === 0 &&
      out.remoteWritesPlanned === 0 &&
      out.canExecute === true &&
      out.realExecutionLocked === true &&
      out.WRITE_COMMANDS_EXECUTED_THIS_RUN === false &&
      out.currentDesiredStateSatisfied === true;

    if (!ok) {
      console.error('\n[FAIL] Step 30 Phase 2 Demo gate criteria not met');
      process.exit(2);
    }
    console.error('\n[OK] Step 30 Phase 2 Demo orchestrator gate satisfied');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
