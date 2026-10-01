/**
 * Step 26.2 — prepare generation 3 (no RunInstances / no enqueue / no --confirm-billing).
 *
 *   node scripts/step-262-prepare-g3.mjs
 *
 * - Seals g2 (terminal closed / superseded), keeps full history
 * - Rotates createGeneration 2 → 3 with fresh operationId/clientToken
 * - Re-prices + preflight; prepares queueJobId only (not_created)
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
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

const CR_ID = 'cmuas8iiz0001riown1l1a0o3';
const SECURITY_GROUP_ID = 'sg-bp1140codg2rttjhff9x';
const PLAN_FIXED = {
  regionId: 'cn-hangzhou',
  zoneId: 'cn-hangzhou-i',
  instanceType: 'ecs.c6a.large',
  imageId: 'alinux_4_deb_4_2404_2_x64_20G_alibase_20260714.vhd',
  systemDiskCategory: 'cloud_essd',
  systemDiskGb: 60,
  vSwitchId: 'vsw-bp157ohics42z8nspg3ma',
  vpcId: 'vpc-bp12hpcprxxtn1m2cm8k1',
  securityGroupId: SECURITY_GROUP_ID,
  chargeType: 'PostPaid',
  publicIpRequired: true,
};

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const requireProviders = createRequire(resolve(root, 'packages/providers/package.json'));
const requireShared = createRequire(resolve(root, 'packages/shared/package.json'));

const { PrismaClient } = requireApi('@launchos/database');
const {
  AlibabaCloudCapabilityService,
  AlibabaCloudEcsPlanner,
} = requireProviders('@launchos/providers');
const {
  advanceServerCreateGeneration,
  archiveServerProvisionCurrentFailure,
  buildLaunchosEcsTags,
  buildRunInstancesRequestPreview,
  decryptCredential,
  serverPriceFingerprint,
  serverProvisionJobId,
  validateRunInstancesRequestPreflight,
} = requireShared('@launchos/shared');

const RUN_INSTANCES_CALLED = false;
const prisma = new PrismaClient();

try {
  const resource = await prisma.cloudResource.findUnique({ where: { id: CR_ID } });
  if (!resource) throw new Error('CloudResource not found');
  const meta =
    resource.metadata && typeof resource.metadata === 'object' && !Array.isArray(resource.metadata)
      ? { ...resource.metadata }
      : {};

  const createGenerationBefore = Math.max(1, Number(meta.createGeneration || 1));
  if (createGenerationBefore !== 2) {
    throw new Error(`expected createGeneration=2 before prepare, got ${createGenerationBefore}`);
  }
  if (resource.providerResourceId?.trim()) {
    throw new Error('providerResourceId must be null before g3 prepare');
  }
  if (meta.reconcileG2?.matchCount !== 0 && meta.reconcileG2?.safeRotateToGeneration3 !== true) {
    // Allow if reconcile recorded matchCount 0
    if (Number(meta.reconcileG2?.matchCount) !== 0) {
      throw new Error('g2 reconcile matchCount must be 0 before rotate');
    }
  }

  const g2OperationId = String(meta.operationId || '');
  const g2ClientToken = String(meta.clientToken || g2OperationId).slice(0, 64);
  const g2RequestId = String(meta.lastRequestId || meta.providerRequestId || '') || null;
  const totalAttempt = Number(meta.runInstancesAttemptCount || 0);
  const totalSuccess = Number(meta.runInstancesSuccessCount || 0);

  // --- seal g2 + rotate to g3 (history preserved) ---
  const advanced = advanceServerCreateGeneration({
    generations: Array.isArray(meta.createGenerations) ? meta.createGenerations : [],
    currentOperationId: g2OperationId,
    closedAttemptCount: 1, // authoritative RunInstances attempts for g2
    closedSuccessCount: 0,
    totalAttemptCount: totalAttempt,
    totalSuccessCount: totalSuccess,
    terminalErrorCode: String(meta.providerErrorCode || 'Forbidden.RAM'),
    lastRequestId: g2RequestId,
  });

  if (advanced.createGeneration !== 3) {
    throw new Error(`expected createGeneration=3, got ${advanced.createGeneration}`);
  }
  if (advanced.operationId === g2OperationId) {
    throw new Error('g3 operationId must differ from g2');
  }

  const g3OperationId = advanced.operationId;
  const g3ClientToken = g3OperationId.slice(0, 64);
  if (g3ClientToken === g2ClientToken) {
    throw new Error('g3 clientToken must differ from g2');
  }

  // Enrich closed g2 record with reconcile + token refs (do not delete history).
  const createGenerations = advanced.createGenerations.map((g) => {
    if (Number(g.generation) !== 2) return g;
    return {
      ...g,
      attemptCount: 1,
      successCount: 0,
      terminalErrorCode: 'Forbidden.RAM',
      lastRequestId: g2RequestId,
      closedAt: g.closedAt || new Date().toISOString(),
      superseded: true,
      clientTokenRef: g2ClientToken,
      clientToken: g2ClientToken,
      reconcileMatchCount: 0,
      failedOperation: 'RunInstances',
      providerErrorCode: 'Forbidden.RAM',
      sealNote: 'g2 terminal closed after reconcile matchCount=0; history retained',
    };
  });

  // Archive current failure into errorHistory; keep prior history.
  const archived = archiveServerProvisionCurrentFailure({
    ...meta,
    // ensure Forbidden.RAM is archivabled even if already partially cleared
    providerErrorCode: meta.providerErrorCode || 'Forbidden.RAM',
    failedOperation: meta.failedOperation || 'RunInstances',
    lastRequestId: g2RequestId,
  });

  // --- fresh price (never reuse expired quote) ---
  const account = await prisma.providerAccount.findFirst({
    where: {
      status: 'ACTIVE',
      workspaceId: resource.workspaceId,
      provider: { type: 'ALIYUN' },
    },
    orderBy: { createdAt: 'asc' },
  });
  if (!account?.credentialEncrypted) throw new Error('ALIYUN account missing');
  const secrets = JSON.parse(decryptCredential(account.credentialEncrypted));
  const planner = new AlibabaCloudEcsPlanner({
    accessKey: secrets.accessKey,
    secretKey: secrets.secretKey,
    region: PLAN_FIXED.regionId,
  });
  const price = await planner.getPriceEstimate({
    regionId: PLAN_FIXED.regionId,
    instanceType: PLAN_FIXED.instanceType,
    systemDiskGb: PLAN_FIXED.systemDiskGb,
  });
  if (!price.available || !(price.hourlyPrice || price.tradePrice)) {
    throw new Error('fresh price unavailable');
  }

  const prevPlan =
    meta.currentResolvedServerPlan && typeof meta.currentResolvedServerPlan === 'object'
      ? meta.currentResolvedServerPlan
      : {};
  const plan = {
    ...prevPlan,
    profile: prevPlan.profile || 'STANDARD',
    regionId: PLAN_FIXED.regionId,
    zoneId: PLAN_FIXED.zoneId,
    instanceType: PLAN_FIXED.instanceType,
    cpu: prevPlan.cpu || 2,
    memoryGb: prevPlan.memoryGb || 4,
    systemDiskGb: PLAN_FIXED.systemDiskGb,
    systemDiskCategory: PLAN_FIXED.systemDiskCategory,
    imageId: PLAN_FIXED.imageId,
    imageName: prevPlan.imageName || 'Alibaba Cloud Linux',
    vpcId: PLAN_FIXED.vpcId,
    vSwitchId: PLAN_FIXED.vSwitchId,
    securityGroupId: SECURITY_GROUP_ID,
    publicIpRequired: true,
    chargeType: 'PostPaid',
    priceEstimate: {
      currency: price.currency,
      originalPrice: price.originalPrice,
      tradePrice: price.tradePrice,
      hourlyPrice: price.hourlyPrice,
      monthlyEquivalent: price.monthlyEquivalent,
      priceUnit: 'Hour',
      providerRequestId: price.providerRequestId || null,
      checkedAt: price.checkedAt || new Date().toISOString(),
    },
    selectionReason: prevPlan.selectionReason || 'g3_prepare_fixed_verified_plan',
    availabilityFingerprint: `${PLAN_FIXED.regionId}:${PLAN_FIXED.instanceType}:${PLAN_FIXED.zoneId}`,
  };

  const instanceName = String(meta.instanceName || 'launchos-launchos');
  const tags = buildLaunchosEcsTags({
    cloudResourceId: CR_ID,
    projectId: resource.projectId,
    workspaceId: resource.workspaceId,
  });

  // Password already stored (AES-GCM); measure length without echoing plaintext.
  let passwordLength = 0;
  let passwordPresent = false;
  if (typeof meta.passwordEncrypted === 'string' && meta.passwordEncrypted) {
    try {
      const pw = decryptCredential(meta.passwordEncrypted);
      passwordPresent = Boolean(pw);
      passwordLength = pw.length;
    } catch {
      passwordPresent = false;
      passwordLength = 0;
    }
  }

  const preview = buildRunInstancesRequestPreview({
    plan,
    instanceName,
    clientToken: g3ClientToken,
    securityGroupId: SECURITY_GROUP_ID,
    loginMode: 'PASSWORD',
    keyPairName: null,
    tags,
  });

  const preflight = validateRunInstancesRequestPreflight({
    regionId: plan.regionId,
    zoneId: plan.zoneId,
    instanceType: plan.instanceType,
    imageId: plan.imageId,
    systemDiskCategory: plan.systemDiskCategory,
    systemDiskSize: plan.systemDiskGb,
    vSwitchId: plan.vSwitchId,
    securityGroupId: SECURITY_GROUP_ID,
    instanceName,
    chargeType: 'PostPaid',
    internetChargeType: 'PayByTraffic',
    internetMaxBandwidthOut: 5,
    clientToken: g3ClientToken,
    loginMode: 'PASSWORD',
    passwordPresent,
    passwordLength,
    tags,
  });

  // --- capability gates (no create) ---
  const capability = await new AlibabaCloudCapabilityService().probe(
    {
      accessKey: secrets.accessKey,
      secretKey: secrets.secretKey,
      region: PLAN_FIXED.regionId,
    },
    { skipCreateDryRuns: true },
  );
  const actions = capability.capabilities.ecs?.actions || {};
  const blockers = [];
  if (actions.read !== 'READY') blockers.push('ecs.read');
  if (actions.price !== 'READY') blockers.push('ecs.price');
  if (actions.instanceCreate !== 'READY') blockers.push('ecs.instanceCreate');
  if (actions.securityGroupRead !== 'READY') blockers.push('ecs.securityGroupRead');
  if (actions.securityGroupCreate !== 'READY') blockers.push('ecs.securityGroupCreate');
  if (actions.securityGroupAuthorize !== 'READY') blockers.push('ecs.securityGroupAuthorize');
  if (actions.imageRead !== 'READY') blockers.push('ecs.imageRead');
  if (capability.capabilities.vpc?.status !== 'READY') blockers.push('vpc.read');
  if (capability.BILLING_ORDER_PERMISSION !== 'READY') blockers.push('billing');
  if (!plan.priceEstimate?.hourlyPrice && !plan.priceEstimate?.tradePrice) {
    blockers.push('price');
  }
  if (!preflight.valid) blockers.push(...preflight.missingFields.map((f) => `preflight:${f}`));

  const allReady = blockers.length === 0;
  const canCreate = allReady;

  const queueJobId = serverProvisionJobId(CR_ID, 3);
  // Do NOT enqueue — only prepare id.
  const queueJobState = 'not_created';

  const preparedAt = new Date().toISOString();
  const nextMeta = {
    ...archived,
    createGeneration: 3,
    operationId: g3OperationId,
    clientToken: g3ClientToken,
    createGenerations,
    previousOperationId: g2OperationId,
    previousClientToken: g2ClientToken,
    clientTokenRotateReason: 'terminal_rejection_reconcile_zero',
    generationAttemptCount: 0,
    generationSuccessCount: 0,
    // totals preserved — do not reset
    runInstancesAttemptCount: totalAttempt,
    runInstancesSuccessCount: totalSuccess,
    runInstancesCompleted: false,
    providerResourceId: null,
    phase: 'FAILED',
    instanceName,
    currentResolvedServerPlan: plan,
    resolvedSku: plan,
    confirmedPriceFingerprint: serverPriceFingerprint({
      currency: plan.priceEstimate.currency,
      tradePrice: plan.priceEstimate.tradePrice,
      hourlyPrice: plan.priceEstimate.hourlyPrice,
      instanceType: plan.instanceType,
    }),
    g2Sealed: {
      at: preparedAt,
      generation: 2,
      operationId: g2OperationId,
      clientToken: g2ClientToken,
      lastRequestId: g2RequestId,
      attemptCount: 1,
      successCount: 0,
      reconcileMatchCount: 0,
      terminalErrorCode: 'Forbidden.RAM',
      failedOperation: 'RunInstances',
      superseded: true,
    },
    g3Prepared: {
      at: preparedAt,
      generation: 3,
      operationId: g3OperationId,
      clientToken: g3ClientToken,
      queueJobId,
      queueJobState,
      enqueued: false,
      RUN_INSTANCES_CALLED: false,
      note: 'await user --confirm-billing before enqueue g3 / RunInstances',
      preflight: {
        valid: preflight.valid,
        missingFields: preflight.missingFields,
        passwordPresent: preflight.passwordPresent,
      },
      gates: {
        allReady,
        canCreate,
        blockers,
        imageRead: actions.imageRead || null,
        instanceCreate: actions.instanceCreate || null,
      },
      price: plan.priceEstimate,
      resolvedRunInstancesRequest: preflight.resolvedRunInstancesRequest,
      preview,
    },
    // clear create-inflight markers
    fixtureStopBeforeRunInstances: null,
    fixtureStopReached: null,
    fixtureStopAt: null,
  };

  await prisma.cloudResource.update({
    where: { id: CR_ID },
    data: {
      status: 'FAILED',
      providerResourceId: null,
      metadata: nextMeta,
    },
  });

  const after = await prisma.cloudResource.findUnique({ where: { id: CR_ID } });
  const am = after?.metadata || {};
  const g2 = (am.createGenerations || []).find((g) => Number(g.generation) === 2);
  const g3 = (am.createGenerations || []).find((g) => Number(g.generation) === 3);

  console.log(
    JSON.stringify(
      {
        ok: true,
        generation: {
          before: createGenerationBefore,
          after: Number(am.createGeneration),
          rotated: Number(am.createGeneration) === 3,
        },
        g2Sealed: {
          closedAt: g2?.closedAt || null,
          superseded: g2?.superseded === true,
          attemptCount: g2?.attemptCount,
          successCount: g2?.successCount,
          terminalErrorCode: g2?.terminalErrorCode,
          clientToken: g2?.clientToken || g2?.clientTokenRef,
          operationId: g2?.operationId,
          lastRequestId: g2?.lastRequestId,
          reconcileMatchCount: g2?.reconcileMatchCount,
        },
        g3: {
          clientToken: am.clientToken,
          operationId: am.operationId,
          clientTokenIsNew: am.clientToken !== g2ClientToken,
          operationIdIsNew: am.operationId !== g2OperationId,
          queueJobId,
          queueJobState,
          attemptCount: g3?.attemptCount ?? 0,
          successCount: g3?.successCount ?? 0,
        },
        counters: {
          totalRunInstancesAttemptCount: Number(am.runInstancesAttemptCount || 0),
          generation3RunInstancesAttemptCount: Number(g3?.attemptCount || 0),
          generation3RunInstancesSuccessCount: Number(g3?.successCount || 0),
        },
        providerResourceId: after?.providerResourceId ?? null,
        latestPrice: plan.priceEstimate,
        allReady,
        canCreate,
        runInstancesRequestValid: preflight.valid,
        missingFields: preflight.missingFields,
        passwordPresent: preflight.passwordPresent,
        securityGroupId: SECURITY_GROUP_ID,
        capability: {
          'ecs.imageRead': actions.imageRead,
          'ecs.instanceCreate': actions.instanceCreate,
          'ecs.securityGroupRead': actions.securityGroupRead,
          'ecs.securityGroupCreate': actions.securityGroupCreate,
          'ecs.securityGroupAuthorize': actions.securityGroupAuthorize,
          'ecs.price': actions.price,
          'vpc.read': capability.capabilities.vpc?.status,
          billing: capability.BILLING_ORDER_PERMISSION,
        },
        RUN_INSTANCES_CALLED,
        enqueued: false,
      },
      null,
      2,
    ),
  );

  if (Number(am.createGeneration) !== 3) process.exitCode = 1;
  if (RUN_INSTANCES_CALLED) process.exitCode = 1;
  if (!allReady || !canCreate || !preflight.valid) process.exitCode = 1;
  if (after?.providerResourceId) process.exitCode = 1;
} catch (error) {
  process.exitCode = 1;
  console.error(String(error?.stack || error?.message || error));
} finally {
  await prisma.$disconnect().catch(() => undefined);
}
