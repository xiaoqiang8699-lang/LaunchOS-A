export const WORKSPACE_STATUSES = ['ACTIVE', 'SUSPENDED', 'ARCHIVED'] as const;
export const FUTURE_PLAN_CODES = ['free', 'pro', 'team', 'enterprise'] as const;
export const QUOTA_HINT = '当前使用量已超过套餐建议范围';

export const WORKSPACE_AUDIT_ACTIONS = [
  'ADMIN_WORKSPACE_UPDATED',
  'WORKSPACE_OWNER_TRANSFERRED',
  'WORKSPACE_SUSPENDED',
  'WORKSPACE_RESTORED',
  'WORKSPACE_ARCHIVED',
  'WORKSPACE_PLAN_OVERRIDDEN',
  'WORKSPACE_QUOTA_EXCEEDED',
] as const;

export function workspaceStatusLabel(status: string): string {
  if (status === 'SUSPENDED') return '已暂停';
  if (status === 'ARCHIVED') return '已归档';
  return '正常';
}

export function assertWorkspaceMutable(
  status: string,
): { allowed: true } | { allowed: false; message: string } {
  if (status === 'SUSPENDED') {
    return { allowed: false, message: '工作空间已暂停，不能进行新的操作。现有线上服务保持运行。' };
  }
  if (status === 'ARCHIVED') return { allowed: false, message: '工作空间已归档，只能查看。' };
  return { allowed: true };
}

export function suspendKeepsRunningServices(): true {
  return true;
}

export function assertWorkspaceArchive(input: {
  activeSubscriptions: number;
  runningLaunchRuns: number;
}): { ok: true } | { ok: false; message: string } {
  if (input.activeSubscriptions > 0) return { ok: false, message: '仍有有效订阅，不能归档' };
  if (input.runningLaunchRuns > 0) return { ok: false, message: '仍有进行中的上线，不能归档' };
  return { ok: true };
}

export function transferWorkspaceOwner(input: {
  members: Array<{ userId: string; role: string }>;
  fromUserId: string;
  toUserId: string;
}): { ok: true; members: Array<{ userId: string; role: string }> } | { ok: false; message: string } {
  if (!input.members.some((member) => member.userId === input.toUserId)) {
    return { ok: false, message: '目标用户还不是工作空间成员' };
  }
  const members = input.members.map((member) => {
    if (member.userId === input.toUserId) return { ...member, role: 'OWNER' };
    if (member.role === 'OWNER' || member.userId === input.fromUserId) return { ...member, role: 'ADMIN' };
    return member;
  });
  const owners = members.filter((member) => member.role === 'OWNER');
  if (owners.length !== 1 || owners[0]?.userId !== input.toUserId) {
    return { ok: false, message: '工作空间必须只有一个所有者' };
  }
  return { ok: true, members };
}

export function workspaceDeleteBlockers(input: {
  projects: number;
  extraMembers: number;
  subscriptions: number;
  invoices: number;
  servers: number;
  databases: number;
  redis: number;
  domains: number;
  activeServices: number;
}): string[] {
  const blockers: string[] = [];
  if (input.projects > 0) blockers.push('projects');
  if (input.extraMembers > 0) blockers.push('members');
  if (input.subscriptions > 0) blockers.push('subscriptions');
  if (input.invoices > 0) blockers.push('invoices');
  if (input.servers > 0) blockers.push('servers');
  if (input.databases > 0) blockers.push('databases');
  if (input.redis > 0) blockers.push('redis');
  if (input.domains > 0) blockers.push('domains');
  if (input.activeServices > 0) blockers.push('activeServices');
  return blockers;
}

export type QuotaLine = { used: number; limit: number | null; remaining: number | null; exceeded: boolean };

export function evaluateWorkspaceQuota(input: {
  limits: Record<string, number | null>;
  usage: Record<string, number>;
}): { status: 'OK' | 'OVER_LIMIT'; lines: Record<string, QuotaLine>; blocksService: false; hint: string | null } {
  const lines: Record<string, QuotaLine> = {};
  let exceeded = false;
  for (const key of Object.keys(input.usage)) {
    const used = input.usage[key] ?? 0;
    const limit = input.limits[key] ?? null;
    const over = limit != null && used > limit;
    if (over) exceeded = true;
    lines[key] = {
      used,
      limit,
      remaining: limit == null ? null : Math.max(0, limit - used),
      exceeded: over,
    };
  }
  return {
    status: exceeded ? 'OVER_LIMIT' : 'OK',
    lines,
    blocksService: false,
    hint: exceeded ? QUOTA_HINT : null,
  };
}

