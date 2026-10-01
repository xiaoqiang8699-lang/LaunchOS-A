export const WORKSPACE_ROLES = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'] as const;
export const PLATFORM_ROLES = ['USER', 'PLATFORM_ADMIN'] as const;

export const WORKSPACE_ROLE_LABELS: Record<(typeof WORKSPACE_ROLES)[number], string> = {
  OWNER: '所有者',
  ADMIN: '管理员',
  MEMBER: '成员',
  VIEWER: '只读成员',
};

export const USER_CONSOLE_NAV = ['我的应用', '工作台', '账户'] as const;

export const ADMIN_CONSOLE_NAV = [
  '总览',
  '用户',
  '工作空间',
  '应用',
  '订阅',
  '账单',
  '平台资源',
  '系统运行',
  '审计',
  'Alpha 测试',
] as const;

export function isPlatformAdmin(platformRole: string): boolean {
  return platformRole === 'PLATFORM_ADMIN';
}

export function workspaceRoleGrantsPlatformAdmin(_workspaceRole: string): false {
  return false;
}

export function assertAdminRoute(platformRole: string): { allowed: true } | { allowed: false; status: 403 } {
  if (isPlatformAdmin(platformRole)) return { allowed: true };
  return { allowed: false, status: 403 };
}

export function assertMemberMutation(input: {
  actorRole: string;
  action: 'invite' | 'changeRole' | 'remove';
  targetRole?: string;
  nextRole?: string;
}): { allowed: true } | { allowed: false; status: 403 } {
  if (input.actorRole !== 'OWNER' && input.actorRole !== 'ADMIN') {
    return { allowed: false, status: 403 };
  }
  const next = input.nextRole ?? input.targetRole;
  if (input.actorRole === 'ADMIN' && (next === 'OWNER' || input.targetRole === 'OWNER')) {
    return { allowed: false, status: 403 };
  }
  return { allowed: true };
}

export function assertBillingMutation(actorRole: string): { allowed: true } | { allowed: false; status: 403 } {
  if (actorRole === 'VIEWER') return { allowed: false, status: 403 };
  if (actorRole === 'OWNER' || actorRole === 'ADMIN') return { allowed: true };
  return { allowed: false, status: 403 };
}
