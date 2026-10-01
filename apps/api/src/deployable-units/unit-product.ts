import {
  DeploymentStatus,
  HealthStatus,
  ServiceStatus,
} from '@launchos/database';

export type UnitProductStatus =
  | 'PENDING_LAUNCH'
  | 'DEPLOYING'
  | 'RUNNING'
  | 'WARNING'
  | 'STOPPED'
  | 'FAILED'
  | 'UNSUPPORTED';

export type AggregateProductStatus =
  | 'READY'
  | 'DEPLOYING'
  | 'RUNNING'
  | 'WARNING'
  | 'STOPPED'
  | 'FAILED'
  | 'UNSUPPORTED'
  | 'PARTIAL_LAUNCH';

const TYPE_DEFAULT_NAMES: Record<string, string> = {
  WEB: '官网',
  API: 'API服务',
  ADMIN: '管理后台',
  IOS: 'iOS APP',
  ANDROID: 'Android APP',
  MINI_PROGRAM: '微信小程序',
  MOBILE_CROSS_PLATFORM: '移动APP',
  OTHER: '其他内容',
};

const TYPE_SHORT: Record<string, string> = {
  WEB: '官网',
  API: 'API服务',
  ADMIN: '管理后台',
  IOS: 'APP',
  ANDROID: 'APP',
  MINI_PROGRAM: '小程序',
  MOBILE_CROSS_PLATFORM: 'APP',
  OTHER: '内容',
};

export const UNIT_PRODUCT_STATUS_LABELS: Record<UnitProductStatus, string> = {
  PENDING_LAUNCH: '待上线',
  DEPLOYING: '正在上线',
  RUNNING: '🟢 运行正常',
  WARNING: '出现异常',
  STOPPED: '已停止',
  FAILED: '上线失败',
  UNSUPPORTED: '暂不支持发布',
};

export const AGGREGATE_PRODUCT_STATUS_LABELS: Record<AggregateProductStatus, string> = {
  READY: '待上线',
  DEPLOYING: '正在上线',
  RUNNING: '🟢 全部正常',
  WARNING: '🟡 部分异常',
  STOPPED: '已停止',
  FAILED: '上线失败',
  UNSUPPORTED: '已识别，当前暂不支持发布',
  PARTIAL_LAUNCH: '部分内容尚未上线',
};

export function defaultUnitDisplayName(type: string, rootPath: string, rawName: string): string {
  const trimmed = rawName?.trim() || '';
  const pathBase = rootPath === '.' ? '' : rootPath.split('/').filter(Boolean).pop() || '';
  const looksTechnical =
    !trimmed ||
    trimmed === pathBase ||
    trimmed === rootPath ||
    /^[a-z0-9._-]+$/i.test(trimmed) ||
    trimmed.toLowerCase() === 'appproject' ||
    trimmed.toLowerCase() === 'app';

  if (!looksTechnical) {
    return trimmed;
  }

  const byType = TYPE_DEFAULT_NAMES[type] || TYPE_SHORT[type] || '可上线内容';
  if (pathBase && pathBase !== '.' && !looksLikeGenericPath(pathBase)) {
    return `${byType}（${pathBase}）`;
  }
  return byType;
}

function looksLikeGenericPath(name: string): boolean {
  return ['web', 'api', 'admin', 'app', 'apps', 'mobile', 'miniapp', 'src'].includes(
    name.toLowerCase(),
  );
}

