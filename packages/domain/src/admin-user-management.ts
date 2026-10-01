export const ACCOUNT_STATUSES = ['ACTIVE', 'SUSPENDED', 'ARCHIVED'] as const;
export const PERMANENT_DELETE_PHRASE = '永久删除后无法恢复。';

export const ADMIN_USER_AUDIT_ACTIONS = [
  'ADMIN_USER_UPDATED',
  'ADMIN_USER_SUSPENDED',
  'ADMIN_USER_RESTORED',
  'ADMIN_USER_ONBOARDING_RESET',
  'ADMIN_USER_ROLE_CHANGED',
  'ADMIN_USER_SESSIONS_REVOKED',
  'ADMIN_USER_ARCHIVED',
  'ADMIN_USER_DELETED',
] as const;

const SECRET_KEY = /password|token|secret|credential|hash|accesskey|secretkey|access_key|secret_key/i;

export function platformRoleLabel(role: string): string {
  return role === 'PLATFORM_ADMIN' ? '平台管理员' : '普通用户';
}

export function accountStatusLabel(status: string): string {
  if (status === 'SUSPENDED') return '已停用';
  if (status === 'ARCHIVED') return '已归档';
  return '正常';
}

export function assertAccountCanUseProduct(
  status: string,
): { allowed: true } | { allowed: false; status: 401; message: string } {
  if (status === 'SUSPENDED') return { allowed: false, status: 401, message: '账号已停用，无法登录' };
  if (status === 'ARCHIVED') return { allowed: false, status: 401, message: '账号已归档，无法登录' };
  return { allowed: true };
}

export function assertLastPlatformAdminPreserved(input: {
  isPlatformAdmin: boolean;
  platformAdminCount: number;
  removesAdmin: boolean;
}): { ok: true } | { ok: false; code: 'LAST_PLATFORM_ADMIN_PROTECTED' } {
  if (input.removesAdmin && input.isPlatformAdmin && input.platformAdminCount <= 1) {
    return { ok: false, code: 'LAST_PLATFORM_ADMIN_PROTECTED' };
  }
  return { ok: true };
}

export function assertEmailAvailable(input: {
  email: string;
  takenByOther: boolean;
}): { ok: true; email: string } | { ok: false; status: 409 } {
  const email = input.email.trim().toLowerCase();
  if (!email || input.takenByOther) return { ok: false, status: 409 };
  return { ok: true, email };
}

export function resetOnboardingPatch(): {
  onboardingStatus: 'NOT_STARTED';
  onboardingCompletedAt: null;
  hasCompletedOnboarding: false;
} {
  return {
    onboardingStatus: 'NOT_STARTED',
    onboardingCompletedAt: null,
    hasCompletedOnboarding: false,
  };
}

export function sanitizeAdminAuditMetadata(input: unknown): Record<string, string | number | boolean | null> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (SECRET_KEY.test(key)) continue;
    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
      continue;
    }
    if (typeof value === 'string' && !SECRET_KEY.test(value)) out[key] = value;
  }
  return out;
}

export function permanentDeleteBlockers(input: {
  ownedWorkspaces: Array<{
    otherMembers: number;
    projects: number;
    cloudResources: number;
    runningApplications: number;
    activeSubscription: boolean;
    unpaidInvoice: boolean;
  }>;
  foreignMemberships: number;
}): string[] {
  const blockers: string[] = [];
  if (input.ownedWorkspaces.some((workspace) => workspace.otherMembers > 0 || workspace.projects > 0)) {
    blockers.push('ownsWorkspace');
  }
  if (input.ownedWorkspaces.some((workspace) => workspace.activeSubscription)) blockers.push('activeSubscription');
  if (input.ownedWorkspaces.some((workspace) => workspace.unpaidInvoice)) blockers.push('unpaidInvoice');
  if (input.ownedWorkspaces.some((workspace) => workspace.runningApplications > 0)) blockers.push('runningApplications');
  if (input.ownedWorkspaces.some((workspace) => workspace.cloudResources > 0)) blockers.push('cloudResources');
  if (input.foreignMemberships > 0 || input.ownedWorkspaces.some((workspace) => workspace.otherMembers > 0)) {
    blockers.push('otherWorkspaceMembers');
  }
  return blockers;
}

export function assertPermanentDeleteConfirmation(input: {
  email: string;
  typedEmail: string;
  phrase: string;
}): { ok: true } | { ok: false; message: string } {
  if (input.typedEmail.trim().toLowerCase() !== input.email.trim().toLowerCase()) {
    return { ok: false, message: '请输入该用户的邮箱以确认' };
  }
  if (input.phrase.trim() !== PERMANENT_DELETE_PHRASE) {
    return { ok: false, message: '确认文案不正确' };
  }
  return { ok: true };
}

export function matchesAdminUserSearch(user: { name: string; email: string }, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return user.name.toLowerCase().includes(needle) || user.email.toLowerCase().includes(needle);
}

export function matchesAdminUserFilters(
  user: { platformRole: string; accountStatus: string; subscriptionStatus: string; createdAt: string },
  filters: { platformRole?: string; accountStatus?: string; subscriptionStatus?: string; registeredFrom?: string; registeredTo?: string },
): boolean {
  if (filters.platformRole && user.platformRole !== filters.platformRole) return false;
  if (filters.accountStatus && user.accountStatus !== filters.accountStatus) return false;
  if (filters.subscriptionStatus && user.subscriptionStatus !== filters.subscriptionStatus) return false;
  const created = new Date(user.createdAt).getTime();
  if (filters.registeredFrom && created < new Date(filters.registeredFrom).getTime()) return false;
  if (filters.registeredTo && created > new Date(filters.registeredTo).getTime()) return false;
  return true;
}

export function sliceAdminUserPage<T>(items: T[], page: number, pageSize: number): {
  page: number;
  pageSize: number;
  total: number;
  items: T[];
} {
  const size = Math.min(50, Math.max(1, Math.floor(pageSize) || 20));
  const current = Math.max(1, Math.floor(page) || 1);
  const start = (current - 1) * size;
  return { page: current, pageSize: size, total: items.length, items: items.slice(start, start + size) };
}
