/**
 * Product Alpha execute gates. The orchestrator remains the only executor.
 */

import { validateConfirmation, type LaunchConfirmationPayload, type LaunchConfirmationRecord } from './launch-confirmation.js';
import { detectPlanStale } from './launch-orchestrator.js';
import { launchErrorUserMessage } from './launch-user-messages.js';

export const ALPHA_UNSUPPORTED_APPLICATION = 'ALPHA_UNSUPPORTED_APPLICATION';
export const PRODUCT_LAUNCH_ROLES = ['OWNER', 'ADMIN', 'MEMBER'] as const;

const ALPHA_UNIT_TYPES = new Set(['WEB', 'API']);

export function canRoleExecuteLaunch(role: string): boolean {
  return (PRODUCT_LAUNCH_ROLES as readonly string[]).includes(role);
}

export function assertAlphaApplicationScope(input: {
  unitTypes: string[];
  stepTypes: string[];
  knownStepTypes: readonly string[];
}): { ok: boolean; code: string | null; messageZh: string } {
  const units = input.unitTypes.filter(Boolean);
  const unsupportedUnit = units.some((type) => !ALPHA_UNIT_TYPES.has(type));
  const known = new Set(input.knownStepTypes);
  const unsupportedStep = input.stepTypes.some((type) => !known.has(type));
  if (units.length === 0 || unsupportedUnit || unsupportedStep) {
    return {
      ok: false,
      code: ALPHA_UNSUPPORTED_APPLICATION,
      messageZh: '当前 Alpha 暂不支持这个应用结构。',
    };
  }
  const hasWeb = units.includes('WEB');
  const hasApi = units.includes('API');
  if (!hasWeb && !hasApi) {
    return {
      ok: false,
      code: ALPHA_UNSUPPORTED_APPLICATION,
      messageZh: '当前 Alpha 暂不支持这个应用结构。',
    };
  }
  return { ok: true, code: null, messageZh: '当前应用结构在 Alpha 支持范围内' };
}

export function evaluateProductPlanFreshness(input: {
  savedSnapshot: Record<string, unknown>;
  currentSnapshot: Record<string, unknown>;
}): { ok: boolean; code: string | null; messageZh: string } {
  const stale = detectPlanStale(input.savedSnapshot, input.currentSnapshot);
  if (stale.stale) {
    return {
      ok: false,
      code: 'PLAN_STALE',
      messageZh: '上线计划发生变化，请重新确认。',
    };
  }
  return { ok: true, code: null, messageZh: '上线计划仍然有效' };
}

export function evaluateProductBillingGate(input: {
  requiresConfirmation: boolean;
  billableStepTypes: string[];
  record: LaunchConfirmationRecord | null;
  currentPayload: LaunchConfirmationPayload;
}): { ok: boolean; code: string | null; messageZh: string } {
  const billable = new Set([
    'CREATE_ECS',
    'CREATE_RDS',
    'CREATE_REDIS',
    'PROVISION_SERVER',
    'PROVISION_POSTGRESQL',
    'PROVISION_REDIS',
  ]);
  const hasBillable = input.billableStepTypes.some((step) => billable.has(step) || step.startsWith('CREATE_'));
  const requires = input.requiresConfirmation || hasBillable;
  const result = validateConfirmation({
    record: input.record,
    currentPayload: input.currentPayload,
    requiresConfirmation: requires,
  });
  if (!result.ok) {
    return {
      ok: false,
      code: result.code ?? 'BILLABLE_ACTION_CONFIRMATION_REQUIRED',
      messageZh: '需要先确认云资源费用。',
    };
  }
  return { ok: true, code: null, messageZh: result.messageZh || launchErrorUserMessage(null) };
}

export function duplicateLaunchMessage(): { code: 'LAUNCH_ALREADY_RUNNING'; messageZh: string } {
  return { code: 'LAUNCH_ALREADY_RUNNING', messageZh: '应用正在上线，请稍候。' };
}
