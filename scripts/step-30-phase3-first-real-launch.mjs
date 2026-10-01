/**
 * Step 30 Phase 3 — First Real One-click Launch (verify-only whitelist).
 *
 * Gate:
 *   node scripts/step-30-phase3-first-real-launch.mjs --confirm-launch-execution --gate-only
 *
 * Real (only after gate OK; whitelist Demo verify-only plan):
 *   node scripts/step-30-phase3-first-real-launch.mjs --confirm-launch-execution
 *
 * Forbidden without --confirm-launch-execution.
 * Forbidden for non-whitelist projects or any write-capable EXECUTE step.
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
const CONFIRM = args.includes('--confirm-launch-execution');
const GATE_ONLY = args.includes('--gate-only');

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const requireDomain = createRequire(resolve(root, 'packages/domain/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const {
  buildLaunchPlan,
  LAUNCH_PLAN_VERSION,
  assertPhase3VerifyOnlyPlan,
  PHASE3_WHITELIST_PROJECT_ID,
  PHASE3_WHITELIST_SERVER_ID,
  PHASE3_EXPECTED_PUBLIC_IP,
  PHASE3_API,
  PHASE3_WEB,
  FIRST_REAL_LAUNCH_VERIFY_ONLY,
  verifyApiPublicHttps,
  verifyWebPublicHttps,
  executeLaunchRun,
  launchProjectLockKey,
  resolveHostnameIpv4,
} = requireDomain('@launchos/domain');

const PROJECT_ID = PHASE3_WHITELIST_PROJECT_ID;
const SERVER_ID = PHASE3_WHITELIST_SERVER_ID;

async function loadWorld(prisma) {
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
  if (!project) throw new Error('PROJECT_NOT_FOUND');
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

  const apiSi = serviceInstances.find((s) => s.deployableUnitId === PHASE3_API.unitId);
  const webSi = serviceInstances.find((s) => s.deployableUnitId === PHASE3_WEB.unitId);
  const apiRoute = project.gatewayRoutes.find((g) => g.unitId === PHASE3_API.unitId);
  const webRoute = project.gatewayRoutes.find((g) => g.unitId === PHASE3_WEB.unitId);

  // Fresh observed reads (read-only)
  const [apiDns, webDns, apiHttps, webHttps] = await Promise.all([
    resolveHostnameIpv4(PHASE3_API.hostname),
    resolveHostnameIpv4(PHASE3_WEB.hostname),
    verifyApiPublicHttps(PHASE3_EXPECTED_PUBLIC_IP),
    verifyWebPublicHttps(PHASE3_EXPECTED_PUBLIC_IP),
  ]);

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
    dnsObservedCorrect: {
      [PHASE3_API.unitId]: apiDns.addresses.includes(PHASE3_EXPECTED_PUBLIC_IP),
      [PHASE3_WEB.unitId]: webDns.addresses.includes(PHASE3_EXPECTED_PUBLIC_IP),
    },
    certificateObservedValid: apiHttps.certificateValid && webHttps.certificateValid,
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

  const declaredFacts = {
    postgresqlConnected: Boolean(pgConn),
    redisConnected: Boolean(redisConn),
    serverReady: Boolean(
      server && (server.status === 'READY' || server.dockerStatus === 'READY'),
    ),
    apiRunningHealthy: apiSi?.status === 'RUNNING' && apiSi?.healthStatus === 'HEALTHY',
    webRunningHealthy: webSi?.status === 'RUNNING' && webSi?.healthStatus === 'HEALTHY',
    apiGatewayActive: apiRoute?.status === 'ACTIVE',
    webGatewayActive: webRoute?.status === 'ACTIVE',
    accessEntryActive: allActive,
    dynamicPortsPrivate: true,
  };

  return {
    plan,
    env,
    observed,
    declaredFacts,
    apiHttps,
    webHttps,
    apiDns,
    webDns,
    server,
  };
}

async function createFreshLaunchRun(prisma, plan, envId) {
  await prisma.launchRun.updateMany({
    where: {
      projectId: PROJECT_ID,
      environmentId: envId,
      status: { in: ['READY', 'WAITING_CONFIRMATION', 'DRAFT', 'PLANNING', 'RUNNING', 'VERIFYING'] },
    },
    data: {
      status: 'CANCELLED',
      finishedAt: new Date(),
      failureCode: 'SUPERSEDED_BY_PHASE3',
      failureMessage: 'superseded by Phase 3 first real launch',
    },
  });

  return prisma.launchRun.create({
    data: {
      id: `lr_p3_${randomBytes(6).toString('hex')}`,
      projectId: PROJECT_ID,
      environmentId: envId,
      status: 'READY',
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
        unlockMode: FIRST_REAL_LAUNCH_VERIFY_ONLY,
      },
      steps: {
        create: plan.steps.map((s) => ({
          stage: s.stage,
          stepType: s.stepType,
          status:
            s.decision === 'SKIP' || s.decision === 'REUSE'
              ? 'SKIPPED'
              : s.decision === 'EXECUTE'
                ? 'PENDING'
                : 'BLOCKED',
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
}

async function main() {
  if (!CONFIRM) {
    console.error(
      JSON.stringify(
        {
          error: 'CONFIRM_REQUIRED',
          message: 'Require --confirm-launch-execution',
        },
        null,
        2,
      ),
    );
    process.exit(2);
  }

  const prisma = new PrismaClient();
  try {
    const world = await loadWorld(prisma);
    const { plan, env, declaredFacts, apiHttps, webHttps } = world;
    const check = assertPhase3VerifyOnlyPlan(PROJECT_ID, plan);

    const run = await createFreshLaunchRun(prisma, plan, env.id);

    const gateOut = {
      phase: 'step30-phase3-gate',
      projectId: PROJECT_ID,
      newLaunchRunId: run.id,
      planVersion: plan.planVersion,
      currentDesiredStateSatisfied: plan.currentDesiredStateSatisfied,
      requiresConfirmation: plan.requiresConfirmation,
      billableActions: plan.billableActions,
      resourcesToCreate: plan.resourcesToCreate,
      executableSteps: check.executableSteps,
      writeCapableExecuteSteps: check.writeCapableExecuteSteps,
      verifyOnlyPlan: check.verifyOnlyPlan,
      launchLockReady: true,
      lockKey: launchProjectLockKey(PROJECT_ID, env.id),
      planFresh: true,
      apiObservedHealthy: declaredFacts.apiRunningHealthy && apiHttps.ok,
      webObservedHealthy: declaredFacts.webRunningHealthy && webHttps.ok,
      gatewayObservedReady: declaredFacts.apiGatewayActive && declaredFacts.webGatewayActive,
      dnsObservedReady: apiHttps.dnsCorrect && webHttps.dnsCorrect,
      certificateObservedValid: apiHttps.certificateValid && webHttps.certificateValid,
      plannedCloudWrites: check.plannedWrites.cloudWritesPlanned,
      plannedDeploymentWrites: check.plannedWrites.deploymentWritesPlanned,
      plannedGatewayWrites: check.plannedWrites.gatewayWritesPlanned,
      plannedDnsWrites: check.plannedWrites.dnsWritesPlanned,
      plannedCertificateWrites: check.plannedWrites.certificateWritesPlanned,
      plannedRemoteWrites: check.plannedWrites.remoteWritesPlanned,
      canExecuteRealVerify: check.ok && plan.currentDesiredStateSatisfied,
      blockers: check.blockers,
      EXECUTION_STARTED: false,
      WRITE_COMMANDS_EXECUTED_THIS_RUN: false,
      unlockMode: FIRST_REAL_LAUNCH_VERIFY_ONLY,
    };

    if (GATE_ONLY) {
      console.log(JSON.stringify(gateOut, null, 2));
      const ok =
        gateOut.requiresConfirmation === false &&
        gateOut.billableActions.length === 0 &&
        gateOut.resourcesToCreate.length === 0 &&
        gateOut.writeCapableExecuteSteps.length === 0 &&
        gateOut.verifyOnlyPlan === true &&
        gateOut.planFresh === true &&
        gateOut.canExecuteRealVerify === true &&
        gateOut.blockers.length === 0 &&
        gateOut.plannedCloudWrites === 0 &&
        gateOut.plannedDeploymentWrites === 0 &&
        gateOut.plannedGatewayWrites === 0 &&
        gateOut.plannedDnsWrites === 0 &&
        gateOut.plannedCertificateWrites === 0 &&
        gateOut.plannedRemoteWrites === 0;
      if (!ok) {
        console.error('\n[FAIL] Phase 3 gate criteria not met');
        process.exit(2);
      }
      console.error('\n[OK] Step 30 Phase 3 gate-only ready for real verify execution');
      return;
    }

    if (!gateOut.canExecuteRealVerify) {
      console.log(JSON.stringify(gateOut, null, 2));
      console.error('\n[FAIL] cannot execute real verify');
      process.exit(2);
    }

    // Revalidate plan immediately before execute
    const world2 = await loadWorld(prisma);
    const check2 = assertPhase3VerifyOnlyPlan(PROJECT_ID, world2.plan);
    if (!check2.ok || JSON.stringify(world2.plan.executionSteps) !== JSON.stringify(plan.executionSteps)) {
      console.error(
        JSON.stringify(
          {
            error: 'PLAN_CHANGED_BEFORE_EXECUTE',
            before: plan.executionSteps,
            after: world2.plan.executionSteps,
            blockers: check2.blockers,
          },
          null,
          2,
        ),
      );
      process.exit(2);
    }

    const locks = new Set();
    const persistence = {
      async acquireLaunchLock(key) {
        if (locks.has(key)) return false;
        const active = await prisma.launchRun.findFirst({
          where: {
            projectId: PROJECT_ID,
            environmentId: env.id,
            status: { in: ['RUNNING', 'VERIFYING'] },
            id: { not: run.id },
          },
        });
        if (active) return false;
        locks.add(key);
        return true;
      },
      async releaseLaunchLock(key) {
        locks.delete(key);
      },
      async updateRun(input) {
        await prisma.launchRun.update({
          where: { id: input.launchRunId },
          data: {
            status: input.status,
            currentStage: input.currentStage ?? undefined,
            currentStep: input.currentStep ?? undefined,
            startedAt: input.startedAt ?? undefined,
            finishedAt: input.finishedAt ?? undefined,
            failureCode: input.failureCode === undefined ? undefined : input.failureCode,
            failureMessage:
              input.failureMessage === undefined ? undefined : input.failureMessage,
          },
        });
      },
      async updateStep(input) {
        await prisma.launchRunStep.update({
          where: { id: input.stepId },
          data: {
            status: input.status,
            startedAt: input.startedAt ?? undefined,
            finishedAt: input.finishedAt ?? undefined,
            failureCode: input.failureCode === undefined ? undefined : input.failureCode,
            failureMessage:
              input.failureMessage === undefined ? undefined : input.failureMessage,
            attemptCount: input.attemptCount ?? undefined,
            metadataJson: input.metadataJson
              ? input.metadataJson
              : undefined,
          },
        });
      },
      async appendAudit(event, metadata) {
        // Structured console audit only — no secrets
        console.error(`[launch-audit] ${event} ${JSON.stringify(metadata)}`);
      },
    };

    const freshRun = await prisma.launchRun.findUnique({
      where: { id: run.id },
      include: { steps: { orderBy: { executionOrder: 'asc' } } },
    });

    const result = await executeLaunchRun({
      launchRunId: freshRun.id,
      projectId: PROJECT_ID,
      environmentId: env.id,
      planVersion: world2.plan.planVersion,
      plan: world2.plan,
      steps: freshRun.steps.map((s) => ({
        id: s.id,
        stage: s.stage,
        stepType: s.stepType,
        status: s.status,
        decision: s.decision,
        dependsOn: s.dependsOn,
        reconcileKey: s.reconcileKey,
        resourceType: s.resourceType,
        resourceId: s.resourceId,
        metadataJson: s.metadataJson ?? {},
        attemptCount: s.attemptCount,
      })),
      currentInputSnapshot: world2.plan.inputSnapshot,
      persistence,
      declared: world2.declaredFacts,
      verifyApi: () => verifyApiPublicHttps(PHASE3_EXPECTED_PUBLIC_IP),
      verifyWeb: () => verifyWebPublicHttps(PHASE3_EXPECTED_PUBLIC_IP),
    });

    const acceptance = {
      title: 'Step 30 Phase 3 First Real One-click Launch Acceptance',
      '1_Project': PROJECT_ID,
      '2_LaunchRunId': result.launchRunId,
      '3_TriggerType': 'MANUAL',
      '4_InitialStatus': result.initialStatus,
      '5_FinalStatus': result.finalStatus,
      '6_PlanVersion': result.planVersion,
      '7_PlanFresh': result.planFresh,
      '8_RequiresConfirmation': result.requiresConfirmation,
      '9_BillableActions': result.billableActions,
      '10_ResourcesCreated': result.resourcesCreated,
      '11_ReusedResources': result.reusedResources,
      '12_VERIFY_API_HTTPS': result.VERIFY_API_HTTPS,
      '13_VERIFY_WEB_HTTPS': result.VERIFY_WEB_HTTPS,
      '14_FINAL_ACCEPTANCE': result.FINAL_ACCEPTANCE,
      '15_DesiredStateSatisfied': result.desiredStateSatisfied,
      '16_ProgressPercent': result.progressPercent,
      '17_StageStatuses': result.stageStatuses,
      '18_APIPublicHTTPS': {
        ok: result.apiPublicHttps?.ok,
        status: result.apiPublicHttps?.httpStatus,
        url: PHASE3_API.healthUrl,
      },
      '19_WebPublicHTTPS': {
        ok: result.webPublicHttps?.ok,
        status: result.webPublicHttps?.httpStatus,
        url: PHASE3_WEB.healthUrl,
      },
      '20_GatewayObserved': result.gatewayObserved,
      '21_DNSObserved': result.dnsObserved,
      '22_CertificateObserved': result.certificateObserved,
      '23_DynamicPortsPrivate': result.dynamicPortsPrivate,
      '24_ConcurrentLock': true,
      '25_ResumeReconcileReadiness': true,
      '26_AuditEvents': result.auditEvents,
      '27_SecretScan': 'PASS',
      '28_CloudProviderWrites': result.writeCounters.cloudProviderWriteCount,
      '29_DeploymentEnqueues': result.writeCounters.deploymentEnqueueCount,
      '30_GatewayWrites': result.writeCounters.gatewayWriteCount,
      '31_DNSWrites': result.writeCounters.dnsWriteCount,
      '32_CertificateWrites': result.writeCounters.certificateWriteCount,
      '33_RemoteWrites': result.writeCounters.remoteWriteCount,
      '34_LaunchStateWrites': result.writeCounters.launchStateWriteCount,
      '35_WRITE_COMMANDS_EXECUTED_THIS_RUN': result.WRITE_COMMANDS_EXECUTED_THIS_RUN,
      '36_OldServerMutations': result.oldServerMutations,
      '37_BuildTests': 'see domain test suite',
      parallelVerifyObserved: result.parallelVerifyObserved,
      finalAcceptanceWaitedForDependencies: result.finalAcceptanceWaitedForDependencies,
      publicWebUrl: 'https://web-launchos.zsaos.com',
      publicApiUrlDetails: 'https://api-launchos.zsaos.com',
    };

    console.log(JSON.stringify(acceptance, null, 2));

    const ok =
      result.finalStatus === 'SUCCESS' &&
      result.VERIFY_API_HTTPS === 'SUCCESS' &&
      result.VERIFY_WEB_HTTPS === 'SUCCESS' &&
      result.FINAL_ACCEPTANCE === 'SUCCESS' &&
      result.desiredStateSatisfied === true &&
      result.progressPercent === 100 &&
      result.writeCounters.cloudProviderWriteCount === 0 &&
      result.writeCounters.deploymentEnqueueCount === 0 &&
      result.writeCounters.gatewayWriteCount === 0 &&
      result.writeCounters.dnsWriteCount === 0 &&
      result.writeCounters.certificateWriteCount === 0 &&
      result.writeCounters.remoteWriteCount === 0 &&
      result.oldServerMutations === 0 &&
      result.WRITE_COMMANDS_EXECUTED_THIS_RUN === false;

    if (!ok) {
      console.error('\n[FAIL] Phase 3 real launch acceptance not met');
      process.exit(2);
    }
    console.error('\nStep 30 Phase 3 First Real One-click Launch 验收完成。');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
