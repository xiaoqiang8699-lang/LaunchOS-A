/**
 * Step 26.1 Server planning — product domain (no ECS Create).
 * Truth for SKU/price comes from Provider; this module is pure recommendation logic.
 */

export type ServerProfile = 'DEV' | 'STANDARD' | 'PRODUCTION';

export type ServerSource = 'EXISTING' | 'MANAGED_CREATE';

export type ServerReadiness =
  | 'NOT_CONFIGURED'
  | 'PLANNED'
  | 'CREATING'
  | 'INITIALIZING'
  | 'READY'
  | 'UNAVAILABLE'
  | 'ERROR';

export type ExistingServerFit = 'SUITABLE' | 'UNDERSIZED' | 'UNKNOWN';

export type DeployableUnitKind =
  | 'WEB'
  | 'API'
  | 'ADMIN'
  | 'IOS'
  | 'ANDROID'
  | 'MINI_PROGRAM'
  | 'MOBILE_CROSS_PLATFORM'
  | 'OTHER';

export type ServerResourceProfile = {
  profile: ServerProfile;
  label: string;
  vcpu: number;
  memoryGb: number;
  systemDiskGb: number;
};

export const SERVER_RESOURCE_PROFILES: Record<ServerProfile, ServerResourceProfile> = {
  DEV: {
    profile: 'DEV',
    label: '开发测试',
    vcpu: 1,
    memoryGb: 2,
    systemDiskGb: 40,
  },
  STANDARD: {
    profile: 'STANDARD',
    label: '标准',
    vcpu: 2,
    memoryGb: 4,
    systemDiskGb: 60,
  },
  PRODUCTION: {
    profile: 'PRODUCTION',
    label: '生产',
    vcpu: 4,
    memoryGb: 8,
    systemDiskGb: 80,
  },
};

export const SERVER_PROFILE_LABELS: Record<ServerProfile, string> = {
  DEV: '开发测试',
  STANDARD: '标准',
  PRODUCTION: '生产',
};

export const SERVER_READINESS_LABELS: Record<ServerReadiness, string> = {
  NOT_CONFIGURED: '未配置',
  PLANNED: '已规划',
  CREATING: '正在创建',
  INITIALIZING: '正在初始化',
  READY: '已就绪',
  UNAVAILABLE: '不可用',
  ERROR: '出错',
};

export const EXISTING_SERVER_FIT_LABELS: Record<ExistingServerFit, string> = {
  SUITABLE: '规格合适',
  UNDERSIZED: '规格偏小',
  UNKNOWN: '无法评估',
};

const MOBILE_ONLY_TYPES = new Set<DeployableUnitKind>([
  'IOS',
  'ANDROID',
  'MINI_PROGRAM',
  'MOBILE_CROSS_PLATFORM',
]);

const RUNTIME_SERVER_TYPES = new Set<DeployableUnitKind>(['WEB', 'API', 'ADMIN', 'OTHER']);

export type ServerRequirementInput = {
  units: Array<{ type: string; name?: string }>;
  /** Optional environment hint: development | staging | production */
  environmentType?: string | null;
  dependencyCount?: number;
  /** When true, prefer at least STANDARD */
  preferProduction?: boolean;
};

export type ServerRequirementResult = {
  required: boolean;
  reasons: string[];
  recommendedProfile: ServerProfile;
  recommendationReason: string;
  sharedServer: boolean;
  runtimeUnitCount: number;
  runtimeUnitNames: string[];
};

/**
 * Decide whether the project needs a long-running server (ECS / Target Server).
 * Mobile-only apps do not require ECS; API/Web/Admin do.
 */
export function analyzeServerRequirement(input: ServerRequirementInput): ServerRequirementResult {
  const units = input.units || [];
  const runtimeUnits = units.filter((u) =>
    RUNTIME_SERVER_TYPES.has(normalizeUnitType(u.type)),
  );
  const mobileUnits = units.filter((u) => MOBILE_ONLY_TYPES.has(normalizeUnitType(u.type)));

  if (runtimeUnits.length === 0) {
    const reasons =
      mobileUnits.length > 0
        ? ['当前应用仅包含移动端组成，不需要单独准备运行服务器。']
        : ['当前应用没有需要长期运行的 Web / API 服务。'];
    return {
      required: false,
      reasons,
      recommendedProfile: 'DEV',
      recommendationReason: reasons[0]!,
      sharedServer: false,
      runtimeUnitCount: 0,
      runtimeUnitNames: [],
    };
  }

  const profile = recommendServerProfile({
    runtimeUnitCount: runtimeUnits.length,
    unitTypes: runtimeUnits.map((u) => normalizeUnitType(u.type)),
    environmentType: input.environmentType,
    dependencyCount: input.dependencyCount ?? 0,
    preferProduction: input.preferProduction,
  });

  const names = runtimeUnits.map((u) => u.name?.trim() || unitTypeLabel(normalizeUnitType(u.type)));
  const recommendationReason = buildRecommendationReason({
    profile,
    names,
    environmentType: input.environmentType,
    dependencyCount: input.dependencyCount ?? 0,
  });

  const reasons = [
    `这个应用需要一台运行服务器，用于部署 ${names.join('、')}。`,
    recommendationReason,
  ];

  return {
    required: true,
    reasons,
    recommendedProfile: profile,
    recommendationReason,
    sharedServer: true,
    runtimeUnitCount: runtimeUnits.length,
    runtimeUnitNames: names,
  };
}

