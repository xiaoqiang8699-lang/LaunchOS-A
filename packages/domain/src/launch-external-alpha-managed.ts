/**
 * Step 31.7 — External Alpha shared PLATFORM_MANAGED runtime allocation gates.
 * Existing-resource-only write path (BUILD/DEPLOY/PUBLIC_ENTRY/VERIFY).
 * Never allows PROVISION_* / billable cloud creates.
 */

import type { LaunchPlanResult } from './launch-orchestrator.js';

export const EXTERNAL_ALPHA_MANAGED_WRITE = 'EXTERNAL_ALPHA_MANAGED_WRITE';
export const EXTERNAL_ALPHA_BILLABLE_FORBIDDEN = 'EXTERNAL_ALPHA_BILLABLE_FORBIDDEN';

const FORBIDDEN_PROVISION = new Set([
  'PROVISION_SERVER',
  'PROVISION_POSTGRESQL',
  'PROVISION_REDIS',
]);

const WRITE_OR_VERIFY_PREFIXES = ['BUILD_', 'DEPLOY_', 'APPLY_', 'VERIFY_', 'FINAL_'];

/**
 * True when plan can safely run real BUILD/DEPLOY against existing PLATFORM_MANAGED capacity.
 */
export function isExternalAlphaManagedWriteEligible(
  plan: Pick<
    LaunchPlanResult,
    | 'billableActions'
    | 'resourcesToCreate'
    | 'executionSteps'
    | 'serverReady'
    | 'requiresConfirmation'
  >,
): { ok: boolean; code: string | null; messageZh: string } {
  if (plan.billableActions.length > 0) {
    return {
      ok: false,
      code: EXTERNAL_ALPHA_BILLABLE_FORBIDDEN,
      messageZh: '计划含收费动作，禁止自动执行',
    };
  }
  if (plan.resourcesToCreate.length > 0) {
    return {
      ok: false,
      code: EXTERNAL_ALPHA_BILLABLE_FORBIDDEN,
      messageZh: '计划需要创建云资源，禁止自动执行',
    };
  }
  if (!plan.serverReady) {
    return {
      ok: false,
      code: 'PLATFORM_MANAGED_SERVER_REQUIRED',
      messageZh: '需要可用的平台托管运行节点',
    };
  }
  if (plan.executionSteps.some((step) => FORBIDDEN_PROVISION.has(step))) {
    return {
      ok: false,
      code: EXTERNAL_ALPHA_BILLABLE_FORBIDDEN,
      messageZh: '计划仍包含创建服务器步骤',
    };
  }
  const hasWork = plan.executionSteps.some((step) =>
    WRITE_OR_VERIFY_PREFIXES.some((prefix) => step.startsWith(prefix)),
  );
  if (!hasWork) {
    return {
      ok: false,
      code: 'NO_MANAGED_LAUNCH_STEPS',
      messageZh: '没有可执行的上线步骤',
    };
  }
  return { ok: true, code: null, messageZh: '可使用 LaunchOS 测试运行资源上线' };
}

/** Soft confirm even when ¥0 new cloud resources (External Alpha UX). */
export function shouldSoftConfirmPlatformManagedLaunch(input: {
  serverReady: boolean;
  billableCount: number;
  resourcesToCreateCount: number;
  currentDesiredStateSatisfied: boolean;
  platformManagedAllocated: boolean;
}): boolean {
  if (!input.platformManagedAllocated || !input.serverReady) return false;
  if (input.billableCount > 0 || input.resourcesToCreateCount > 0) return false;
  if (input.currentDesiredStateSatisfied) return false;
  return true;
}
