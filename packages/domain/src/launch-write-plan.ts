/**
 * Step 30 Phase 2 — planned write classification for gate/dry-run.
 */

import type { LaunchWriteClass } from './launch-handler.js';
import { defaultLaunchHandlerRegistry } from './launch-handler-registry.js';

export type LaunchWritePlan = {
  cloudWritesPlanned: number;
  deploymentWritesPlanned: number;
  gatewayWritesPlanned: number;
  dnsWritesPlanned: number;
  certificateWritesPlanned: number;
  remoteWritesPlanned: number;
  providerWriteCount: number;
  totalWritesPlanned: number;
};

export type WritePlanStep = {
  stepType: string;
  decision: 'EXECUTE' | 'REUSE' | 'SKIP' | 'BLOCK';
};

const CLASS_FIELD: Record<Exclude<LaunchWriteClass, 'none'>, keyof LaunchWritePlan> = {
  cloud: 'cloudWritesPlanned',
  deployment: 'deploymentWritesPlanned',
  gateway: 'gatewayWritesPlanned',
  dns: 'dnsWritesPlanned',
  certificate: 'certificateWritesPlanned',
  remote: 'remoteWritesPlanned',
};

export function classifyLaunchWrites(steps: WritePlanStep[]): LaunchWritePlan {
  const plan: LaunchWritePlan = {
    cloudWritesPlanned: 0,
    deploymentWritesPlanned: 0,
    gatewayWritesPlanned: 0,
    dnsWritesPlanned: 0,
    certificateWritesPlanned: 0,
    remoteWritesPlanned: 0,
    providerWriteCount: 0,
    totalWritesPlanned: 0,
  };

  for (const s of steps) {
    if (s.decision !== 'EXECUTE') continue;
    const handler = defaultLaunchHandlerRegistry.get(s.stepType);
    const writeClass = handler?.writeClass ?? 'none';
    if (writeClass === 'none') continue;
    const field = CLASS_FIELD[writeClass];
    plan[field] += 1;
    plan.totalWritesPlanned += 1;
  }
  // Phase 2 gate: never count actual provider invocations here.
  plan.providerWriteCount = 0;
  return plan;
}

export function emptyWritePlan(): LaunchWritePlan {
  return classifyLaunchWrites([]);
}
