/**
 * Beta M5 — deployment reliability & capacity governance (pure helpers).
 * No cloud expansion; admission gates only.
 */

export const BETA_CAPACITY_DEFAULTS = {
  /** Shared Alpha node: 2 vCPU / ~3.5GiB / 59G disk @ ~87% used. */
  maxConcurrentBuilds: 1,
  maxConcurrentDeploys: 2,
  maxRunningRuntimes: 8,
  runtimeMemoryLimitMb: 512,
  runtimeCpuLimit: 1,
  /** Free space below this → warning (admin). */
  diskWarningFreeMb: 12 * 1024,
  /** Free space below this → reject new builds/deploys. */
  diskCriticalFreeMb: 4 * 1024,
  diskWarningUsedPercent: 80,
  diskCriticalUsedPercent: 92,
  /** Keep current + recent success versions' artifacts. */
  artifactRetainSuccessVersions: 3,
  artifactRetainFailedBuilds: 2,
  runtimeGraceMs: 10 * 60_000,
  capacityProbeTtlMs: 60_000,
} as const;

export const CAPACITY_ADMISSION_RESULTS = [
  'ADMITTED',
  'WAITING_CAPACITY',
  'REJECTED_CAPACITY',
  'WORKER_UNAVAILABLE',
] as const;

export type CapacityAdmissionResult = (typeof CAPACITY_ADMISSION_RESULTS)[number];

export const CAPACITY_FAILURE_CODES = [
  'CAPACITY_UNAVAILABLE',
  'CAPACITY_DISK_CRITICAL',
  'CAPACITY_MEMORY_CRITICAL',
  'CAPACITY_RUNTIME_FULL',
  'CAPACITY_BUILD_SLOTS_FULL',
  'CAPACITY_DEPLOY_SLOTS_FULL',
  'NO_DEPLOYMENT_WORKER_AVAILABLE',
] as const;

export type CapacityFailureCode = (typeof CAPACITY_FAILURE_CODES)[number];

export const CAPACITY_USER_MESSAGES: Record<CapacityFailureCode, string> = {
  CAPACITY_UNAVAILABLE: '当前上线资源繁忙，请稍后重试。',
  CAPACITY_DISK_CRITICAL: '当前上线资源繁忙，请稍后重试。',
  CAPACITY_MEMORY_CRITICAL: '当前上线资源繁忙，请稍后重试。',
  CAPACITY_RUNTIME_FULL: '当前上线资源繁忙，请稍后重试。',
  CAPACITY_BUILD_SLOTS_FULL: '正在等待构建资源，请稍后重试。',
  CAPACITY_DEPLOY_SLOTS_FULL: '正在等待上线资源，请稍后重试。',
  NO_DEPLOYMENT_WORKER_AVAILABLE: '上线服务暂时不可用，请稍后重试。',
};

export const CAPACITY_UI_LABELS: Record<CapacityAdmissionResult, string> = {
  ADMITTED: '准备上线',
  WAITING_CAPACITY: '等待上线资源',
  REJECTED_CAPACITY: '当前资源不足',
  WORKER_UNAVAILABLE: '上线服务暂不可用',
};

export type ServerCapacitySnapshot = {
  serverInstanceId: string;
  cpuCores: number | null;
  memoryTotalMb: number | null;
  memoryAvailableMb: number | null;
  diskTotalMb: number | null;
  diskFreeMb: number | null;
  diskUsedPercent: number | null;
  runningRuntimeCount: number;
  activeDeploymentCount: number;
  activeBuildCount: number;
  allocatedPortCount: number;
  probedAt: string;
};

export type CapacityAdmissionInput = {
  workerOnline: boolean;
  queueReady: boolean;
  snapshot: ServerCapacitySnapshot | null;
  limits?: Partial<typeof BETA_CAPACITY_DEFAULTS>;
  /** When true, build-slot full → WAITING; deploy-slot full → WAITING. */
  allowWait?: boolean;
};

export type CapacityAdmissionDecision = {
  result: CapacityAdmissionResult;
  code: CapacityFailureCode | null;
  userMessage: string | null;
  uiLabel: string;
  reasons: string[];
  diskWarning: boolean;
  diskCritical: boolean;
  memoryCritical: boolean;
};