export function recommendServerProfile(input: {
  runtimeUnitCount: number;
  unitTypes: DeployableUnitKind[];
  environmentType?: string | null;
  dependencyCount?: number;
  preferProduction?: boolean;
}): ServerProfile {
  const env = (input.environmentType || '').toLowerCase();
  const isProd =
    Boolean(input.preferProduction) ||
    env.includes('prod') ||
    env === 'production' ||
    env === '生产';

  const hasApi = input.unitTypes.includes('API') || input.unitTypes.includes('ADMIN');
  const hasWeb = input.unitTypes.includes('WEB');
  const multiBackend =
    input.unitTypes.filter((t) => t === 'API' || t === 'ADMIN' || t === 'OTHER').length >= 2;
  const deps = input.dependencyCount ?? 0;

  if (isProd || multiBackend || (deps >= 2 && input.runtimeUnitCount >= 2)) {
    return multiBackend || deps >= 3 ? 'PRODUCTION' : 'STANDARD';
  }
  if (hasWeb && hasApi) return 'STANDARD';
  if (input.runtimeUnitCount >= 2) return 'STANDARD';
  if (hasApi && deps >= 1) return 'STANDARD';
  return 'DEV';
}

export function buildRecommendationReason(input: {
  profile: ServerProfile;
  names: string[];
  environmentType?: string | null;
  dependencyCount?: number;
}): string {
  const def = SERVER_RESOURCE_PROFILES[input.profile];
  const parts: string[] = [];
  if (input.names.length >= 2) {
    parts.push(
      `你的应用包含 ${input.names.join(' 和 ')}，推荐 ${def.vcpu} 核 ${def.memoryGb}GB。`,
    );
  } else if (input.names.length === 1) {
    parts.push(
      `你的应用包含 ${input.names[0]}，推荐 ${def.label}配置（${def.vcpu} 核 ${def.memoryGb}GB）。`,
    );
  } else {
    parts.push(`推荐 ${def.label}配置（${def.vcpu} 核 ${def.memoryGb}GB）。`);
  }

  const env = (input.environmentType || '').toLowerCase();
  if (!env.includes('prod') && env !== 'production' && env !== '生产') {
    parts.push('当前优先按测试环境给出低成本配置，上线生产时可升级。');
  } else {
    parts.push('当前按生产环境预留容量，避免刚好卡线。');
  }
  if ((input.dependencyCount ?? 0) > 0) {
    parts.push('已为数据库等依赖预留运行余量。');
  }
  return parts.join('');
}

/** Rough runtime memory estimate (GB) with OS + headroom — not for build machine sizing. */
export function estimateRuntimeMemoryNeedGb(input: {
  runtimeUnitCount: number;
  dependencyCount?: number;
}): number {
  const baseOs = 0.8;
  const perUnit = 0.6;
  const perDep = 0.15;
  const raw =
    baseOs +
    Math.max(1, input.runtimeUnitCount) * perUnit +
    (input.dependencyCount ?? 0) * perDep;
  return Math.ceil(raw * 1.2 * 10) / 10;
}

export function evaluateExistingServer(input: {
  knownVcpu?: number | null;
  knownMemoryGb?: number | null;
  recommended: ServerProfile;
}): { fit: ExistingServerFit; reason: string } {
  const target = SERVER_RESOURCE_PROFILES[input.recommended];
  if (
    input.knownVcpu == null ||
    input.knownMemoryGb == null ||
    !Number.isFinite(input.knownVcpu) ||
    !Number.isFinite(input.knownMemoryGb)
  ) {
    return {
      fit: 'UNKNOWN',
      reason: '已识别到服务器，但暂时无法确认 CPU / 内存规格。',
    };
  }
  if (input.knownVcpu >= target.vcpu && input.knownMemoryGb >= target.memoryGb) {
    return {
      fit: 'SUITABLE',
      reason: `当前约 ${input.knownVcpu} 核 ${input.knownMemoryGb}GB，满足推荐的 ${target.label}配置。`,
    };
  }
  return {
    fit: 'UNDERSIZED',
    reason: `当前约 ${input.knownVcpu} 核 ${input.knownMemoryGb}GB，低于推荐的 ${target.vcpu} 核 ${target.memoryGb}GB。`,
  };
}

