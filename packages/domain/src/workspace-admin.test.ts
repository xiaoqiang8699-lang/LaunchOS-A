import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAdminRoute } from './control-plane';
import { sanitizeAdminAuditMetadata } from './admin-user-management';
import {
  assertWorkspaceArchive,
  assertWorkspaceMutable,
  buildUsageSnapshot,
  evaluateWorkspaceQuota,
  latestActivity,
  matchesWorkspaceFilters,
  matchesWorkspaceSearch,
  memberWorkspaceView,
  presentUnknownMetric,
  slicePage,
  subscriptionBillingSubject,
  suspendKeepsRunningServices,
  transferWorkspaceOwner,
  workspaceDeleteBlockers,
  workspaceStatusLabel,
} from './workspace-admin';

test('user and workspace owner cannot open admin workspaces', () => {
  assert.deepEqual(assertAdminRoute('USER'), { allowed: false, status: 403 });
  assert.deepEqual(assertAdminRoute('OWNER'), { allowed: false, status: 403 });
  assert.deepEqual(assertAdminRoute('PLATFORM_ADMIN'), { allowed: true });
});

test('search, filters, and pagination', () => {
  const row = { name: '甲的工作空间', ownerName: '甲', ownerEmail: 'jia@example.com', status: 'ACTIVE', planCode: 'alpha', subscriptionStatus: 'NONE', createdAt: '2026-09-02T00:00:00.000Z' };
  assert.equal(matchesWorkspaceSearch(row, 'jia@'), true);
  assert.equal(matchesWorkspaceSearch(row, '不存在'), false);
  assert.equal(matchesWorkspaceFilters(row, { status: 'ACTIVE', planCode: 'alpha', subscriptionStatus: 'NONE' }), true);
  assert.equal(matchesWorkspaceFilters(row, { status: 'SUSPENDED' }), false);
  const page = slicePage([1, 2, 3], 2, 1);
  assert.deepEqual(page.items, [2]);
  assert.equal(page.items.length <= page.pageSize, true);
});

test('owner transfer keeps a single owner and requires membership', () => {
  const moved = transferWorkspaceOwner({
    members: [
      { userId: 'a', role: 'OWNER' },
      { userId: 'b', role: 'MEMBER' },
    ],
    fromUserId: 'a',
    toUserId: 'b',
  });
  assert.equal(moved.ok, true);
  if (moved.ok) {
    assert.deepEqual(
      moved.members.map((member) => member.role),
      ['ADMIN', 'OWNER'],
    );
    assert.equal(moved.members.filter((member) => member.role === 'OWNER').length, 1);
  }
  assert.equal(transferWorkspaceOwner({ members: [{ userId: 'a', role: 'OWNER' }], fromUserId: 'a', toUserId: 'c' }).ok, false);
});

test('subscription stays on the workspace and invoices are not amount editors', () => {
  assert.equal(subscriptionBillingSubject({ workspaceId: 'ws' }), 'workspace');
  assert.equal(subscriptionBillingSubject({ workspaceId: 'ws', userId: 'user' }), 'invalid');
});

test('usage snapshot leaves unknown metrics empty and quota can exceed without stopping service', () => {
  const snapshot = buildUsageSnapshot({
    projectCount: 3,
    memberCount: 2,
    activeServiceCount: 1,
    deploymentCount: 4,
    successfulDeploymentCount: 3,
    failedDeploymentCount: 1,
    buildCount: 4,
    serverCount: 1,
    databaseCount: 0,
    redisCount: 0,
  });
  assert.equal(snapshot.estimated, true);
  assert.equal(snapshot.bandwidthBytes, null);
  assert.equal(presentUnknownMetric(snapshot.bandwidthBytes), '暂未统计');
  assert.equal(presentUnknownMetric(0), 0);
  const quota = evaluateWorkspaceQuota({
    limits: { projects: 2, members: null },
    usage: { projects: 3, members: 2 },
  });
  assert.equal(quota.status, 'OVER_LIMIT');
  assert.equal(quota.lines.projects?.remaining, 0);
  assert.equal(quota.lines.members?.exceeded, false);
  assert.equal(quota.blocksService, false);
  assert.equal(quota.hint, '当前使用量已超过套餐建议范围');
});

test('suspend blocks new work but keeps running apps, restore and archive are guarded', () => {
  assert.equal(workspaceStatusLabel('SUSPENDED'), '已暂停');
  assert.equal(assertWorkspaceMutable('SUSPENDED').allowed, false);
  assert.equal(assertWorkspaceMutable('ACTIVE').allowed, true);
  assert.equal(suspendKeepsRunningServices(), true);
  assert.equal(assertWorkspaceArchive({ activeSubscriptions: 1, runningLaunchRuns: 0 }).ok, false);
  assert.equal(assertWorkspaceArchive({ activeSubscriptions: 0, runningLaunchRuns: 1 }).ok, false);
  assert.equal(assertWorkspaceArchive({ activeSubscriptions: 0, runningLaunchRuns: 0 }).ok, true);
});

test('only an empty workspace can be deleted and admin notes stay internal', () => {
  assert.deepEqual(
    workspaceDeleteBlockers({ projects: 1, extraMembers: 0, subscriptions: 0, invoices: 0, servers: 0, databases: 0, redis: 0, domains: 0, activeServices: 0 }),
    ['projects'],
  );
  assert.deepEqual(
    workspaceDeleteBlockers({ projects: 0, extraMembers: 0, subscriptions: 0, invoices: 0, servers: 0, databases: 0, redis: 0, domains: 0, activeServices: 0 }),
    [],
  );
  const visible = memberWorkspaceView({ name: '甲', adminNote: '内部备注' });
  assert.equal('adminNote' in visible, false);
});

test('last active comes from business events and audit metadata drops secrets', () => {
  assert.equal(latestActivity(['2026-09-01T00:00:00.000Z', '2026-09-03T00:00:00.000Z', null]), '2026-09-03T00:00:00.000Z');
  assert.deepEqual(sanitizeAdminAuditMetadata({ planCode: 'alpha', password: 'x', token: 'y', overrideSource: 'MANUAL_ADMIN_OVERRIDE' }), {
    planCode: 'alpha',
    overrideSource: 'MANUAL_ADMIN_OVERRIDE',
  });
});
