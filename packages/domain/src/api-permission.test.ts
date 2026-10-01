import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WorkspaceRole } from '@launchos/database';

/** Mirrors SystemDomainApiService.requireOwner role gate (no Nest bootstrap). */
function canManageSystemDomain(role: WorkspaceRole): boolean {
  return role === WorkspaceRole.OWNER || role === WorkspaceRole.ADMIN;
}

describe('system-domain certificate API permission', () => {
  it('allows OWNER and ADMIN only', () => {
    assert.equal(canManageSystemDomain(WorkspaceRole.OWNER), true);
    assert.equal(canManageSystemDomain(WorkspaceRole.ADMIN), true);
    assert.equal(canManageSystemDomain(WorkspaceRole.MEMBER), false);
    assert.equal(canManageSystemDomain(WorkspaceRole.VIEWER), false);
  });
});
