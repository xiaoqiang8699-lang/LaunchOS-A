import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RuntimeConfigInjectionPhase } from '@launchos/database';
import {
  buildSecretMetadata,
  computeUnitApplyStatus,
  computeUnitPendingApply,
  sanitizeAuditMetadata,
  summarizeSecurityCounts,
} from './secret-lifecycle.helpers';

describe('computeUnitPendingApply', () => {
  it('detects pending when revision advanced', () => {
    assert.equal(
      computeUnitPendingApply({ currentRevision: 3, appliedRevision: 2, hasRunningService: true }),
      true,
    );
  });

  it('returns false when applied matches current', () => {
    assert.equal(
      computeUnitPendingApply({ currentRevision: 2, appliedRevision: 2, hasRunningService: true }),
      false,
    );
  });
});

describe('computeUnitApplyStatus', () => {
  const requirement = {
    key: 'JWT_SECRET',
    label: 'JWT',
    required: true,
    sensitive: true,
    managedByLaunchOS: false,
    defaultValue: null,
    injectionPhase: RuntimeConfigInjectionPhase.RUNTIME,
  };

  it('returns pending when unit revision is ahead', () => {
    assert.equal(
      computeUnitApplyStatus({
        requirement,
        unitStored: { key: 'JWT_SECRET', valueEncrypted: 'x', isSensitive: true },
        projectStored: undefined,
        pendingApply: true,
      }),
      'pending',
    );
  });

  it('returns missing without effective value', () => {
    assert.equal(
      computeUnitApplyStatus({
        requirement,
        unitStored: undefined,
        projectStored: undefined,
        pendingApply: false,
      }),
      'missing',
    );
  });
});

describe('buildSecretMetadata', () => {
  it('marks overdue secrets without blocking semantics', () => {
    const meta = buildSecretMetadata({
      key: 'JWT_SECRET',
      configured: true,
      needsRedeploy: false,
      valueMeta: {
        key: 'JWT_SECRET',
        valueEncrypted: 'enc',
        isSensitive: true,
        lastRotatedAt: new Date('2025-01-01T00:00:00Z'),
        rotationIntervalDays: 30,
        updatedAt: new Date('2025-01-01T00:00:00Z'),
      },
      now: new Date('2026-03-01T00:00:00Z'),
    });
    assert.equal(meta.rotationStatus, 'OVERDUE');
    assert.equal(meta.needsRedeploy, false);
  });
});

describe('sanitizeAuditMetadata', () => {
  it('keeps only safe fields', () => {
    const safe = sanitizeAuditMetadata({
      previousRevision: 1,
      newRevision: 2,
    });
    assert.deepEqual(safe, { previousRevision: 1, newRevision: 2 });
    assert.equal(Object.hasOwn(safe ?? {}, 'oldValue' as keyof typeof safe), false);
  });
});

describe('summarizeSecurityCounts', () => {
  it('aggregates factual security counts', () => {
    const counts = summarizeSecurityCounts([
      { sensitive: true, needsRedeploy: false, rotationStatus: 'CURRENT' },
      { sensitive: true, needsRedeploy: true, rotationStatus: 'PENDING_REDEPLOY' },
      { sensitive: true, needsRedeploy: false, rotationStatus: 'OVERDUE' },
    ]);
    assert.equal(counts.sensitiveTotal, 3);
    assert.equal(counts.appliedCount, 1);
    assert.equal(counts.pendingRedeployCount, 1);
    assert.equal(counts.overdueOrDueSoonCount, 1);
  });
});
