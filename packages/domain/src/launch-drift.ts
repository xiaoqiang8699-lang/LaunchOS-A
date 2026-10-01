/**
 * Step 30 Phase 2 — launch drift detection (read-only).
 */

export type LaunchDriftKind =
  | 'dependency'
  | 'server'
  | 'deployment'
  | 'gateway'
  | 'dns'
  | 'certificate';

export type LaunchDriftSeverity = 'NONE' | 'REPAIRABLE' | 'USER_ACTION_REQUIRED' | 'TERMINAL';

export type LaunchDriftFinding = {
  kind: LaunchDriftKind;
  severity: LaunchDriftSeverity;
  code: string;
  messageZh: string;
  unitId?: string | null;
};

export type LaunchDriftReport = {
  severity: LaunchDriftSeverity;
  findings: LaunchDriftFinding[];
  desiredStateSatisfied: boolean;
};

export type LaunchDriftInput = {
  dependencyOk: boolean;
  serverOk: boolean;
  /** Declared SI healthy but container missing → deployment drift */
  units: Array<{
    unitId: string;
    declaredHealthy: boolean;
    containerObservedRunning?: boolean | null;
    healthObserved2xx?: boolean | null;
    gatewayActive?: boolean | null;
    dnsObservedCorrect?: boolean | null;
  }>;
  certificateValid?: boolean | null;
  certificateExpired?: boolean | null;
  accessEntryActive?: boolean | null;
};

const SEVERITY_RANK: Record<LaunchDriftSeverity, number> = {
  NONE: 0,
  REPAIRABLE: 1,
  USER_ACTION_REQUIRED: 2,
  TERMINAL: 3,
};

export function detectLaunchDrift(input: LaunchDriftInput): LaunchDriftReport {
  const findings: LaunchDriftFinding[] = [];

  if (!input.dependencyOk) {
    findings.push({
      kind: 'dependency',
      severity: 'USER_ACTION_REQUIRED',
      code: 'DEPENDENCY_DRIFT',
      messageZh: '依赖状态异常，需要检查数据库或 Redis',
    });
  }
  if (!input.serverOk) {
    findings.push({
      kind: 'server',
      severity: 'REPAIRABLE',
      code: 'SERVER_DRIFT',
      messageZh: '服务器状态异常，可能需要重新初始化',
    });
  }

  for (const u of input.units) {
    if (u.containerObservedRunning === false) {
      findings.push({
        kind: 'deployment',
        severity: 'REPAIRABLE',
        code: u.declaredHealthy
          ? 'DEPLOYMENT_DRIFT_CONTAINER_MISSING'
          : 'RUNTIME_CONTAINER_EXITED',
        messageZh: u.declaredHealthy
          ? '记录显示服务健康，但运行实例不存在'
          : '应用容器已退出，运行状态与记录不一致',
        unitId: u.unitId,
      });
    }
    if (u.declaredHealthy && u.healthObserved2xx === false) {
      findings.push({
        kind: 'deployment',
        severity: 'REPAIRABLE',
        code: 'DEPLOYMENT_DRIFT_UNHEALTHY',
        messageZh: '服务健康检查失败',
        unitId: u.unitId,
      });
    }
    if (u.dnsObservedCorrect === false) {
      findings.push({
        kind: 'dns',
        severity: 'REPAIRABLE',
        code: 'DNS_DRIFT_WRONG_VALUE',
        messageZh: '域名解析不正确，需要修复',
        unitId: u.unitId,
      });
    }
    if (u.gatewayActive === false) {
      findings.push({
        kind: 'gateway',
        severity: 'REPAIRABLE',
        code: 'GATEWAY_DRIFT',
        messageZh: '访问入口路由未就绪',
        unitId: u.unitId,
      });
    }
  }

  if (input.certificateExpired === true || input.certificateValid === false) {
    findings.push({
      kind: 'certificate',
      severity: input.certificateExpired ? 'USER_ACTION_REQUIRED' : 'REPAIRABLE',
      code: input.certificateExpired ? 'CERTIFICATE_EXPIRED' : 'CERTIFICATE_DRIFT',
      messageZh: input.certificateExpired
        ? 'HTTPS 证书已过期'
        : 'HTTPS 证书状态异常，需要修复',
    });
  }

  let severity: LaunchDriftSeverity = 'NONE';
  for (const f of findings) {
    if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[severity]) severity = f.severity;
  }

  return {
    severity,
    findings,
    desiredStateSatisfied: findings.length === 0 && input.accessEntryActive !== false,
  };
}
