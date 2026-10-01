import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  computeRotationStatus,
  daysSince,
  formatDaysAgo,
  suggestRotationIntervalDays,
} from './secret-rotation';

describe('computeRotationStatus', () => {
  const now = new Date('2026-03-01T00:00:00Z');

  it('returns MISSING when not configured', () => {
    assert.equal(
      computeRotationStatus({
        configured: false,
        needsRedeploy: false,
        lastRotatedAt: null,
        rotationIntervalDays: 90,
        now,
      }),
      'MISSING',
    );
  });

  it('returns PENDING_REDEPLOY when needsRedeploy', () => {
    assert.equal(
      computeRotationStatus({
        configured: true,
        needsRedeploy: true,
        lastRotatedAt: now,
        rotationIntervalDays: 90,
        now,
      }),
      'PENDING_REDEPLOY',
    );
  });

  it('returns CURRENT without interval', () => {
    assert.equal(
      computeRotationStatus({
        configured: true,
        needsRedeploy: false,
        lastRotatedAt: new Date('2025-01-01'),
        rotationIntervalDays: null,
        now,
      }),
      'CURRENT',
    );
  });

  it('returns DUE_SOON within lead window', () => {
    assert.equal(
      computeRotationStatus({
        configured: true,
        needsRedeploy: false,
        lastRotatedAt: new Date('2025-12-02T00:00:00Z'),
        rotationIntervalDays: 90,
        now,
      }),
      'DUE_SOON',
    );
  });

  it('returns OVERDUE when past interval', () => {
    assert.equal(
      computeRotationStatus({
        configured: true,
        needsRedeploy: false,
        lastRotatedAt: new Date('2025-11-01T00:00:00Z'),
        rotationIntervalDays: 30,
        now,
      }),
      'OVERDUE',
    );
  });
});

describe('daysSince', () => {
  it('counts whole days', () => {
    const now = new Date('2026-03-10T12:00:00Z');
    const then = new Date('2026-03-08T12:00:00Z');
    assert.equal(daysSince(then, now), 2);
  });
});

describe('formatDaysAgo', () => {
  it('formats recent updates', () => {
    const now = new Date('2026-03-10T12:00:00Z');
    assert.equal(formatDaysAgo(new Date('2026-03-10T10:00:00Z'), now), '刚刚');
    assert.equal(formatDaysAgo(new Date('2026-03-09T12:00:00Z'), now), '1 天前');
  });
});

describe('suggestRotationIntervalDays', () => {
  it('suggests 90 days for common secret keys', () => {
    assert.equal(suggestRotationIntervalDays('JWT_SECRET'), 90);
    assert.equal(suggestRotationIntervalDays('OPENAI_API_KEY'), 90);
  });

  it('returns null for generic keys', () => {
    assert.equal(suggestRotationIntervalDays('PUBLIC_URL'), null);
  });
});
