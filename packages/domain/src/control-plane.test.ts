import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADMIN_CONSOLE_NAV,
  USER_CONSOLE_NAV,
  WORKSPACE_ROLE_LABELS,
  assertAdminRoute,
  assertBillingMutation,
  assertMemberMutation,
  workspaceRoleGrantsPlatformAdmin,
} from './control-plane';

test('workspace role never grants platform admin', () => {
  for (const role of ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']) {
    assert.equal(workspaceRoleGrantsPlatformAdmin(role), false);
  }
});

test('ordinary user and workspace owner cannot open admin', () => {
  assert.deepEqual(assertAdminRoute('USER'), { allowed: false, status: 403 });
  assert.deepEqual(assertAdminRoute('OWNER'), { allowed: false, status: 403 });
});

test('platform admin can open admin', () => {
  assert.deepEqual(assertAdminRoute('PLATFORM_ADMIN'), { allowed: true });
});

test('viewer cannot change members or billing', () => {
  assert.deepEqual(assertMemberMutation({ actorRole: 'VIEWER', action: 'invite', nextRole: 'MEMBER' }), {
    allowed: false,
    status: 403,
  });
  assert.deepEqual(assertMemberMutation({ actorRole: 'VIEWER', action: 'changeRole', targetRole: 'MEMBER', nextRole: 'ADMIN' }), {
    allowed: false,
    status: 403,
  });
  assert.deepEqual(assertMemberMutation({ actorRole: 'VIEWER', action: 'remove', targetRole: 'MEMBER' }), {
    allowed: false,
    status: 403,
  });
  assert.deepEqual(assertBillingMutation('VIEWER'), { allowed: false, status: 403 });
});

test('owner can manage members and billing placeholders', () => {
  assert.deepEqual(assertMemberMutation({ actorRole: 'OWNER', action: 'invite', nextRole: 'MEMBER' }), { allowed: true });
  assert.deepEqual(assertMemberMutation({ actorRole: 'OWNER', action: 'changeRole', targetRole: 'MEMBER', nextRole: 'ADMIN' }), {
    allowed: true,
  });
  assert.deepEqual(assertBillingMutation('OWNER'), { allowed: true });
});

test('user console hides platform surfaces', () => {
  assert.deepEqual([...USER_CONSOLE_NAV], ['我的应用', '工作台', '账户']);
  assert.equal(USER_CONSOLE_NAV.includes('测试记录' as never), false);
  assert.ok(ADMIN_CONSOLE_NAV.includes('平台资源'));
  assert.equal(WORKSPACE_ROLE_LABELS.VIEWER, '只读成员');
});
