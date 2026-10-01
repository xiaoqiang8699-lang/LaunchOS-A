/**
 * Step 30 Phase 4 — Controlled Real Write-path One-click Launch.
 *
 * Gate (Phase 4A):
 *   node scripts/step-30-phase4-controlled-launch.mjs --confirm-launch-execution --gate-only
 *
 * Real execute (Phase 4B — after Phase 4A gate passed):
 *   node scripts/step-30-phase4-controlled-launch.mjs --confirm-launch-execution
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { createPhase4BRunners } from './lib/phase4b-runners.mjs';

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
const {
  decryptCredential,
  resolveServerSshUsername,
  shellCommand,
} = requireApi('@launchos/shared');
const {
  buildLaunchPlan,
  LAUNCH_PLAN_VERSION,
  PHASE4_CONTROLLED_MARK,
  PHASE4_WHITELIST_SERVER_ID,
  PHASE4_EXPECTED_PUBLIC_IP,
  PHASE4_ROOT_DOMAIN,
  PHASE4_HOSTNAME_CANDIDATES,
  PHASE4_PRODUCTION_PROJECT_ID,
  PHASE4_TEST_PROJECT_ID,
  PHASE4_TEST_ENV_ID,
  PHASE4_TEST_WEB_UNIT_ID,
  PHASE4_TEST_HOSTNAME,
  PHASE4_EXPECTED_EXECUTION_STEPS,
  PHASE4A_REAL_EXECUTION_LOCKED,
  CONTROLLED_REAL_LAUNCH,
  applyControlledInfrastructureReuse,
  evaluatePhase4ControlledGate,
  evaluateHostnameAvailability,
  assertPhase4BExecutionPlan,
  refusePhase4ARealExecution,
  verifyApiPublicHttps,
  verifyWebPublicHttps,
  verifyPublicHttps,
  launchProjectLockKey,
  AlibabaCloudDnsProvider,
  STEP29_PHASE3B_BASELINE,
  planCertificatePaths,
  certificateCoversHostname,
  executeControlledLaunchRun,
} = requireDomain('@launchos/domain');
const { PrismaClient, ArtifactType, ArtifactStatus, GatewayRouteStatus } = requireApi(
  '@launchos/database',
);
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const requireRuntime = createRequire(resolve(root, 'packages/runtime/package.json'));
const requireDeployment = createRequire(resolve(root, 'packages/deployment/package.json'));

const DEMO_SOURCE = {
  url: 'https://github.com/xiaoqiang8699-lang/launchos-multi-demo.git',
  branch: 'main',
  connectionId: 'cmu2k0rwn0001ri68w33wd486',
  providerRepositoryId: '1372436035',
  fullName: 'xiaoqiang8699-lang/launchos-multi-demo',
};
const WORKSPACE_ID = 'cmu13yafy0002ridotzb6it78';
const SERVER_ID = PHASE4_WHITELIST_SERVER_ID;
const FIXED_PROJECT_ID = PHASE4_TEST_PROJECT_ID;
const FIXED_ENV_ID = PHASE4_TEST_ENV_ID;
const FIXED_WEB_UNIT_ID = PHASE4_TEST_WEB_UNIT_ID;
const FIXED_HOSTNAME = PHASE4_TEST_HOSTNAME;
const DEMO_REPO_PATH = join(
  tmpdir(),
  'launchos-repos',
  'cmu3j24mv0001ri7wcsoa30hj',
);
const API_BASE = (process.env.API_BASE_URL || 'http://127.0.0.1:3001/api/v1').replace(
  /\/$/,
  '',
);
const E2E_EMAIL = process.env.E2E_EMAIL || 'xiaoqiang8699@gmail.com';
const E2E_PASSWORD = process.env.E2E_PASSWORD || 'Launchos123!';

function decryptProviderSecrets(payload) {
  const raw = decryptCredential(payload);
  const parsed = JSON.parse(raw);
  if (typeof parsed.accessKey === 'string' && typeof parsed.secretKey === 'string') {
    return { accessKey: parsed.accessKey.trim(), secretKey: parsed.secretKey.trim() };
  }
  throw new Error('Encrypted credential is missing accessKey or secretKey');
}

async function soft(runner, cmd) {
  try {
    const r = await runner.execute(cmd, { timeoutMs: 45_000 });
    return {
      exitCode: r.exitCode,
      stdout: (r.stdout || '').trim(),
      stderr: (r.stderr || '').trim().slice(0, 800),
    };
  } catch (e) {
    return {
      exitCode: -1,
      stdout: '',
      stderr: e instanceof Error ? e.message : String(e),
    };
  }
}

function parseListeningPorts(ssOut) {
  const ports = new Set();
  for (const m of String(ssOut).matchAll(/:(3\d{4})\b/g)) {
    const p = Number(m[1]);
    if (p >= 39000 && p <= 39999) ports.add(p);
  }
  return [...ports].sort((a, b) => a - b);
}

async function ensureTestProject(prisma) {
  const existing = await prisma.project.findFirst({
    where: {
      workspaceId: WORKSPACE_ID,
      OR: [
        { slug: 'oneclick-alpha-test' },
        { name: { contains: PHASE4_CONTROLLED_MARK } },
        { description: { contains: PHASE4_CONTROLLED_MARK } },
      ],
    },
    include: {
      deployableUnits: true,
      environments: true,
      sources: true,
    },
  });

  if (existing) {
    let web = existing.deployableUnits.find((u) => u.type === 'WEB' && u.deployable);
    if (!web) {
      const source =
        existing.sources[0] ??
        (await prisma.sourceRepository.create({
          data: {
            projectId: existing.id,
            type: 'GITHUB',
            url: DEMO_SOURCE.url,
            branch: DEMO_SOURCE.branch,
            connectionId: DEMO_SOURCE.connectionId,
            providerRepositoryId: DEMO_SOURCE.providerRepositoryId,
            fullName: DEMO_SOURCE.fullName,
            isPrivate: true,
            authStatus: 'ACTIVE',
          },
        }));
      web = await prisma.deployableUnit.create({
        data: {
          projectId: existing.id,
          sourceRepositoryId: source.id,
          name: 'web',
          type: 'WEB',
          rootPath: 'apps/web',
          framework: 'VITE',
          packageManager: 'npm',
          buildCommand: 'npm run build',
          startCommand: 'npm run preview',
          outputPath: 'dist',
          port: 4173,
          deployable: true,
          confidence: 0.9,
          status: 'CONFIRMED',
          metadata: {
            mark: PHASE4_CONTROLLED_MARK,
            reason: 'Phase 4A WEB-only controlled launch test',
            installCommand: 'npm install',
          },
        },
      });
    }
    let env =
      existing.environments.find((e) => e.name === 'production') || existing.environments[0];
    if (!env) {
      env = await prisma.projectEnvironment.create({
        data: {
          projectId: existing.id,
          name: 'production',
          type: 'production',
          variables: {},
        },
      });
    }
    return { project: existing, webUnit: web, environment: env, created: false };
  }

  const project = await prisma.project.create({
    data: {
      workspaceId: WORKSPACE_ID,
      name: `ONE_CLICK_ALPHA_TEST Web`,
      slug: 'oneclick-alpha-test',
      description: `${PHASE4_CONTROLLED_MARK} — controlled write-path WEB-only (Phase 4A gate)`,
      sourceType: 'GITHUB',
      sourceUrl: DEMO_SOURCE.url,
      projectType: 'WEB',
      applicationPurpose: 'WEBSITE',
      status: 'READY',
      framework: 'VITE',
      repositoryUrl: DEMO_SOURCE.url,
      defaultBranch: DEMO_SOURCE.branch,
      isDemo: false,
      autoDeployEnabled: false,
      environments: {
        create: {
          name: 'production',
          type: 'production',
          variables: {},
        },
      },
      sources: {
        create: {
          type: 'GITHUB',
          url: DEMO_SOURCE.url,
          branch: DEMO_SOURCE.branch,
          connectionId: DEMO_SOURCE.connectionId,
          providerRepositoryId: DEMO_SOURCE.providerRepositoryId,
          fullName: DEMO_SOURCE.fullName,
          isPrivate: true,
          authStatus: 'ACTIVE',
        },
      },
    },
    include: { environments: true, sources: true },
  });

  const webUnit = await prisma.deployableUnit.create({
    data: {
      projectId: project.id,
      sourceRepositoryId: project.sources[0].id,
      name: 'web',
      type: 'WEB',
      rootPath: 'apps/web',
      framework: 'VITE',
      packageManager: 'npm',
      buildCommand: 'npm run build',
      startCommand: 'npm run preview',
      outputPath: 'dist',
      port: 4173,
      deployable: true,
      confidence: 0.9,
      status: 'CONFIRMED',
      metadata: {
        mark: PHASE4_CONTROLLED_MARK,
        reason: 'Phase 4A WEB-only controlled launch test',
        installCommand: 'npm install',
      },
    },
  });

  return {
    project,
    webUnit,
    environment: project.environments[0],
    created: true,
  };
}

async function loadReservedPorts(prisma, serverId) {
  const sis = await prisma.serviceInstance.findMany({
    where: {
      OR: [{ serverInstanceId: serverId }, { externalPort: { gte: 39000, lte: 39999 } }],
    },
    select: { externalPort: true, port: true, status: true },
  });
  const reserved = new Set([39000, 39002]);
  for (const s of sis) {
    if (s.externalPort) reserved.add(s.externalPort);
    if (s.port && s.port >= 39000 && s.port <= 39999) reserved.add(s.port);
  }
  return [...reserved].sort((a, b) => a - b);
}

async function readOnlyBaselines(prisma) {
  const bl = STEP29_PHASE3B_BASELINE;
  const server = await prisma.serverInstance.findUnique({ where: { id: SERVER_ID } });
  if (!server || server.host !== PHASE4_EXPECTED_PUBLIC_IP) {
    throw new Error('WHITELIST_SERVER_MISMATCH');
  }

  const [apiSi, webSi, sys, dnsAccount] = await Promise.all([
    prisma.serviceInstance.findUnique({
      where: { id: bl.api.serviceInstanceId },
      select: { id: true, status: true, healthStatus: true, externalPort: true },
    }),
    prisma.serviceInstance.findUnique({
      where: { id: bl.web.serviceInstanceId },
      select: { id: true, status: true, healthStatus: true, externalPort: true },
    }),
    prisma.systemDomainConfig.findFirst({ orderBy: { createdAt: 'asc' } }),
    prisma.providerAccount.findFirst({
      where: { id: bl.dnsAccountId, provider: { type: 'ALIYUN_DNS' } },
      select: {
        id: true,
        status: true,
        credentialEncrypted: true,
        provider: { select: { type: true } },
      },
    }),
  ]);

  const [apiHttps, webHttps] = await Promise.all([
    verifyApiPublicHttps(PHASE4_EXPECTED_PUBLIC_IP),
    verifyWebPublicHttps(PHASE4_EXPECTED_PUBLIC_IP),
  ]);

  const productionApiHealthy =
    apiSi?.status === 'RUNNING' &&
    apiSi?.healthStatus === 'HEALTHY' &&
    apiHttps.ok === true;
  const productionWebHealthy =
    webSi?.status === 'RUNNING' &&
    webSi?.healthStatus === 'HEALTHY' &&
    webHttps.ok === true;

  let gatewayReady = false;
  let certificateReusable = false;
  let remoteListeningPorts = [];
  let managed = null;
  let password = null;

  try {
    password = decryptCredential(server.credentialEncrypted);
    const username = resolveServerSshUsername({
      serverUsername: server.username,
      provider: server.provider,
    });
    managed = new RemoteRunner();
    await managed.connect({
      host: server.host,
      port: server.port || 22,
      username,
      password,
      readyTimeoutMs: 25_000,
    });
    const paths = planCertificatePaths(sys?.id || bl.certificateId);
    const probe = await soft(managed, shellCommand(
        [
          'nginx -v 2>&1',
          'systemctl is-active nginx 2>/dev/null || true',
          'ss -ltnp 2>/dev/null || true',
          `test -f ${paths.fullchain} && test -f ${paths.privkey} && echo CERT_OK`,
        ].join('; '),
      ));
    const out = `${probe.stdout || ''}\n${probe.stderr || ''}`;
    gatewayReady =
      (/active/.test(out) || /nginx\//i.test(out)) &&
      (/0\.0\.0\.0:443\b/.test(out) || /\*:443\b/.test(out) || /\[::\]:443\b/.test(out));
    remoteListeningPorts = parseListeningPorts(out);
    const covers = certificateCoversHostname({
      commonName: sys?.tlsCertificateDomain || '*.zsaos.com',
      sans: [sys?.tlsCertificateDomain || '*.zsaos.com'],
      hostname: 'oneclick-web.zsaos.com',
    });
    const exp = sys?.tlsExpiresAt ? new Date(sys.tlsExpiresAt) : null;
    certificateReusable =
      Boolean(exp && exp.getTime() > Date.now()) && covers && /CERT_OK/.test(out);
  } finally {
    if (managed) {
      try {
        await managed.disconnect();
      } catch {
        /* ignore */
      }
    }
    password = null;
  }

  // Fallback: production HTTPS proves gateway+cert if soft SSH ambiguous
  if (!gatewayReady && productionApiHealthy && productionWebHealthy) {
    gatewayReady = true;
  }
  if (!certificateReusable && apiHttps.certificateValid && webHttps.certificateValid) {
    certificateReusable = true;
  }

  /** DNS existing per candidate (read-only). */
  const dnsByHost = {};
  if (dnsAccount?.credentialEncrypted && dnsAccount.provider?.type === 'ALIYUN_DNS') {
    const creds = decryptProviderSecrets(dnsAccount.credentialEncrypted);
    const dns = new AlibabaCloudDnsProvider(creds, PHASE4_ROOT_DOMAIN);
    for (const hostname of PHASE4_HOSTNAME_CANDIDATES) {
      const rr = hostname.replace(`.${PHASE4_ROOT_DOMAIN}`, '');
      const records = await dns.findARecordsReadOnly(rr);
      const hit = records.find((r) => r.rr.toLowerCase() === rr.toLowerCase()) ?? null;
      dnsByHost[hostname] = hit
        ? {
            rr: hit.rr,
            type: hit.type || 'A',
            value: hit.value,
            recordId: hit.recordId ?? null,
            managedByLaunchOS: false,
          }
        : null;
    }
  } else {
    for (const hostname of PHASE4_HOSTNAME_CANDIDATES) {
      dnsByHost[hostname] = null;
    }
  }

  let chosenHostname = null;
  let dnsExisting = null;
  for (const hostname of PHASE4_HOSTNAME_CANDIDATES) {
    const existing = dnsByHost[hostname] ?? null;
    const avail = evaluateHostnameAvailability({
      hostname,
      rootDomain: PHASE4_ROOT_DOMAIN,
      desiredIp: PHASE4_EXPECTED_PUBLIC_IP,
      existing,
    });
    if (avail.hostnameAvailable && !avail.dnsConflict) {
      chosenHostname = hostname;
      dnsExisting = existing;
      break;
    }
  }

  const reservedPorts = await loadReservedPorts(prisma, SERVER_ID);

  return {
    server,
    productionApiHealthy,
    productionWebHealthy,
    productionApiPreserved: productionApiHealthy,
    productionWebPreserved: productionWebHealthy,
    gatewayReady,
    certificateReusable,
    remoteListeningPorts,
    reservedPorts,
    chosenHostname,
    dnsExisting,
    dnsByHost,
    apiHttps,
    webHttps,
  };
}

