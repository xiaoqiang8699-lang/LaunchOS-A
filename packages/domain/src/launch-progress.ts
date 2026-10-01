/**
 * Step 30 — stage-weighted progress model for ordinary users (7 stages).
 */

import {
  LAUNCH_STAGE_WEIGHTS,
  LAUNCH_STAGES,
  type LaunchStageId,
  type LaunchStageUiStatus,
} from './launch-stages.js';

export type LaunchStepProgressInput = {
  stage: LaunchStageId;
  decision: 'EXECUTE' | 'REUSE' | 'SKIP' | 'BLOCK';
  status: string;
};

export type LaunchStageProgress = {
  stage: LaunchStageId;
  status: LaunchStageUiStatus;
  weight: number;
  progressPercentContribution: number;
};

export type LaunchProgressModel = {
  stages: LaunchStageProgress[];
  progressPercent: number;
};

function stageUiStatus(steps: LaunchStepProgressInput[]): LaunchStageUiStatus {
  if (steps.length === 0) return 'SKIPPED';
  if (steps.every((s) => s.decision === 'SKIP' || s.status === 'SKIPPED')) return 'SKIPPED';
  if (steps.some((s) => s.status === 'FAILED' || s.decision === 'BLOCK')) return 'FAILED';
  if (steps.some((s) => s.status === 'RUNNING' || s.status === 'WAITING')) return 'RUNNING';
  const actionable = steps.filter((s) => s.decision !== 'SKIP');
  if (
    actionable.length > 0 &&
    actionable.every(
      (s) =>
        s.decision === 'REUSE' ||
        s.status === 'SUCCESS' ||
        s.status === 'SKIPPED',
    )
  ) {
    return 'SUCCESS';
  }
  if (steps.every((s) => s.decision === 'REUSE' || s.decision === 'SKIP')) return 'SUCCESS';
  return 'WAITING';
}

/**
 * Percentage uses stage weights. REUSE/SKIP stages count as complete.
 * EXECUTE stages that are still pending contribute 0 until success.
 */
export function computeLaunchProgress(steps: LaunchStepProgressInput[]): LaunchProgressModel {
  const stages: LaunchStageProgress[] = [];
  let progressPercent = 0;

  for (const stage of LAUNCH_STAGES) {
    const stageSteps = steps.filter((s) => s.stage === stage);
    const status = stageUiStatus(stageSteps);
    const weight = LAUNCH_STAGE_WEIGHTS[stage];
    let contribution = 0;
    if (status === 'SUCCESS' || status === 'SKIPPED') {
      contribution = weight;
    } else if (status === 'RUNNING') {
      contribution = Math.round(weight * 0.5);
    } else if (status === 'FAILED') {
      const done = stageSteps.filter(
        (s) => s.decision === 'REUSE' || s.status === 'SUCCESS' || s.decision === 'SKIP',
      ).length;
      contribution = stageSteps.length
        ? Math.round((weight * done) / stageSteps.length)
        : 0;
    }
    progressPercent += contribution;
    stages.push({
      stage,
      status,
      weight,
      progressPercentContribution: contribution,
    });
  }

  return {
    stages,
    progressPercent: Math.min(100, Math.max(0, progressPercent)),
  };
}