export function evaluateDiskWatermark(
  snapshot: Pick<ServerCapacitySnapshot, 'diskFreeMb' | 'diskUsedPercent'> | null,
  limits = BETA_CAPACITY_DEFAULTS,
): { warning: boolean; critical: boolean } {
  if (!snapshot) return { warning: false, critical: false };
  const free = snapshot.diskFreeMb;
  const usedPct = snapshot.diskUsedPercent;
  const critical =
    (free != null && free < limits.diskCriticalFreeMb) ||
    (usedPct != null && usedPct >= limits.diskCriticalUsedPercent);
  const warning =
    !critical &&
    ((free != null && free < limits.diskWarningFreeMb) ||
      (usedPct != null && usedPct >= limits.diskWarningUsedPercent));
  return { warning, critical };
}

export function evaluateMemoryCritical(
  snapshot: Pick<ServerCapacitySnapshot, 'memoryAvailableMb'> | null,
  limits = BETA_CAPACITY_DEFAULTS,
): boolean {
  if (!snapshot?.memoryAvailableMb && snapshot?.memoryAvailableMb !== 0) return false;
  // Need headroom for at least one runtime + build slack.
  return snapshot.memoryAvailableMb! < limits.runtimeMemoryLimitMb + 256;
}

export function decideCapacityAdmission(input: CapacityAdmissionInput): CapacityAdmissionDecision {
  const limits = { ...BETA_CAPACITY_DEFAULTS, ...(input.limits || {}) };
  const reasons: string[] = [];

  if (!input.workerOnline || !input.queueReady) {
    return {
      result: 'WORKER_UNAVAILABLE',
      code: 'NO_DEPLOYMENT_WORKER_AVAILABLE',
      userMessage: CAPACITY_USER_MESSAGES.NO_DEPLOYMENT_WORKER_AVAILABLE,
      uiLabel: CAPACITY_UI_LABELS.WORKER_UNAVAILABLE,
      reasons: ['worker_unavailable'],
      diskWarning: false,
      diskCritical: false,
      memoryCritical: false,
    };
  }

  const snap = input.snapshot;
  const disk = evaluateDiskWatermark(snap, limits);
  const memoryCritical = evaluateMemoryCritical(snap, limits);

  if (disk.critical) {
    reasons.push('disk_critical');
    return {
      result: 'REJECTED_CAPACITY',
      code: 'CAPACITY_DISK_CRITICAL',
      userMessage: CAPACITY_USER_MESSAGES.CAPACITY_DISK_CRITICAL,
      uiLabel: CAPACITY_UI_LABELS.REJECTED_CAPACITY,
      reasons,
      diskWarning: true,
      diskCritical: true,
      memoryCritical,
    };
  }

  if (memoryCritical) {
    reasons.push('memory_critical');
    return {
      result: 'REJECTED_CAPACITY',
      code: 'CAPACITY_MEMORY_CRITICAL',
      userMessage: CAPACITY_USER_MESSAGES.CAPACITY_MEMORY_CRITICAL,
      uiLabel: CAPACITY_UI_LABELS.REJECTED_CAPACITY,
      reasons,
      diskWarning: disk.warning,
      diskCritical: false,
      memoryCritical: true,
    };
  }

  if (snap && snap.runningRuntimeCount >= limits.maxRunningRuntimes) {
    reasons.push('runtime_full');
    return {
      result: 'REJECTED_CAPACITY',
      code: 'CAPACITY_RUNTIME_FULL',
      userMessage: CAPACITY_USER_MESSAGES.CAPACITY_RUNTIME_FULL,
      uiLabel: CAPACITY_UI_LABELS.REJECTED_CAPACITY,
      reasons,
      diskWarning: disk.warning,
      diskCritical: false,
      memoryCritical: false,
    };
  }

  if (snap && snap.activeBuildCount >= limits.maxConcurrentBuilds) {
    reasons.push('build_slots_full');
    if (input.allowWait) {
      return {
        result: 'WAITING_CAPACITY',
        code: 'CAPACITY_BUILD_SLOTS_FULL',
        userMessage: CAPACITY_USER_MESSAGES.CAPACITY_BUILD_SLOTS_FULL,
        uiLabel: CAPACITY_UI_LABELS.WAITING_CAPACITY,
        reasons,
        diskWarning: disk.warning,
        diskCritical: false,
        memoryCritical: false,
      };
    }
    return {
      result: 'REJECTED_CAPACITY',
      code: 'CAPACITY_BUILD_SLOTS_FULL',
      userMessage: CAPACITY_USER_MESSAGES.CAPACITY_BUILD_SLOTS_FULL,
      uiLabel: CAPACITY_UI_LABELS.REJECTED_CAPACITY,
      reasons,
      diskWarning: disk.warning,
      diskCritical: false,
      memoryCritical: false,
    };
  }

  if (snap && snap.activeDeploymentCount >= limits.maxConcurrentDeploys) {
    reasons.push('deploy_slots_full');
    if (input.allowWait) {
      return {
        result: 'WAITING_CAPACITY',
        code: 'CAPACITY_DEPLOY_SLOTS_FULL',
        userMessage: CAPACITY_USER_MESSAGES.CAPACITY_DEPLOY_SLOTS_FULL,
        uiLabel: CAPACITY_UI_LABELS.WAITING_CAPACITY,
        reasons,
        diskWarning: disk.warning,
        diskCritical: false,
        memoryCritical: false,
      };
    }
    return {
      result: 'REJECTED_CAPACITY',
      code: 'CAPACITY_DEPLOY_SLOTS_FULL',
      userMessage: CAPACITY_USER_MESSAGES.CAPACITY_DEPLOY_SLOTS_FULL,
      uiLabel: CAPACITY_UI_LABELS.REJECTED_CAPACITY,
      reasons,
      diskWarning: disk.warning,
      diskCritical: false,
      memoryCritical: false,
    };
  }

  if (disk.warning) reasons.push('disk_warning');

  return {
    result: 'ADMITTED',
    code: null,
    userMessage: null,
    uiLabel: CAPACITY_UI_LABELS.ADMITTED,
    reasons,
    diskWarning: disk.warning,
    diskCritical: false,
    memoryCritical: false,
  };
}

