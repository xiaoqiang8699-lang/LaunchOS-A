/**
 * Safe downgrade / over-quota — never delete resources.
 */

export type ComplianceStatus = 'COMPLIANT' | 'OVER_QUOTA';

export type ComplianceUsage = {
  projects?: number;
  members?: number;
  runningApps?: number;
  retainedVersions?: number;
  monthlyDeployments?: number;
};

export type ComplianceLimits = {
  maxProjects?: number | null;
  maxWorkspaceMembers?: number | null;
  maxMembers?: number | null;
  maxRunningApps?: number | null;
  maxRetainedVersions?: number | null;
  maxMonthlyDeployments?: number | null;
  maxDeploymentsPerMonth?: number | null;
};

export type ComplianceDimension = {
  key: string;
  usage: number;
  limit: number;
  over: boolean;
};

export function evaluateSubscriptionCompliance(input: {
  usage: ComplianceUsage;
  limits: ComplianceLimits;
}): { status: ComplianceStatus; dimensions: ComplianceDimension[]; message: string | null } {
  const dims: ComplianceDimension[] = [];
  const push = (key: string, usage: number | undefined, limit: number | null | undefined) => {
    if (limit == null || usage == null) return;
    dims.push({ key, usage, limit, over: usage > limit });
  };
  push('projects', input.usage.projects, input.limits.maxProjects);
  push('members', input.usage.members, input.limits.maxWorkspaceMembers ?? input.limits.maxMembers);
  push('runningApps', input.usage.runningApps, input.limits.maxRunningApps);
  push('retainedVersions', input.usage.retainedVersions, input.limits.maxRetainedVersions);
  push(
    'monthlyDeployments',
    input.usage.monthlyDeployments,
    input.limits.maxMonthlyDeployments ?? input.limits.maxDeploymentsPerMonth,
  );
  const over = dims.filter((d) => d.over);
  if (!over.length) {
    return { status: 'COMPLIANT', dimensions: dims, message: null };
  }
  return {
    status: 'OVER_QUOTA',
    dimensions: dims,
    message: '当前使用量超过套餐额度，已有数据不会删除，请减少使用量后再新增。',
  };
}

/** New actions blocked when over quota on that dimension; existing resources kept. */
export function overQuotaBlocksCreate(input: {
  status: ComplianceStatus;
  dimensions: ComplianceDimension[];
  action: 'CREATE_PROJECT' | 'INVITE_MEMBER' | 'START_RUNNING_APP' | 'CREATE_VERSION' | 'DEPLOY';
}): boolean {
  if (input.status !== 'OVER_QUOTA') return false;
  const map: Record<string, string> = {
    CREATE_PROJECT: 'projects',
    INVITE_MEMBER: 'members',
    START_RUNNING_APP: 'runningApps',
    CREATE_VERSION: 'retainedVersions',
    DEPLOY: 'monthlyDeployments',
  };
  const key = map[input.action];
  return input.dimensions.some((d) => d.key === key && d.over);
}

export const SAFE_DOWNGRADE_GUARANTEES = {
  projects: 'NO_DELETE',
  members: 'NO_REMOVE',
  runningApps: 'NO_AUTO_STOP',
  versions: 'NO_IMMEDIATE_DELETE',
} as const;
