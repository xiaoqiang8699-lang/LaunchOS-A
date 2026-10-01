/**
 * Step 30 Phase 3 — First Real Launch whitelist: verify-only on live Demo project.
 */

import { classifyLaunchWrites } from './launch-write-plan.js';
import { defaultLaunchHandlerRegistry } from './launch-handler-registry.js';
import type { LaunchPlanResult } from './launch-orchestrator.js';

export const PHASE3_WHITELIST_PROJECT_ID = 'cmu3j24mv0001ri7wcsoa30hj';
export const PHASE3_WHITELIST_SERVER_ID = 'cmub78pz001sdripco5pexhdz';
export const PHASE3_EXPECTED_PUBLIC_IP = '116.62.198.184';

export const PHASE3_API = {
  unitId: 'cmu3j272x0005ri7wlxlbajeu',
  serviceInstanceId: 'cmuc66642002hritk6h3cbwhe',
  hostname: 'api-launchos.zsaos.com',
  healthUrl: 'https://api-launchos.zsaos.com/health',
  localBind: '127.0.0.1:39000',
} as const;

export const PHASE3_WEB = {
  unitId: 'cmu3j27340007ri7wcno1xrai',
  serviceInstanceId: 'cmucaxah704r9ritkb30z16uw',
  deploymentId: 'cmucaxab6001rriagcdjoez03',
  hostname: 'web-launchos.zsaos.com',
  healthUrl: 'https://web-launchos.zsaos.com/',
  localBind: '127.0.0.1:39002',
  expectedPublicApiUrl: 'https://api-launchos.zsaos.com',
} as const;

export const FIRST_REAL_LAUNCH_VERIFY_ONLY = 'FIRST_REAL_LAUNCH_VERIFY_ONLY';
export const PHASE3_VERIFY_ONLY_WRITE_FORBIDDEN = 'PHASE3_VERIFY_ONLY_WRITE_FORBIDDEN';
export const LAUNCH_ALREADY_RUNNING = 'LAUNCH_ALREADY_RUNNING';

export const PHASE3_ALLOWED_EXECUTE_STEPS = [
  'VERIFY_API_HTTPS',
  'VERIFY_WEB_HTTPS',
  'FINAL_ACCEPTANCE',
] as const;

export type Phase3VerifyOnlyCheck = {
  ok: boolean;
  verifyOnlyPlan: boolean;
  writeCapableExecuteSteps: string[];
  executableSteps: string[];
  blockers: Array<{ code: string; messageZh: string }>;
  plannedWrites: ReturnType<typeof classifyLaunchWrites>;
};

export function assertPhase3VerifyOnlyPlan(
  projectId: string,
  plan: Pick<
    LaunchPlanResult,
    | 'executionSteps'
    | 'requiresConfirmation'
    | 'billableActions'
    | 'resourcesToCreate'
    | 'steps'
  >,
  options?: { skipProjectWhitelist?: boolean },
): Phase3VerifyOnlyCheck {
  const blockers: Array<{ code: string; messageZh: string }> = [];
  const executableSteps = plan.executionSteps.filter(Boolean);
  const writeCapableExecuteSteps: string[] = [];

  if (!options?.skipProjectWhitelist && projectId !== PHASE3_WHITELIST_PROJECT_ID) {
    blockers.push({
      code: 'PHASE3_PROJECT_NOT_WHITELISTED',
      messageZh: 'Phase 3 仅允许指定 Demo 项目进行 verify-only 真实执行',
    });
  }

  if (plan.requiresConfirmation) {
    blockers.push({
      code: PHASE3_VERIFY_ONLY_WRITE_FORBIDDEN,
      messageZh: 'Plan 需要费用确认，禁止 Phase 3 verify-only 执行',
    });
  }
  if (plan.billableActions.length > 0) {
    blockers.push({
      code: PHASE3_VERIFY_ONLY_WRITE_FORBIDDEN,
      messageZh: 'Plan 含收费动作，禁止 Phase 3 verify-only 执行',
    });
  }
  if (plan.resourcesToCreate.length > 0) {
    blockers.push({
      code: PHASE3_VERIFY_ONLY_WRITE_FORBIDDEN,
      messageZh: 'Plan 需要创建资源，禁止 Phase 3 verify-only 执行',
    });
  }

  for (const step of plan.steps) {
    if (step.decision !== 'EXECUTE') continue;
    const handler = defaultLaunchHandlerRegistry.get(step.stepType);
    const writeClass = handler?.writeClass ?? 'none';
    if (writeClass !== 'none') {
      writeCapableExecuteSteps.push(step.stepType);
    }
    if (!(PHASE3_ALLOWED_EXECUTE_STEPS as readonly string[]).includes(step.stepType)) {
      blockers.push({
        code: PHASE3_VERIFY_ONLY_WRITE_FORBIDDEN,
        messageZh: `非白名单执行步骤: ${step.stepType}`,
      });
    }
  }

  if (writeCapableExecuteSteps.length > 0) {
    blockers.push({
      code: PHASE3_VERIFY_ONLY_WRITE_FORBIDDEN,
      messageZh: `存在可写执行步骤: ${writeCapableExecuteSteps.join(',')}`,
    });
  }

  const plannedWrites = classifyLaunchWrites(
    plan.steps.map((s) => ({ stepType: s.stepType, decision: s.decision })),
  );
  if (plannedWrites.totalWritesPlanned > 0) {
    blockers.push({
      code: PHASE3_VERIFY_ONLY_WRITE_FORBIDDEN,
      messageZh: 'Plan 含外部写操作，禁止 Phase 3 verify-only 执行',
    });
  }

  const onlyAllowed =
    executableSteps.length > 0 &&
    executableSteps.every((s) =>
      (PHASE3_ALLOWED_EXECUTE_STEPS as readonly string[]).includes(s),
    );

  if (!onlyAllowed) {
    blockers.push({
      code: PHASE3_VERIFY_ONLY_WRITE_FORBIDDEN,
      messageZh: 'executionSteps 必须仅为 VERIFY_* / FINAL_ACCEPTANCE',
    });
  }

  const unique = [...new Map(blockers.map((b) => [b.code + b.messageZh, b])).values()];

  return {
    ok: unique.length === 0,
    verifyOnlyPlan: unique.length === 0 && onlyAllowed,
    writeCapableExecuteSteps,
    executableSteps,
    blockers: unique,
    plannedWrites,
  };
}

export function emptyExternalWriteCounters() {
  return {
    cloudProviderWriteCount: 0,
    deploymentEnqueueCount: 0,
    gatewayWriteCount: 0,
    dnsWriteCount: 0,
    certificateWriteCount: 0,
    remoteWriteCount: 0,
    launchStateWriteCount: 0,
  };
}

export type ExternalWriteCounters = ReturnType<typeof emptyExternalWriteCounters>;

export function assertNoExternalWrites(counters: ExternalWriteCounters): void {
  const external =
    counters.cloudProviderWriteCount +
    counters.deploymentEnqueueCount +
    counters.gatewayWriteCount +
    counters.dnsWriteCount +
    counters.certificateWriteCount +
    counters.remoteWriteCount;
  if (external > 0) {
    throw new Error(`${PHASE3_VERIFY_ONLY_WRITE_FORBIDDEN}: external_writes=${external}`);
  }
}