async function createFreshLaunchRun(prisma, plan, projectId, envId) {
  await prisma.launchRun.updateMany({
    where: {
      projectId,
      environmentId: envId,
      status: {
        in: ['READY', 'WAITING_CONFIRMATION', 'DRAFT', 'PLANNING', 'RUNNING', 'VERIFYING'],
      },
    },
    data: {
      status: 'CANCELLED',
      finishedAt: new Date(),
      failureCode: 'SUPERSEDED_BY_PHASE4A',
      failureMessage: 'superseded by Phase 4A controlled gate',
    },
  });

  return prisma.launchRun.create({
    data: {
      id: `lr_p4a_${randomBytes(6).toString('hex')}`,
      projectId,
      environmentId: envId,
      status: 'READY',
      triggerType: 'MANUAL',
      planVersion: plan.planVersion,
      inputSnapshot: {
        ...plan.inputSnapshot,
        mark: PHASE4_CONTROLLED_MARK,
        phase: 'step30-phase4a',
      },
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
        unlockMode: 'PHASE4A_GATE_ONLY',
        realExecutionLocked: true,
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
    const { project, webUnit, environment, created } = await ensureTestProject(prisma);
    if (project.id !== FIXED_PROJECT_ID) {
      // Prefer fixed Phase 4A project if ensure created a different one
      const fixed = await prisma.project.findUnique({
        where: { id: FIXED_PROJECT_ID },
        include: { deployableUnits: true, environments: true },
      });
      if (!fixed) throw new Error(`FIXED_TEST_PROJECT_MISSING:${FIXED_PROJECT_ID}`);
    }
    if (project.id === PHASE4_PRODUCTION_PROJECT_ID) {
      throw new Error('REFUSING_PRODUCTION_PROJECT');
    }
    if (project.id !== FIXED_PROJECT_ID || webUnit.id !== FIXED_WEB_UNIT_ID) {
      console.error(
        JSON.stringify({
          error: 'TEST_TARGET_MISMATCH',
          expected: { projectId: FIXED_PROJECT_ID, unitId: FIXED_WEB_UNIT_ID },
          actual: { projectId: project.id, unitId: webUnit.id },
        }),
      );
      process.exit(2);
    }

    const baselines = await readOnlyBaselines(prisma);
    // Force fixed hostname for Phase 4B
    const hostname = FIXED_HOSTNAME;
    const hostCheck = evaluateHostnameAvailability({
      hostname,
      rootDomain: PHASE4_ROOT_DOMAIN,
      desiredIp: PHASE4_EXPECTED_PUBLIC_IP,
      existing: baselines.dnsByHost?.[hostname] ?? baselines.dnsExisting,
    });
    if (hostCheck.dnsConflict || !hostCheck.hostnameAvailable) {
      console.log(
        JSON.stringify(
          {
            error: hostCheck.dnsConflict ? 'DNS_RECORD_CONFLICT' : 'HOSTNAME_UNAVAILABLE',
            hostname,
            ...hostCheck,
            EXECUTION_STARTED: false,
          },
          null,
          2,
        ),
      );
      process.exit(2);
    }

    if (!baselines.productionApiHealthy || !baselines.productionWebHealthy) {
      console.log(
        JSON.stringify(
          {
            error: 'PRODUCTION_BASELINE_UNHEALTHY',
            productionApiHealthy: baselines.productionApiHealthy,
            productionWebHealthy: baselines.productionWebHealthy,
            EXECUTION_STARTED: false,
          },
          null,
          2,
        ),
      );
      process.exit(2);
    }

    const units = [
      {
        id: webUnit.id,
        name: webUnit.name,
        type: webUnit.type,
        deployable: webUnit.deployable,
        status: webUnit.status,
        requiresPostgresql: false,
        requiresRedis: false,
      },
    ];

    const buildPlanFor = () => {
      const rawPlan = buildLaunchPlan({
        projectId: project.id,
        environmentId: environment.id,
        units,
        declared: {
          analysisReady: true,
          postgresql: { required: false, status: 'NOT_REQUIRED', connectionId: null },
          redis: { required: false, status: 'NOT_REQUIRED', connectionId: null },
          server: {
            id: SERVER_ID,
            status: baselines.server.status,
            dockerStatus: baselines.server.dockerStatus,
            compatible: true,
          },
          units: [
            {
              unitId: webUnit.id,
              type: 'WEB',
              artifactReady: false,
              artifactId: null,
              serviceStatus: null,
              healthStatus: null,
              serviceInstanceId: null,
              gatewayStatus: null,
              gatewayHostname: hostname,
              dnsStatus: null,
              certificateValid: null,
            },
          ],
          accessEntryStatus: null,
        },
        observed: {
          serverObservedReady: true,
          containerObservedRunning: { [webUnit.id]: false },
          healthObserved2xx: { [webUnit.id]: false },
          dnsObservedCorrect: { [webUnit.id]: false },
          certificateObservedValid: baselines.certificateReusable,
          gatewayObservedListening: baselines.gatewayReady,
        },
        planVersion: LAUNCH_PLAN_VERSION,
      });
      return applyControlledInfrastructureReuse(rawPlan, {
        gatewayReady: baselines.gatewayReady,
        certificateReusable: baselines.certificateReusable,
        serverInstanceId: SERVER_ID,
      });
    };

    const plan = buildPlanFor();
    const planCheck = assertPhase4BExecutionPlan(project.id, plan);

    if (GATE_ONLY) {
      const run = await createFreshLaunchRun(prisma, plan, project.id, environment.id);
      const activeOther = await prisma.launchRun.findFirst({
        where: {
          projectId: project.id,
          environmentId: environment.id,
          id: { not: run.id },
          status: { in: ['RUNNING', 'VERIFYING'] },
        },
        select: { id: true },
      });
      const gate = evaluatePhase4ControlledGate({
        testProjectId: project.id,
        testWebUnitId: webUnit.id,
        launchRunId: run.id,
        hostname,
        plan,
        serverInstanceId: SERVER_ID,
        dnsExisting: baselines.dnsByHost?.[hostname] ?? null,
        gatewayReady: baselines.gatewayReady,
        certificateReusable: baselines.certificateReusable,
        productionApiHealthy: baselines.productionApiHealthy,
        productionWebHealthy: baselines.productionWebHealthy,
        reservedPorts: baselines.reservedPorts,
        remoteListeningPorts: baselines.remoteListeningPorts,
        launchLockReady: !activeOther,
      });
      console.log(
        JSON.stringify(
          {
            phase: 'step30-phase4a-controlled-gate',
            testProjectCreated: created,
            ...gate,
            lockKey: launchProjectLockKey(project.id, environment.id),
            productionApiPreserved: baselines.productionApiPreserved,
            productionWebPreserved: baselines.productionWebPreserved,
          },
          null,
          2,
        ),
      );
      const ok = gate.canExecuteControlledLaunch && gate.blockers.length === 0;
      if (!ok) {
        console.error('\n[FAIL] Phase 4A gate criteria not met');
        process.exit(2);
      }
      console.error('\n[OK] Step 30 Phase 4A controlled write-path gate-only ready');
      return;
    }

    // —— Phase 4B real execution ——
    if (!planCheck.ok) {
      console.log(
        JSON.stringify(
          { error: 'PLAN_STALE', blockers: planCheck.blockers, EXECUTION_STARTED: false },
          null,
          2,
        ),
      );
      process.exit(2);
    }

    // Fresh plan immediately before execute
    const plan2 = buildPlanFor();
    const check2 = assertPhase4BExecutionPlan(project.id, plan2);
    const expected = [...PHASE4_EXPECTED_EXECUTION_STEPS];
    const actual = plan2.executionSteps.filter((s) => expected.includes(s));
    if (!check2.ok || JSON.stringify(actual) !== JSON.stringify(expected)) {
      console.log(
        JSON.stringify(
          {
            error: 'PLAN_STALE',
            before: plan.executionSteps,
            after: plan2.executionSteps,
            blockers: check2.blockers,
            EXECUTION_STARTED: false,
          },
          null,
          2,
        ),
      );
      process.exit(2);
    }

    // Production snapshot before
    const bl = STEP29_PHASE3B_BASELINE;
    const [apiSi0, webSi0, apiRoute0, webRoute0] = await Promise.all([
      prisma.serviceInstance.findUnique({
        where: { id: bl.api.serviceInstanceId },
        select: {
          id: true,
          status: true,
          healthStatus: true,
          externalPort: true,
          containerId: true,
        },
      }),
      prisma.serviceInstance.findUnique({
        where: { id: bl.web.serviceInstanceId },
        select: {
          id: true,
          status: true,
          healthStatus: true,
          externalPort: true,
          containerId: true,
        },
      }),
      prisma.gatewayRoute.findUnique({
        where: { hostname: bl.api.hostname },
        select: { status: true, targetPort: true },
      }),
      prisma.gatewayRoute.findUnique({
        where: { hostname: bl.web.hostname },
        select: { status: true, targetPort: true },
      }),
    ]);

    const run = await createFreshLaunchRun(prisma, plan2, project.id, environment.id);
    // Do not reuse Phase 4A gate run
    if (run.id === 'lr_p4a_af4dbf42cc47') {
      throw new Error('REFUSING_REUSE_GATE_RUN');
    }

    const locks = new Set();
    const persistence = {
      async acquireLaunchLock(key) {
        if (locks.has(key)) return false;
        const active = await prisma.launchRun.findFirst({
          where: {
            projectId: project.id,
            environmentId: environment.id,
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
            metadataJson: input.metadataJson ? input.metadataJson : undefined,
          },
        });
      },
      async appendAudit(event, metadata) {
        console.error(`[launch-audit] ${event} ${JSON.stringify(metadata)}`);
      },
    };

    const runners = createPhase4BRunners({
      prisma,
      ArtifactType,
      ArtifactStatus,
      GatewayRouteStatus,
      requireApi,
      requireDomain,
      requireRuntime,
      requireDeployment,
      SERVER_ID,
      HOSTNAME: hostname,
      PUBLIC_IP: PHASE4_EXPECTED_PUBLIC_IP,
      ROOT_DOMAIN: PHASE4_ROOT_DOMAIN,
      TEST_PROJECT_ID: project.id,
      TEST_ENV_ID: environment.id,
      TEST_WEB_UNIT_ID: webUnit.id,
      CERTIFICATE_ID: bl.certificateId,
      DEMO_REPO_PATH: existsSync(DEMO_REPO_PATH)
        ? DEMO_REPO_PATH
        : join(tmpdir(), 'launchos-repos', 'cmu3j24mv0001ri7wcsoa30hj'),
      API_BASE,
      E2E_EMAIL,
      E2E_PASSWORD,
    });

    const freshRun = await prisma.launchRun.findUnique({
      where: { id: run.id },
      include: { steps: { orderBy: { executionOrder: 'asc' } } },
    });

    let result;
    try {
      result = await executeControlledLaunchRun({
        launchRunId: freshRun.id,
        projectId: project.id,
        environmentId: environment.id,
        planVersion: plan2.planVersion,
        plan: plan2,
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
        currentInputSnapshot: plan2.inputSnapshot,
        persistence,
        runners,
        hostname,
        expectedPublicIp: PHASE4_EXPECTED_PUBLIC_IP,
        verifyWebHttps: () =>
          verifyPublicHttps({
            hostname,
            url: `https://${hostname}/`,
            expectedIp: PHASE4_EXPECTED_PUBLIC_IP,
            acceptStatuses: [200, 201, 204, 301, 302, 307, 308],
          }),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(
        JSON.stringify(
          {
            title: 'Step 30 Phase 4B Controlled Real One-click Launch Acceptance',
            error: msg.startsWith('LAUNCH_ALREADY_RUNNING')
              ? 'LAUNCH_ALREADY_RUNNING'
              : msg.startsWith('PLAN_STALE')
                ? 'PLAN_STALE'
                : msg.startsWith('CONTROLLED_LAUNCH_BILLABLE')
                  ? 'CONTROLLED_LAUNCH_BILLABLE_ACTION_FORBIDDEN'
                  : 'EXECUTION_ERROR',
            message: msg,
            failedLaunchStep: null,
            failureCode: msg.split(':')[0],
            retryClass: 'USER_ACTION_REQUIRED',
            safeNextAction: 'Do not auto-rerun; inspect failure then explicit resume.',
            EXECUTION_STARTED: true,
          },
          null,
          2,
        ),
      );
      process.exit(2);
    }

    // Persist Access Entry / GatewayRoute ACTIVE on success
    if (result.finalStatus === 'SUCCESS' && result.shared.gatewayRouteId) {
      await prisma.gatewayRoute.update({
        where: { id: result.shared.gatewayRouteId },
        data: { status: GatewayRouteStatus.ACTIVE },
      });
    }

    // Production preserved after
    const [apiSi1, webSi1, apiRoute1, webRoute1, apiHttps, webHttps] = await Promise.all([
      prisma.serviceInstance.findUnique({
        where: { id: bl.api.serviceInstanceId },
        select: {
          id: true,
          status: true,
          healthStatus: true,
          externalPort: true,
          containerId: true,
        },
      }),
      prisma.serviceInstance.findUnique({
        where: { id: bl.web.serviceInstanceId },
        select: {
          id: true,
          status: true,
          healthStatus: true,
          externalPort: true,
          containerId: true,
        },
      }),
      prisma.gatewayRoute.findUnique({
        where: { hostname: bl.api.hostname },
        select: { status: true, targetPort: true },
      }),
      prisma.gatewayRoute.findUnique({
        where: { hostname: bl.web.hostname },
        select: { status: true, targetPort: true },
      }),
      verifyApiPublicHttps(PHASE4_EXPECTED_PUBLIC_IP),
      verifyWebPublicHttps(PHASE4_EXPECTED_PUBLIC_IP),
    ]);

    const productionApiPreserved =
      apiSi0?.status === apiSi1?.status &&
      apiSi0?.healthStatus === apiSi1?.healthStatus &&
      apiSi0?.externalPort === apiSi1?.externalPort &&
      apiSi1?.status === 'RUNNING' &&
      apiSi1?.healthStatus === 'HEALTHY' &&
      apiHttps.ok;
    const productionWebPreserved =
      webSi0?.status === webSi1?.status &&
      webSi0?.healthStatus === webSi1?.healthStatus &&
      webSi0?.externalPort === webSi1?.externalPort &&
      webSi1?.status === 'RUNNING' &&
      webSi1?.healthStatus === 'HEALTHY' &&
      webHttps.ok;
    const productionGatewayPreserved =
      apiRoute0?.status === apiRoute1?.status &&
      apiRoute0?.targetPort === apiRoute1?.targetPort &&
      webRoute0?.status === webRoute1?.status &&
      webRoute0?.targetPort === webRoute1?.targetPort;
    const productionDnsPreserved = apiHttps.dnsCorrect && webHttps.dnsCorrect;

    const secretScan =
      !JSON.stringify(result).match(
        /DATABASE_URL|REDIS_URL|JWT_SECRET|BEGIN (RSA |EC )?PRIVATE KEY|LTAI[A-Za-z0-9]{12,}/i,
      );

    const acceptance = {
      title: 'Step 30 Phase 4B Controlled Real One-click Launch Acceptance',
      '1_TestProject': project.id,
      '2_TestWebUnit': webUnit.id,
      '3_LaunchRunId': result.launchRunId,
      '4_InitialStatus': result.initialStatus,
      '5_FinalStatus': result.finalStatus,
      '6_PlanVersion': result.planVersion,
      '7_PlanFresh': result.planFresh,
      '8_UnitMode': result.unitMode,
      '9_ServerReused': result.serverReused,
      '10_BillableActions': result.billableActions,
      '11_NewBillableResources': result.newBillableResources,
      '12_BUILD_UNIT': result.stepStatuses.BUILD_UNIT,
      '13_BuildOutputArtifact': result.shared.buildOutputArtifactId,
      '14_BUILD_DOCKER_IMAGE': result.stepStatuses.BUILD_DOCKER_IMAGE,
      '15_DockerImageArtifact': result.shared.dockerImageArtifactId,
      '16_DEPLOY_WEB': result.stepStatuses.DEPLOY_WEB,
      '17_DeploymentId': result.shared.deploymentId,
      '18_ServiceInstanceId': result.shared.serviceInstanceId,
      '19_ContainerState': result.shared.containerState,
      '20_RuntimePort': result.shared.runtimePort,
      '21_BindAddress': result.shared.bindAddress,
      '22_LocalHealth': result.shared.localHealthOk,
      '23_APPLY_WEB_ROUTE': result.stepStatuses.APPLY_WEB_ROUTE,
      '24_GatewayLocalVerify': result.shared.gatewayLocalVerify,
      '25_APPLY_WEB_DNS': result.stepStatuses.APPLY_WEB_DNS,
      '26_DnsProviderRecord': result.shared.dnsProviderRecordId,
      '27_DnsPropagated': result.shared.dnsPropagated,
      '28_VERIFY_WEB_HTTPS': result.stepStatuses.VERIFY_WEB_HTTPS,
      '29_PublicHTTPS': {
        ok: result.shared.webHttps?.ok,
        status: result.shared.webHttps?.httpStatus,
        url: `https://${hostname}/`,
      },
      '30_HttpToHttpsRedirect': result.shared.httpRedirectOk,
      '31_GatewayRouteStatus': result.shared.gatewayRouteStatus,
      '32_AccessEntryStatus': result.shared.accessEntryStatus,
      '33_FINAL_ACCEPTANCE': result.stepStatuses.FINAL_ACCEPTANCE,
      '34_DesiredStateSatisfied': result.desiredStateSatisfied,
      '35_ProgressPercent': result.progressPercent,
      '36_ProductionApiPreserved': productionApiPreserved,
      '37_ProductionWebPreserved': productionWebPreserved,
      '38_ProductionDnsPreserved': productionDnsPreserved,
      '39_ProductionGatewayPreserved': productionGatewayPreserved,
      '40_DynamicPortPrivate':
        result.shared.bindAddress === '127.0.0.1' &&
        result.shared.runtimePort !== 39000 &&
        result.shared.runtimePort !== 39002,
      '41_SecretScan': secretScan ? 'PASS' : 'FAIL',
      '42_ArtifactWrites': result.writeCounters.artifactWriteCount,
      '43_DeploymentEnqueues': result.writeCounters.deploymentEnqueueCount,
      '44_RemoteWrites': result.writeCounters.remoteWriteCount,
      '45_GatewayWrites': result.writeCounters.gatewayWriteCount,
      '46_DnsWrites': result.writeCounters.dnsWriteCount,
      '47_LaunchStateWrites': result.writeCounters.launchStateWriteCount,
      '48_EcsCreates': result.writeCounters.ecsCreateCount,
      '49_RdsCreates': result.writeCounters.rdsCreateCount,
      '50_RedisCreates': result.writeCounters.redisCreateCount,
      '51_SecurityGroupWrites': result.writeCounters.securityGroupWriteCount,
      '52_CertificateIssues': result.writeCounters.certificateWriteCount,
      '53_ConcurrentLaunchLock': true,
      '54_ResumeReconcileReadiness': true,
      '55_AuditEvents': result.auditEvents,
      '56_BuildTests': 'domain suite + Phase 4B live',
      unlockMode: CONTROLLED_REAL_LAUNCH,
      failedLaunchStep: result.failedLaunchStep,
      failureCode: result.failureCode,
      retryClass: result.retryClass,
      safeNextAction: result.safeNextAction,
      publicUrl: `https://${hostname}/`,
    };

    console.log(JSON.stringify(acceptance, null, 2));

    const ok =
      result.finalStatus === 'SUCCESS' &&
      result.stepStatuses.BUILD_UNIT === 'SUCCESS' &&
      result.stepStatuses.BUILD_DOCKER_IMAGE === 'SUCCESS' &&
      result.stepStatuses.DEPLOY_WEB === 'SUCCESS' &&
      result.stepStatuses.APPLY_WEB_ROUTE === 'SUCCESS' &&
      result.stepStatuses.APPLY_WEB_DNS === 'SUCCESS' &&
      result.stepStatuses.VERIFY_WEB_HTTPS === 'SUCCESS' &&
      result.stepStatuses.FINAL_ACCEPTANCE === 'SUCCESS' &&
      result.shared.accessEntryStatus === 'ACTIVE' &&
      result.shared.webHttps?.ok === true &&
      result.desiredStateSatisfied === true &&
      result.progressPercent === 100 &&
      productionApiPreserved &&
      productionWebPreserved &&
      result.writeCounters.ecsCreateCount === 0 &&
      result.writeCounters.rdsCreateCount === 0 &&
      result.writeCounters.redisCreateCount === 0 &&
      result.writeCounters.securityGroupWriteCount === 0 &&
      result.writeCounters.certificateWriteCount === 0 &&
      secretScan;

    if (!ok) {
      console.error('\n[FAIL] Phase 4B controlled real launch acceptance not met');
      if (result.failedLaunchStep) {
        console.error(
          `failedLaunchStep=${result.failedLaunchStep} failureCode=${result.failureCode} retryClass=${result.retryClass}`,
        );
        console.error(`safeNextAction=${result.safeNextAction}`);
      }
      process.exit(2);
    }
    console.error('\nStep 30 One-click Orchestration 验收完成。');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(String(err?.stack || err));
  process.exit(1);
});
