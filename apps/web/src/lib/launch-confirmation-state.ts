const BILLABLE_STEP_TYPES = new Set([
  'CREATE_ECS',
  'CREATE_RDS',
  'CREATE_REDIS',
  'PROVISION_SERVER',
  'PROVISION_POSTGRESQL',
  'PROVISION_REDIS',
]);

export type LaunchConfirmationInput = {
  requiresConfirmation: boolean;
  billableStepTypes: string[];
  confirmedPlanHash: string | null;
  planVersion: string | null;
  confirmedForPlanVersion: string | null;
};

export function planNeedsBillingConfirmation(input: LaunchConfirmationInput): {
  needsConfirmation: boolean;
  blockedReason: 'missing' | 'stale' | null;
} {
  const hasBillable =
    input.requiresConfirmation ||
    input.billableStepTypes.some(
      (step) => BILLABLE_STEP_TYPES.has(step) || step.startsWith('CREATE_'),
    );
  if (!hasBillable) {
    return { needsConfirmation: false, blockedReason: null };
  }
  if (!input.confirmedPlanHash) {
    return { needsConfirmation: true, blockedReason: 'missing' };
  }
  if (
    input.planVersion &&
    input.confirmedForPlanVersion &&
    input.planVersion !== input.confirmedForPlanVersion
  ) {
    return { needsConfirmation: true, blockedReason: 'stale' };
  }
  return { needsConfirmation: false, blockedReason: null };
}

export type LaunchPrimaryCta = {
  label: '开始上线' | '正在上线…' | '发布新版本' | '重新尝试' | '重新生成计划' | '确认费用并上线';
  action: 'execute' | 'confirm' | 'replan';
  disabled: boolean;
};

export function resolveLaunchPrimaryCta(input: {
  launchRunStatus: string | null;
  accessEntryActive: boolean;
  latestFinishedLaunchStatus: string | null;
  needsBillingConfirmation: boolean;
  planStale: boolean;
  pending: boolean;
}): LaunchPrimaryCta {
  const status = input.launchRunStatus;
  if (status === 'RUNNING' || status === 'VERIFYING') {
    return { label: '正在上线…', action: 'execute', disabled: true };
  }
  if (input.planStale) {
    return { label: '重新生成计划', action: 'replan', disabled: input.pending };
  }
  if (input.needsBillingConfirmation) {
    return { label: '确认费用并上线', action: 'confirm', disabled: input.pending };
  }
  if (status === 'FAILED') {
    return { label: '重新尝试', action: 'execute', disabled: input.pending };
  }
  const published =
    status === 'SUCCESS' ||
    (input.accessEntryActive && input.latestFinishedLaunchStatus === 'SUCCESS');
  if (published) {
    return { label: '发布新版本', action: 'execute', disabled: input.pending };
  }
  if (input.latestFinishedLaunchStatus === 'FAILED') {
    return { label: '重新尝试', action: 'execute', disabled: input.pending };
  }
  return { label: '开始上线', action: 'execute', disabled: input.pending };
}

export function presentLaunchPageError(error: unknown): { message: string; technical: string | null } {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const name = error instanceof Error ? error.name : '';
  if (name === 'ReferenceError' || /is not defined/.test(raw)) {
    return {
      message: '页面加载失败，请重新生成上线计划后再试。',
      technical: `${name || 'ReferenceError'}: ${raw}`,
    };
  }
  return { message: raw || '生成上线计划失败', technical: null };
}
