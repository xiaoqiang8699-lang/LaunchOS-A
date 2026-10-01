/**
 * Step 30 Phase 2 — READY step scheduler from dependsOn graph.
 */

export type SchedulableStep = {
  id: string;
  stepType: string;
  status: string;
  decision: 'EXECUTE' | 'REUSE' | 'SKIP' | 'BLOCK';
  dependsOn: string[];
  reconcileKey: string;
};

export type StepKeyResolver = (stepType: string, reconcileKey: string) => string;

export function defaultStepKey(stepType: string, reconcileKey: string): string {
  return reconcileKey === 'default' ? stepType : `${stepType}:${reconcileKey}`;
}

const DONE = new Set(['SUCCESS', 'SKIPPED', 'REUSED']);
const FAIL = new Set(['FAILED', 'BLOCKED']);

/**
 * Advance PENDING → READY when all dependsOn are done (SUCCESS/SKIPPED).
 * REUSE/SKIP decisions are treated as already satisfied once status is SKIPPED.
 * Any failed dependency → BLOCKED.
 */
export function scheduleReadySteps(
  steps: SchedulableStep[],
  keyOf: StepKeyResolver = defaultStepKey,
): SchedulableStep[] {
  const byKey = new Map<string, SchedulableStep>();
  for (const s of steps) {
    byKey.set(keyOf(s.stepType, s.reconcileKey), s);
  }

  return steps.map((s) => {
    if (s.decision === 'BLOCK') {
      return { ...s, status: 'BLOCKED' };
    }
    if (s.decision === 'REUSE' || s.decision === 'SKIP') {
      if (s.status === 'PENDING' || s.status === 'READY') {
        return { ...s, status: 'SKIPPED' };
      }
      return s;
    }
    if (s.status !== 'PENDING' && s.status !== 'READY') {
      return s;
    }

    const deps = s.dependsOn.map((k) => {
      // dependsOn may be stepType or stepType:reconcileKey
      return (
        byKey.get(k) ??
        [...byKey.values()].find(
          (x) => defaultStepKey(x.stepType, x.reconcileKey) === k || x.stepType === k,
        )
      );
    });

    if (deps.some((d) => d && FAIL.has(d.status))) {
      return { ...s, status: 'BLOCKED' };
    }
    if (deps.some((d) => !d)) {
      // unknown dep key — keep pending
      return s;
    }
    const allDone = deps.every(
      (d) =>
        !d ||
        DONE.has(d.status) ||
        d.decision === 'REUSE' ||
        d.decision === 'SKIP' ||
        d.status === 'SKIPPED',
    );
    if (allDone) {
      return { ...s, status: 'READY' };
    }
    return { ...s, status: 'PENDING' };
  });
}

/** Steps that may run in parallel (different units, non-conflicting write classes). */
export function selectParallelBatch(
  ready: Array<SchedulableStep & { writeClass?: string; unitId?: string | null }>,
  opts?: { maxConcurrency?: number },
): SchedulableStep[] {
  const max = opts?.maxConcurrency ?? 2;
  const batch: SchedulableStep[] = [];
  const usedUnits = new Set<string>();
  let gatewayTaken = false;
  let dnsTaken = false;
  let serverProvisionTaken = false;

  for (const step of ready) {
    if (batch.length >= max) break;
    const wc = step.writeClass ?? 'none';
    if (wc === 'cloud' && step.stepType.includes('SERVER')) {
      if (serverProvisionTaken) continue;
      serverProvisionTaken = true;
    }
    if (wc === 'gateway') {
      if (gatewayTaken) continue;
      gatewayTaken = true;
    }
    if (wc === 'dns') {
      if (dnsTaken) continue;
      dnsTaken = true;
    }
    if (step.unitId) {
      // allow different units; same unit serialize build/deploy chain already via dependsOn
      if (usedUnits.has(`${step.unitId}:${step.stepType}`)) continue;
    }
    batch.push(step);
    if (step.unitId) usedUnits.add(`${step.unitId}:${step.stepType}`);
  }
  return batch;
}

export function canParallelBuild(a: SchedulableStep, b: SchedulableStep): boolean {
  const buildTypes = new Set(['BUILD_UNIT', 'BUILD_DOCKER_IMAGE']);
  return (
    buildTypes.has(a.stepType) &&
    buildTypes.has(b.stepType) &&
    a.reconcileKey !== b.reconcileKey
  );
}

export function canParallelDeploy(a: SchedulableStep, b: SchedulableStep): boolean {
  const deployTypes = new Set(['DEPLOY_API', 'DEPLOY_WEB']);
  return (
    deployTypes.has(a.stepType) &&
    deployTypes.has(b.stepType) &&
    a.reconcileKey !== b.reconcileKey
  );
}

export function mustSerializeGateway(a: SchedulableStep, b: SchedulableStep): boolean {
  const gateway = new Set([
    'INSTALL_GATEWAY',
    'INSTALL_CERTIFICATE',
    'APPLY_API_ROUTE',
    'APPLY_WEB_ROUTE',
  ]);
  return gateway.has(a.stepType) && gateway.has(b.stepType);
}
