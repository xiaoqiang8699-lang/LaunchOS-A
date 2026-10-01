import type { WorkspaceSummary } from './types';

export type WorkspaceRole = WorkspaceSummary['role'];

const WORKSPACE_ROLE_LABELS: Record<WorkspaceRole, string> = {
  OWNER: '所有者',
  ADMIN: '管理员',
  MEMBER: '成员',
  VIEWER: '访客',
};

export function isWorkspaceAdmin(role: WorkspaceRole | null | undefined): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

export function workspaceRoleLabel(role: WorkspaceRole | null | undefined): string {
  if (!role) {
    return '';
  }
  return WORKSPACE_ROLE_LABELS[role];
}
