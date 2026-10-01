/**
 * Step 26.2 — prepare generation 4 (no RunInstances / no enqueue / no --confirm-billing).
 *
 *   node scripts/step-262-prepare-g4.mjs
 *
 * - Seals g3 (terminal closed / superseded), keeps full history + auto-retry bug marker
 * - Rotates createGeneration 3 → 4 with fresh operationId/clientToken
 * - Re-prices + billing readiness + preflight; prepares queueJobId only (not_created)
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
  if (createGenerationBefore !== 3) {
    throw new Error(`expected createGeneration=3 before prepare, got ${createGenerationBefore}`);
  }
  if (resource.providerResourceId?.trim()) {
    throw new Error('providerResourceId must be null before g4 prepare');
  }
  if (Number(meta.reconcileG3?.matchCount) !== 0) {
    throw new Error('g3 reconcile matchCount must be 0 before rotate to g4');
  }

  const g3OperationId = String(meta.operationId || '');
  const g3ClientToken = String(meta.clientToken || g3OperationId).slice(0, 64);
  const g3RequestId =
    String(meta.lastRequestId || meta.providerRequestId || '') ||
    '01A0C3C9-2D92-5A13-9745-97C88B43EEF7';
  const totalAttempt = Number(meta.runInstancesAttemptCount || 0);
  const totalSuccess = Number(meta.runInstancesSuccessCount || 0);
  if (totalAttempt !== 3) {
    console.warn(`warn: expected totalRunInstancesAttemptCount=3, got ${totalAttempt}`);
  }

  // --- seal g3 + rotate to g4 (history preserved) ---
  const advanced = advanceServerCreateGeneration({
    generations: Array.isArray(meta.createGenerations) ? meta.createGenerations : [],
    currentOperationId: g3OperationId,
    closedAttemptCount: 2, // observed g3 attempts (incl. BullMQ auto-retry bug)
    closedSuccessCount: 0,
    totalAttemptCount: totalAttempt,
    totalSuccessCount: totalSuccess,
    terminalErrorCode: String(
      meta.providerErrorCode || 'InvalidAccountStatus.NotEnoughBalance',
    ),
    lastRequestId: g3RequestId,
  });

  if (advanced.createGeneration !== 4) {
    throw new Error(`expected createGeneration=4, got ${advanced.createGeneration}`);
  }
  if (advanced.operationId === g3OperationId) {
    throw new Error('g4 operationId must differ from g3');
  }

  const g4OperationId = advanced.operationId;
  const g4ClientToken = g4OperationId.slice(0, 64);
  if (g4ClientToken === g3ClientToken) {
    throw new Error('g4 clientToken must differ from g3');
  }

  const createGenerations = advanced.createGenerations.map((g) => {
    if (Number(g.generation) !== 3) return g;
    return {
      ...g,
      attemptCount: 2,
      successCount: 0,
      terminalErrorCode: 'InvalidAccountStatus.NotEnoughBalance',
      lastRequestId: g3RequestId,
      closedAt: g.closedAt || new Date().toISOString(),
      superseded: true,
      clientTokenRef: g3ClientToken,
      clientToken: g3ClientToken,
      reconcileMatchCount: 0,
      failedOperation: 'RunInstances',
      providerErrorCode: 'InvalidAccountStatus.NotEnoughBalance',
      autoRetryBug: true,
      autoRetryBugNote:
        'g3 RunInstances auto-retried via BullMQ attempts:2; history retained',
      sealNote:
        'g3 terminal closed after reconcile matchCount=0 + balance topped up; history retained',
    };
  });

  const archived = archiveServerProvisionCurrentFailure({
    ...meta,
    providerErrorCode: meta.providerErrorCode || 'InvalidAccountStatus.NotEnoughBalance',
    failedOperation: meta.failedOperation || 'RunInstances',
    lastRequestId: g3RequestId,
    lastErrorCode: meta.lastErrorCode || 'BILLING_NOT_ENOUGH_BALANCE',
  });

  // --- credentials + fresh price + billing readiness ---
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

  const capability = await new AlibabaCloudCapabilityService().probe(
    {
      accessKey: secrets.accessKey,
      secretKey: secrets.secretKey,
      region: PLAN_FIXED.regionId,
    },
    { skipCreateDryRuns: true },
  );
  const actions = capability.capabilities.ecs?.actions || {};
  const billingPermission =
    capability.BILLING_ORDER_PERMISSION ||
    capability.capabilities.billing?.actions?.order ||
    null;
  const billingAccountBalance =
    capability.capabilities.billing?.actions?.accountBalance || 'UNKNOWN';

  if (billingAccountBalance === 'INSUFFICIENT') {
    throw new Error('billing.accountBalance still INSUFFICIENT — refuse g4 prepare for create');
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
    selectionReason: prevPlan.selectionReason || 'g4_prepare_fixed_verified_plan',
    availabilityFingerprint: `${PLAN_FIXED.regionId}:${PLAN_FIXED.instanceType}:${PLAN_FIXED.zoneId}`,
  };

  const instanceName = String(meta.instanceName || 'launchos-launchos');
  const tags = buildLaunchosEcsTags({
    cloudResourceId: CR_ID,
    projectId: resource.projectId,
    workspaceId: resource.workspaceId,
  });

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
    clientToken: g4ClientToken,
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
    clientToken: g4ClientToken,
    loginMode: 'PASSWORD',
    passwordPresent,
    passwordLength,
    tags,
  });

  const blockers = [];
  if (actions.read !== 'READY') blockers.push('ecs.read');
  if (actions.price !== 'READY') blockers.push('ecs.price');
  if (actions.instanceCreate !== 'READY') blockers.push('ecs.instanceCreate');
  if (actions.securityGroupRead !== 'READY') blockers.push('ecs.securityGroupRead');
  if (actions.securityGroupCreate !== 'READY') blockers.push('ecs.securityGroupCreate');
  if (actions.securityGroupAuthorize !== 'READY') blockers.push('ecs.securityGroupAuthorize');
  if (actions.imageRead !== 'READY') blockers.push('ecs.imageRead');
  if (capability.capabilities.vpc?.status !== 'READY') blockers.push('vpc.read');
  if (billingPermission !== 'READY') blockers.push('billing.permission');
  if (billingAccountBalance === 'INSUFFICIENT') blockers.push('billing.accountBalance');
  if (!plan.priceEstimate?.hourlyPrice && !plan.priceEstimate?.tradePrice) {
    blockers.push('price');
  }
  if (!preflight.valid) blockers.push(...preflight.missingFields.map((f) => `preflight:${f}`));

  const allReady = blockers.length === 0;
  const canCreate = allReady;

  const queueJobId = serverProvisionJobId(CR_ID, 4);
  const queueJobState = 'not_created';
  const preparedAt = new Date().toISOString();

  const nextMeta = {
    ...archived,
    createGeneration: 4,
    operationId: g4OperationId,
    clientToken: g4ClientToken,
    createGenerations,
    previousOperationId: g3OperationId,
    previousClientToken: g3ClientToken,
    clientTokenRotateReason: 'terminal_rejection_reconcile_zero_balance_topped_up',
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
    // clear prior insufficient marker after refresh (probe result wins)
    billingAccountBalance:
      billingAccountBalance === 'READY'
        ? 'READY'
        : billingAccountBalance === 'INSUFFICIENT'
          ? 'INSUFFICIENT'
          : 'UNKNOWN',
    requiresUserAction: false,
    autoRetryBlocked: false,
    g3Sealed: {
      at: preparedAt,
      generation: 3,
      operationId: g3OperationId,
      clientToken: g3ClientToken,
      lastRequestId: g3RequestId,
      attemptCount: 2,
      successCount: 0,
      reconcileMatchCount: 0,
      terminalErrorCode: 'InvalidAccountStatus.NotEnoughBalance',
      failedOperation: 'RunInstances',
      superseded: true,
      autoRetryBug: true,
    },
    g4Prepared: {
      at: preparedAt,
      generation: 4,
      operationId: g4OperationId,
      clientToken: g4ClientToken,
      queueJobId,
      queueJobState,
      enqueued: false,
      RUN_INSTANCES_CALLED: false,
      note: 'await user --confirm-billing before enqueue g4 / RunInstances',
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
      billing: {
        permission: billingPermission,
        accountBalance: billingAccountBalance,
      },
      price: plan.priceEstimate,
      resolvedRunInstancesRequest: preflight.resolvedRunInstancesRequest,
      preview,
    },
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
  const g3 = (am.createGenerations || []).find((g) => Number(g.generation) === 3);
  const g4 = (am.createGenerations || []).find((g) => Number(g.generation) === 4);

  console.log(
    JSON.stringify(
      {
        ok: true,
        generation: {
          before: createGenerationBefore,
          after: Number(am.createGeneration),
          rotated: Number(am.createGeneration) === 4,
        },
        g3Sealed: {
          closedAt: g3?.closedAt || null,
          superseded: g3?.superseded === true,
          attemptCount: g3?.attemptCount,
          successCount: g3?.successCount,
          terminalErrorCode: g3?.terminalErrorCode,
          clientToken: g3?.clientToken || g3?.clientTokenRef,
          operationId: g3?.operationId,
          lastRequestId: g3?.lastRequestId,
          reconcileMatchCount: g3?.reconcileMatchCount,
          autoRetryBug: g3?.autoRetryBug === true,
        },
        g4: {
          clientToken: am.clientToken,
          operationId: am.operationId,
          clientTokenIsNew: am.clientToken !== g3ClientToken,
          operationIdIsNew: am.operationId !== g3OperationId,
          queueJobId,
          queueJobState,
          attemptCount: g4?.attemptCount ?? 0,
          successCount: g4?.successCount ?? 0,
        },
        counters: {
          totalRunInstancesAttemptCount: Number(am.runInstancesAttemptCount || 0),
          generation4RunInstancesAttemptCount: Number(g4?.attemptCount || 0),
          generation4RunInstancesSuccessCount: Number(g4?.successCount || 0),
        },
        providerResourceId: after?.providerResourceId ?? null,
        billing: {
          permission: billingPermission,
          accountBalance: billingAccountBalance,
        },
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
          'billing.permission': billingPermission,
          'billing.accountBalance': billingAccountBalance,
        },
        RUN_INSTANCES_CALLED,
        enqueued: false,
      },
      null,
      2,
    ),
  );

  if (Number(am.createGeneration) !== 4) process.exitCode = 1;
  if (RUN_INSTANCES_CALLED) process.exitCode = 1;
  if (!allReady || !canCreate || !preflight.valid) process.exitCode = 1;
  if (after?.providerResourceId) process.exitCode = 1;
  if (billingAccountBalance === 'INSUFFICIENT') process.exitCode = 1;
} catch (error) {
  process.exitCode = 1;
  console.error(String(error?.stack || error?.message || error));
} finally {
  await prisma.$disconnect().catch(() => undefined);
}
