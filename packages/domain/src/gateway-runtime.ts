/**
 * Step 29 Phase 2 — GatewayRuntimeProvider (NGINX).
 * Pure detect/plan helpers. Real install/write only when apply=true (Phase 3).
 */
import type { PackageManagerKind } from '@launchos/shared';

export const GATEWAY_ROOT = '/opt/launchos/gateway';
export const GATEWAY_LAYOUT = {
  root: GATEWAY_ROOT,
  generated: `${GATEWAY_ROOT}/generated`,
  active: `${GATEWAY_ROOT}/active`,
  backups: `${GATEWAY_ROOT}/backups`,
  certificates: `${GATEWAY_ROOT}/certificates`,
  includeConf: `${GATEWAY_ROOT}/active/launchos-routes.conf`,
} as const;

export type GatewayProviderKind = 'NGINX';

export type GatewayDetectFacts = {
  provider: GatewayProviderKind;
  installed: boolean;
  running: boolean;
  binaryPath: string | null;
  version: string | null;
  packageManager: PackageManagerKind | null;
  packageManagerSupported: boolean;
  installRequired: boolean;
  publicPortsListening: number[];
  dynamicPortsListeningPublicly: number[];
  configRoot: string | null;
  includePath: string;
};

export type GatewayInstallPlan = {
  provider: GatewayProviderKind;
  packageName: string;
  packageManager: 'apt-get';
  commands: string[];
  idempotent: true;
  publicPorts: number[];
  dynamicRuntimePortsPrivate: true;
};

export type StagedConfigApplyPlan = {
  tempPath: string;
  activePath: string;
  backupPath: string;
  testCommand: string;
  activateCommands: string[];
  reloadCommand: string;
  rollbackCommands: string[];
};

export interface GatewayRuntimeProvider {
  readonly kind: GatewayProviderKind;
  detectFromFacts(input: {
    nginxBinaryPath?: string | null;
    nginxVersion?: string | null;
    nginxRunning?: boolean;
    aptGetAvailable?: boolean;
    listeningPorts?: number[];
  }): GatewayDetectFacts;
  planInstall(detect: GatewayDetectFacts): GatewayInstallPlan | null;
  planStagedApply(input: {
    configBody: string;
    stamp?: string;
  }): StagedConfigApplyPlan;
}

export class NginxGatewayProvider implements GatewayRuntimeProvider {
  readonly kind = 'NGINX' as const;

  detectFromFacts(input: {
    nginxBinaryPath?: string | null;
    nginxVersion?: string | null;
    nginxRunning?: boolean;
    aptGetAvailable?: boolean;
    listeningPorts?: number[];
  }): GatewayDetectFacts {
    const installed = Boolean(input.nginxBinaryPath);
    const running = Boolean(input.nginxRunning);
    const apt = Boolean(input.aptGetAvailable);
    const listening = [...new Set((input.listeningPorts || []).filter((p) => Number.isInteger(p)))];
    const publicPortsListening = listening.filter((p) => p === 80 || p === 443 || p === 22);
    const dynamicPortsListeningPublicly = listening.filter((p) => p >= 39000 && p <= 39999);
    return {
      provider: 'NGINX',
      installed,
      running,
      binaryPath: input.nginxBinaryPath || null,
      version: input.nginxVersion || null,
      packageManager: apt ? 'apt-get' : null,
      packageManagerSupported: apt,
      installRequired: !installed,
      publicPortsListening,
      dynamicPortsListeningPublicly,
      configRoot: installed ? '/etc/nginx' : null,
      includePath: GATEWAY_LAYOUT.includeConf,
    };
  }

  planInstall(detect: GatewayDetectFacts): GatewayInstallPlan | null {
    if (!detect.installRequired) return null;
    if (!detect.packageManagerSupported || detect.packageManager !== 'apt-get') {
      throw new Error('GATEWAY_INSTALL_UNSUPPORTED_PACKAGE_MANAGER');
    }
    return {
      provider: 'NGINX',
      packageName: 'nginx',
      packageManager: 'apt-get',
      commands: [
        'export DEBIAN_FRONTEND=noninteractive',
        'apt-get update -y',
        'apt-get install -y nginx',
        `mkdir -p ${GATEWAY_LAYOUT.generated} ${GATEWAY_LAYOUT.active} ${GATEWAY_LAYOUT.backups} ${GATEWAY_LAYOUT.certificates}`,
        // Ensure LaunchOS include is present without replacing whole nginx.conf
        `grep -q 'launchos/gateway/active' /etc/nginx/nginx.conf || echo 'include ${GATEWAY_LAYOUT.includeConf};' > /etc/nginx/conf.d/launchos-include.conf`,
        'systemctl enable nginx || true',
      ],
      idempotent: true,
      publicPorts: [80, 443],
      dynamicRuntimePortsPrivate: true,
    };
  }

  planStagedApply(input: { configBody: string; stamp?: string }): StagedConfigApplyPlan {
    const stamp = input.stamp || new Date().toISOString().replace(/[:.]/g, '-');
    const tempPath = `${GATEWAY_LAYOUT.generated}/routes-${stamp}.conf`;
    const activePath = GATEWAY_LAYOUT.includeConf;
    const backupPath = `${GATEWAY_LAYOUT.backups}/routes-${stamp}.conf`;
    return {
      tempPath,
      activePath,
      backupPath,
      testCommand: 'nginx -t',
      activateCommands: [
        `mkdir -p ${GATEWAY_LAYOUT.generated} ${GATEWAY_LAYOUT.active} ${GATEWAY_LAYOUT.backups}`,
        // write temp happens outside; then:
        `if [ -f ${activePath} ]; then cp -f ${activePath} ${backupPath}; fi`,
        `cp -f ${tempPath} ${activePath}.new`,
        `mv -f ${activePath}.new ${activePath}`,
      ],
      reloadCommand: 'nginx -s reload',
      rollbackCommands: [
        `if [ -f ${backupPath} ]; then cp -f ${backupPath} ${activePath}; nginx -t && nginx -s reload; fi`,
      ],
    };
  }
}

export function classifyPublicEntryPortBlocker(input: {
  securityGroupReady: boolean;
  listening80: boolean;
  listening443: boolean;
}): {
  code: 'GATEWAY_LISTENER_PENDING' | null;
  securityGroupChangeRequired: false;
} {
  if (input.securityGroupReady && (!input.listening80 || !input.listening443)) {
    return { code: 'GATEWAY_LISTENER_PENDING', securityGroupChangeRequired: false };
  }
  return { code: null, securityGroupChangeRequired: false };
}