export function ensureUniqueDisplayNames(
  units: Array<{ id: string; type: string; rootPath: string; name: string }>,
): Map<string, string> {
  const counts = new Map<string, number>();
  const assigned = new Map<string, string>();
  for (const unit of units) {
    const base = defaultUnitDisplayName(unit.type, unit.rootPath, unit.name);
    const used = counts.get(base) ?? 0;
    counts.set(base, used + 1);
    assigned.set(unit.id, used === 0 ? base : `${base} ${used + 1}`);
  }
  // Second pass: if duplicates existed, renumber from 1
  const baseCounts = new Map<string, number>();
  for (const unit of units) {
    const base = defaultUnitDisplayName(unit.type, unit.rootPath, unit.name);
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  for (const unit of units) {
    const base = defaultUnitDisplayName(unit.type, unit.rootPath, unit.name);
    if ((baseCounts.get(base) ?? 0) <= 1) {
      assigned.set(unit.id, base);
      continue;
    }
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    assigned.set(unit.id, `${base} ${n}`);
  }
  return assigned;
}

export function deriveUnitProductStatus(input: {
  deployable: boolean;
  deploymentStatus?: DeploymentStatus | null;
  serviceStatus?: ServiceStatus | null;
  healthStatus?: HealthStatus | null;
}): UnitProductStatus {
  if (!input.deployable) {
    return 'UNSUPPORTED';
  }
  const deploymentStatus = input.deploymentStatus;
  if (
    deploymentStatus === DeploymentStatus.CREATED ||
    deploymentStatus === DeploymentStatus.QUEUED ||
    deploymentStatus === DeploymentStatus.RUNNING
  ) {
    return 'DEPLOYING';
  }
  if (deploymentStatus === DeploymentStatus.FAILED) {
    return 'FAILED';
  }
  if (input.serviceStatus === ServiceStatus.STOPPED) {
    return 'STOPPED';
  }
  if (input.healthStatus === HealthStatus.UNHEALTHY) {
    return 'WARNING';
  }
  if (input.serviceStatus === ServiceStatus.FAILED) {
    return 'FAILED';
  }
  if (input.serviceStatus === ServiceStatus.RUNNING) {
    return 'RUNNING';
  }
  if (deploymentStatus === DeploymentStatus.SUCCESS) {
    return 'RUNNING';
  }
  return 'PENDING_LAUNCH';
}

export function deriveAggregateProductStatus(
  unitStatuses: UnitProductStatus[],
): AggregateProductStatus {
  if (unitStatuses.length === 0) {
    return 'READY';
  }
  if (unitStatuses.every((s) => s === 'UNSUPPORTED')) {
    return 'UNSUPPORTED';
  }
  if (unitStatuses.some((s) => s === 'DEPLOYING')) {
    return 'DEPLOYING';
  }

  const launchable = unitStatuses.filter((s) => s !== 'UNSUPPORTED');
  if (launchable.length === 0) {
    return 'UNSUPPORTED';
  }

  const running = launchable.filter((s) => s === 'RUNNING').length;
  const warning = launchable.filter((s) => s === 'WARNING').length;
  const failed = launchable.filter((s) => s === 'FAILED').length;
  const stopped = launchable.filter((s) => s === 'STOPPED').length;
  const pending = launchable.filter((s) => s === 'PENDING_LAUNCH').length;

  if (failed === launchable.length) {
    return 'FAILED';
  }
  if (warning > 0 && running > 0) {
    return 'WARNING';
  }
  if (warning > 0 && running === 0 && pending === 0) {
    return 'WARNING';
  }
  if (running > 0 && (pending > 0 || failed > 0 || stopped > 0)) {
    return 'PARTIAL_LAUNCH';
  }
  if (running === launchable.length) {
    return 'RUNNING';
  }
  if (stopped === launchable.length) {
    return 'STOPPED';
  }
  if (pending === launchable.length) {
    return 'READY';
  }
  if (failed > 0 && running === 0) {
    return 'FAILED';
  }
  return 'PARTIAL_LAUNCH';
}

export function mapAggregateToApplicationStatus(
  aggregate: AggregateProductStatus,
): 'READY' | 'DEPLOYING' | 'RUNNING' | 'WARNING' | 'STOPPED' | 'FAILED' {
  if (aggregate === 'UNSUPPORTED' || aggregate === 'PARTIAL_LAUNCH') {
    return aggregate === 'PARTIAL_LAUNCH' ? 'WARNING' : 'READY';
  }
  return aggregate;
}

export function typeLabel(type: string): string {
  return TYPE_SHORT[type] || TYPE_DEFAULT_NAMES[type] || '内容';
}