export function pickRegionFromHints(hints: {
  userSelected?: string | null;
  dependencyRegions?: string[];
  existingCloudServerRegion?: string | null;
  providerAccountRegion?: string | null;
  defaultRegion?: string;
}): { regionId: string; reason: string } {
  if (hints.userSelected?.trim()) {
    return { regionId: hints.userSelected.trim(), reason: '使用你选择的地域。' };
  }
  const dep = (hints.dependencyRegions || []).map((r) => r.trim()).filter(Boolean);
  if (dep.length) {
    const counts = new Map<string, number>();
    for (const r of dep) counts.set(r, (counts.get(r) || 0) + 1);
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    return {
      regionId: best,
      reason: `与现有数据库 / Redis 等依赖保持同地域（${best}）。`,
    };
  }
  if (hints.existingCloudServerRegion?.trim()) {
    return {
      regionId: hints.existingCloudServerRegion.trim(),
      reason: '与现有云服务器同地域。',
    };
  }
  if (hints.providerAccountRegion?.trim()) {
    return {
      regionId: hints.providerAccountRegion.trim(),
      reason: '使用云账号默认地域。',
    };
  }
  const fallback = hints.defaultRegion?.trim() || 'cn-hangzhou';
  return { regionId: fallback, reason: `使用默认地域 ${fallback}。` };
}

export type NetworkPlan = {
  regionId: string;
  zoneId: string | null;
  vpcId: string | null;
  vSwitchId: string | null;
  securityGroupPlan: {
    allowTcp: number[];
    denyPublicDynamicContainerPorts: true;
    note: string;
  };
  publicIpRequired: true;
  placementReason: string;
};

export function buildNetworkPlanDraft(input: {
  regionId: string;
  zoneId?: string | null;
  vpcId?: string | null;
  vSwitchId?: string | null;
  placementReason?: string;
}): NetworkPlan {
  return {
    regionId: input.regionId,
    zoneId: input.zoneId || null,
    vpcId: input.vpcId || null,
    vSwitchId: input.vSwitchId || null,
    securityGroupPlan: {
      allowTcp: [22, 80, 443],
      denyPublicDynamicContainerPorts: true,
      note: '仅开放 SSH / HTTP / HTTPS；容器动态端口不对公网开放。',
    },
    publicIpRequired: true,
    placementReason:
      input.placementReason ||
      (input.vpcId
        ? '优先与数据库 / Redis 使用同一 VPC，保证内网可达。'
        : '将在创建时准备 VPC，并分配公网 IP 供 Gateway 访问。'),
  };
}

export type ServerInitPlan = {
  steps: string[];
  note: string;
};

export function buildServerInitPlan(): ServerInitPlan {
  return {
    steps: [
      '安装 Docker / Podman 运行时',
      '创建 launchos 用户与运行目录',
      '配置 SSH 与基础安全',
      '配置防火墙（仅 22/80/443）',
      '安装健康检查工具',
      '准备日志目录',
    ],
    note: 'Step 26.1 仅规划，不执行初始化。',
  };
}

export function normalizeUnitType(type: string): DeployableUnitKind {
  const t = (type || '').toUpperCase();
  if (t === 'WEB') return 'WEB';
  if (t === 'API') return 'API';
  if (t === 'ADMIN') return 'ADMIN';
  if (t === 'IOS') return 'IOS';
  if (t === 'ANDROID') return 'ANDROID';
  if (t === 'MINI_PROGRAM') return 'MINI_PROGRAM';
  if (t === 'MOBILE_CROSS_PLATFORM') return 'MOBILE_CROSS_PLATFORM';
  return 'OTHER';
}

function unitTypeLabel(type: DeployableUnitKind): string {
  switch (type) {
    case 'WEB':
      return 'Web 服务';
    case 'API':
      return 'API 服务';
    case 'ADMIN':
      return '管理后台';
    default:
      return '应用服务';
  }
}

/** Select lowest SKU that meets profile among available candidates (pure). */
export function selectLowestMatchingSku<T extends { cpu: number; memoryGb: number; instanceType: string }>(
  candidates: T[],
  profile: ServerProfile,
): T | null {
  const need = SERVER_RESOURCE_PROFILES[profile];
  const ok = candidates
    .filter((c) => c.cpu >= need.vcpu && c.memoryGb >= need.memoryGb)
    .sort((a, b) => a.cpu - b.cpu || a.memoryGb - b.memoryGb || a.instanceType.localeCompare(b.instanceType));
  return ok[0] || null;
}
