/**
 * Step 30 Phase 2 — confirmation snapshot + plan hash.
 * Billable steps must have matching confirmedPlanHash before provider calls.
 */

import { createHash } from 'node:crypto';
import type { BillableAction } from './launch-orchestrator.js';

export type LaunchConfirmationPayload = {
  planVersion: string;
  projectId: string;
  environmentId: string;
  provider?: string | null;
  billableActions: Array<{
    stepType: string;
    labelZh: string;
    profileHint?: string | null;
    estimatedCostAvailable?: boolean;
  }>;
  resourcesToCreate: Array<{ kind: string; labelZh: string }>;
};

export type LaunchConfirmationRecord = {
  confirmationId: string;
  confirmedAt: string;
  confirmedByUserId: string;
  confirmedPlanHash: string;
  planVersion: string;
  snapshot: LaunchConfirmationPayload;
};

export function buildConfirmationPayload(input: {
  planVersion: string;
  projectId: string;
  environmentId: string;
  provider?: string | null;
  billableActions: BillableAction[];
  resourcesToCreate: Array<{ kind: string; labelZh: string }>;
}): LaunchConfirmationPayload {
  return {
    planVersion: input.planVersion,
    projectId: input.projectId,
    environmentId: input.environmentId,
    provider: input.provider ?? 'ALIYUN',
    billableActions: input.billableActions.map((a) => ({
      stepType: a.stepType,
      labelZh: a.labelZh,
      profileHint: a.profileHint ?? null,
      estimatedCostAvailable: a.estimatedCostAvailable,
    })),
    resourcesToCreate: input.resourcesToCreate.map((r) => ({
      kind: r.kind,
      labelZh: r.labelZh,
    })),
  };
}

/** Stable hash over confirmation material — no secrets. */
export function hashConfirmationPayload(payload: LaunchConfirmationPayload): string {
  const stable = {
    planVersion: payload.planVersion,
    projectId: payload.projectId,
    environmentId: payload.environmentId,
    provider: payload.provider ?? null,
    billableActions: [...payload.billableActions]
      .map((a) => ({
        stepType: a.stepType,
        labelZh: a.labelZh,
        profileHint: a.profileHint ?? null,
      }))
      .sort((a, b) => a.stepType.localeCompare(b.stepType)),
    resourcesToCreate: [...payload.resourcesToCreate]
      .map((r) => ({ kind: r.kind, labelZh: r.labelZh }))
      .sort((a, b) => `${a.kind}:${a.labelZh}`.localeCompare(`${b.kind}:${b.labelZh}`)),
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

export function createConfirmationRecord(input: {
  confirmationId: string;
  confirmedByUserId: string;
  payload: LaunchConfirmationPayload;
  confirmedAt?: Date;
}): LaunchConfirmationRecord {
  const confirmedAt = (input.confirmedAt ?? new Date()).toISOString();
  return {
    confirmationId: input.confirmationId,
    confirmedAt,
    confirmedByUserId: input.confirmedByUserId,
    confirmedPlanHash: hashConfirmationPayload(input.payload),
    planVersion: input.payload.planVersion,
    snapshot: input.payload,
  };
}

export function validateConfirmation(input: {
  record: LaunchConfirmationRecord | null | undefined;
  currentPayload: LaunchConfirmationPayload;
  requiresConfirmation: boolean;
}): {
  ok: boolean;
  code: string | null;
  messageZh: string;
  confirmationSatisfied: boolean;
} {
  if (!input.requiresConfirmation) {
    return {
      ok: true,
      code: null,
      messageZh: '无需确认费用',
      confirmationSatisfied: true,
    };
  }
  if (!input.record?.confirmedPlanHash) {
    return {
      ok: false,
      code: 'BILLABLE_ACTION_CONFIRMATION_REQUIRED',
      messageZh: '需要先确认将创建的云资源与费用',
      confirmationSatisfied: false,
    };
  }
  const currentHash = hashConfirmationPayload(input.currentPayload);
  if (currentHash !== input.record.confirmedPlanHash) {
    return {
      ok: false,
      code: 'CONFIRMATION_STALE',
      messageZh: '上线计划已变化，请重新确认费用后再继续',
      confirmationSatisfied: false,
    };
  }
  if (input.record.planVersion !== input.currentPayload.planVersion) {
    return {
      ok: false,
      code: 'CONFIRMATION_STALE',
      messageZh: '上线计划版本已变化，请重新确认',
      confirmationSatisfied: false,
    };
  }
  return {
    ok: true,
    code: null,
    messageZh: '费用确认有效',
    confirmationSatisfied: true,
  };
}