export function buildUsageSnapshot(input: {
  projectCount: number;
  memberCount: number;
  activeServiceCount: number;
  deploymentCount: number;
  successfulDeploymentCount: number;
  failedDeploymentCount: number;
  buildCount: number;
  serverCount: number;
  databaseCount: number;
  redisCount: number;
  buildDurationSeconds?: number | null;
  bandwidthBytes?: number | null;
  storageBytes?: number | null;
  estimatedCloudCost?: number | null;
}): {
  projectCount: number;
  memberCount: number;
  activeServiceCount: number;
  deploymentCount: number;
  successfulDeploymentCount: number;
  failedDeploymentCount: number;
  buildCount: number;
  serverCount: number;
  databaseCount: number;
  redisCount: number;
  buildDurationSeconds: number | null;
  bandwidthBytes: number | null;
  storageBytes: number | null;
  estimatedCloudCost: number | null;
  estimated: true;
} {
  return {
    projectCount: input.projectCount,
    memberCount: input.memberCount,
    activeServiceCount: input.activeServiceCount,
    deploymentCount: input.deploymentCount,
    successfulDeploymentCount: input.successfulDeploymentCount,
    failedDeploymentCount: input.failedDeploymentCount,
    buildCount: input.buildCount,
    serverCount: input.serverCount,
    databaseCount: input.databaseCount,
    redisCount: input.redisCount,
    buildDurationSeconds: input.buildDurationSeconds ?? null,
    bandwidthBytes: input.bandwidthBytes ?? null,
    storageBytes: input.storageBytes ?? null,
    estimatedCloudCost: input.estimatedCloudCost ?? null,
    estimated: true,
  };
}

export function latestActivity(times: Array<string | null | undefined>): string | null {
  const stamps = times.filter((value): value is string => Boolean(value)).map((value) => new Date(value).getTime());
  if (stamps.length === 0) return null;
  return new Date(Math.max(...stamps)).toISOString();
}

export function matchesWorkspaceSearch(
  workspace: { name: string; ownerName: string; ownerEmail: string },
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [workspace.name, workspace.ownerName, workspace.ownerEmail].some((value) => value.toLowerCase().includes(needle));
}

export function matchesWorkspaceFilters(
  workspace: { status: string; planCode: string; subscriptionStatus: string; createdAt: string },
  filters: { status?: string; planCode?: string; subscriptionStatus?: string; registeredFrom?: string; registeredTo?: string },
): boolean {
  if (filters.status && workspace.status !== filters.status) return false;
  if (filters.planCode && workspace.planCode !== filters.planCode) return false;
  if (filters.subscriptionStatus && workspace.subscriptionStatus !== filters.subscriptionStatus) return false;
  const created = new Date(workspace.createdAt).getTime();
  if (filters.registeredFrom && created < new Date(filters.registeredFrom).getTime()) return false;
  if (filters.registeredTo && created > new Date(filters.registeredTo).getTime()) return false;
  return true;
}

export function slicePage<T>(items: T[], page: number, pageSize: number): { page: number; pageSize: number; total: number; items: T[] } {
  const size = Math.min(50, Math.max(1, Math.floor(pageSize) || 20));
  const current = Math.max(1, Math.floor(page) || 1);
  const start = (current - 1) * size;
  return { page: current, pageSize: size, total: items.length, items: items.slice(start, start + size) };
}

export function memberWorkspaceView<T extends { adminNote?: string | null }>(workspace: T): Omit<T, 'adminNote'> {
  const copy = { ...workspace };
  delete copy.adminNote;
  return copy;
}

export function subscriptionBillingSubject(subscription: { workspaceId?: string | null; userId?: string | null }): 'workspace' | 'invalid' {
  if (subscription.workspaceId && !subscription.userId) return 'workspace';
  return 'invalid';
}

export function presentUnknownMetric(value: number | null | undefined): number | '暂未统计' {
  if (value == null) return '暂未统计';
  return value;
}
