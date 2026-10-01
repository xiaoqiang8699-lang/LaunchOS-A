import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAdminRoute } from './control-plane';
import {
  accountStatusLabel,
  assertAccountCanUseProduct,
  assertEmailAvailable,
  assertLastPlatformAdminPreserved,
  assertPermanentDeleteConfirmation,
  matchesAdminUserFilters,
  matchesAdminUserSearch,
  permanentDeleteBlockers,
  platformRoleLabel,
  resetOnboardingPatch,
  sanitizeAdminAuditMetadata,
  sliceAdminUserPage,
} from './admin-user-management';

const emptyWorkspace = {
  otherMembers: 0,
  projects: 0,
  cloudResources: 0,
  runningApplications: 0,
  activeSubscription: false,
  unpaidInvoice: false,
};

test('USER and workspace owner cannot open admin users', () => {
  assert.deepEqual(assertAdminRoute('USER'), { allowed: false, status: 403 });
  assert.deepEqual(assertAdminRoute('OWNER'), { allowed: false, status: 403 });
  assert.deepEqual(assertAdminRoute('PLATFORM_ADMIN'), { allowed: true });
});

test('edit display name stays on the user record and email must be unique', () => {
  assert.equal(platformRoleLabel('USER'), '普通用户');
  assert.equal(accountStatusLabel('ACTIVE'), '正常');
  assert.deepEqual(assertEmailAvailable({ email: 'New@Example.com', takenByOther: false }), {
    ok: true,
    email: 'new@example.com',
  });
  assert.deepEqual(assertEmailAvailable({ email: 'taken@example.com', takenByOther: true }), { ok: false, status: 409 });
});

test('suspend blocks login and product use, restore allows it', () => {
  assert.equal(assertAccountCanUseProduct('SUSPENDED').allowed, false);
  assert.equal(assertAccountCanUseProduct('ARCHIVED').allowed, false);
  assert.deepEqual(assertAccountCanUseProduct('ACTIVE'), { allowed: true });
});

test('reset onboarding does not touch projects', () => {
  const patch = resetOnboardingPatch();
  assert.equal(patch.onboardingStatus, 'NOT_STARTED');
  assert.equal(patch.onboardingCompletedAt, null);
  assert.equal(patch.hasCompletedOnboarding, false);
  assert.equal('projects' in patch, false);
});

test('last platform admin cannot be removed', () => {
  assert.deepEqual(
    assertLastPlatformAdminPreserved({ isPlatformAdmin: true, platformAdminCount: 1, removesAdmin: true }),
    { ok: false, code: 'LAST_PLATFORM_ADMIN_PROTECTED' },
  );
  assert.deepEqual(
    assertLastPlatformAdminPreserved({ isPlatformAdmin: true, platformAdminCount: 2, removesAdmin: true }),
    { ok: true },
  );
});

test('archive is the normal path and permanent delete is blocked by workspace resources', () => {
  assert.equal(accountStatusLabel('ARCHIVED'), '已归档');
  assert.deepEqual(permanentDeleteBlockers({ ownedWorkspaces: [{ ...emptyWorkspace, projects: 1 }], foreignMemberships: 0 }), [
    'ownsWorkspace',
  ]);
  assert.ok(
    permanentDeleteBlockers({
      ownedWorkspaces: [{ ...emptyWorkspace, cloudResources: 2, runningApplications: 1, activeSubscription: true, unpaidInvoice: true }],
      foreignMemberships: 1,
    }).includes('cloudResources'),
  );
});

test('a clean test user can be permanently deleted after confirmation', () => {
  assert.deepEqual(permanentDeleteBlockers({ ownedWorkspaces: [emptyWorkspace], foreignMemberships: 0 }), []);
  assert.equal(assertPermanentDeleteConfirmation({ email: 'a@example.com', typedEmail: 'A@example.com', phrase: '永久删除后无法恢复。' }).ok, true);
  assert.equal(assertPermanentDeleteConfirmation({ email: 'a@example.com', typedEmail: 'other@example.com', phrase: '永久删除后无法恢复。' }).ok, false);
});

test('search, filters, and pagination do not return the whole list', () => {
  const ordinary = { name: '小红', email: 'hong@example.com', platformRole: 'USER', accountStatus: 'ACTIVE', subscriptionStatus: 'NONE', createdAt: '2026-09-01T00:00:00.000Z' };
  const admin = { name: '管理员', email: 'admin@example.com', platformRole: 'PLATFORM_ADMIN', accountStatus: 'SUSPENDED', subscriptionStatus: 'ACTIVE', createdAt: '2026-09-20T00:00:00.000Z' };
  assert.equal(matchesAdminUserSearch(ordinary, 'hong@'), true);
  assert.equal(matchesAdminUserSearch(ordinary, '不存在'), false);
  assert.equal(matchesAdminUserFilters(admin, { platformRole: 'PLATFORM_ADMIN', accountStatus: 'SUSPENDED', subscriptionStatus: 'ACTIVE' }), true);
  assert.equal(matchesAdminUserFilters(ordinary, { registeredFrom: '2026-09-10T00:00:00.000Z' }), false);
  const page = sliceAdminUserPage([1, 2, 3, 4, 5], 2, 2);
  assert.deepEqual(page.items, [3, 4]);
  assert.equal(page.total, 5);
  assert.equal(page.items.length <= page.pageSize, true);
});

test('audit metadata drops secrets', () => {
  assert.deepEqual(
    sanitizeAdminAuditMetadata({
      displayName: '新名字',
      password: 'secret-value',
      passwordHash: 'hash',
      token: 'jwt',
      credential: 'key',
      adminUserId: 'admin-1',
      targetUserId: 'user-1',
    }),
    { displayName: '新名字', adminUserId: 'admin-1', targetUserId: 'user-1' },
  );
});