/** Parse `free -m` / `df` remote probe output into snapshot fields. */
export function parseCapacityProbeText(text: string): {
  memoryTotalMb: number | null;
  memoryAvailableMb: number | null;
  diskTotalMb: number | null;
  diskFreeMb: number | null;
  diskUsedPercent: number | null;
  cpuCores: number | null;
} {
  const src = String(text || '');
  let memoryTotalMb: number | null = null;
  let memoryAvailableMb: number | null = null;
  const mem = src.match(/Mem:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);
  if (mem) {
    memoryTotalMb = Number(mem[1]);
    memoryAvailableMb = Number(mem[6]);
  }
  let diskTotalMb: number | null = null;
  let diskFreeMb: number | null = null;
  let diskUsedPercent: number | null = null;
  // df -h: /dev/vda3 59G 49G 7.5G 87% /
  const df = src.match(/\s(\d+(?:\.\d+)?)G\s+(\d+(?:\.\d+)?)G\s+(\d+(?:\.\d+)?)G\s+(\d+)%\s+\//);
  if (df) {
    diskTotalMb = Math.round(Number(df[1]) * 1024);
    diskFreeMb = Math.round(Number(df[3]) * 1024);
    diskUsedPercent = Number(df[4]);
  }
  const cpu = src.match(/(?:^|\n)(\d+)\s*(?:\n|$)/);
  const nprocLine = src.trim().split(/\r?\n/)[0];
  const cpuCores = /^\d+$/.test(nprocLine || '') ? Number(nprocLine) : cpu ? Number(cpu[1]) : null;
  return { memoryTotalMb, memoryAvailableMb, diskTotalMb, diskFreeMb, diskUsedPercent, cpuCores };
}

export function isBuildStage(stage: string | null | undefined): boolean {
  const s = String(stage || '').toUpperCase();
  return (
    s === 'BUILDING' ||
    s === 'PACKAGING' ||
    s === 'UPLOADING' ||
    s.includes('BUILD') ||
    s.includes('PACKAGE') ||
    s.includes('UPLOAD')
  );
}

export function selectArtifactsForRetention(input: {
  artifacts: Array<{
    id: string;
    deploymentId: string;
    type: string;
    status: string;
    createdAt: Date | string;
    deploymentStatus?: string | null;
    isCurrent?: boolean;
  }>;
  retainSuccess?: number;
  retainFailed?: number;
}): { keepIds: string[]; gcIds: string[] } {
  const retainSuccess = input.retainSuccess ?? BETA_CAPACITY_DEFAULTS.artifactRetainSuccessVersions;
  const retainFailed = input.retainFailed ?? BETA_CAPACITY_DEFAULTS.artifactRetainFailedBuilds;
  const keep = new Set<string>();
  const success = input.artifacts
    .filter((a) => a.isCurrent || a.deploymentStatus === 'SUCCESS')
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  const failed = input.artifacts
    .filter((a) => a.deploymentStatus === 'FAILED')
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  for (const row of success.slice(0, retainSuccess)) keep.add(row.id);
  for (const row of input.artifacts.filter((a) => a.isCurrent)) keep.add(row.id);
  for (const row of failed.slice(0, retainFailed)) keep.add(row.id);
  const gcIds = input.artifacts.map((a) => a.id).filter((id) => !keep.has(id));
  return { keepIds: [...keep], gcIds };
}
