/**
 * Step 26.3 — host tool / package-manager detection helpers (pure, testable).
 */

export type DetectedTool = {
  available: boolean;
  path: string | null;
  version: string | null;
};

export type HostToolProbe = {
  podman: DetectedTool;
  docker: DetectedTool;
  dnf: DetectedTool;
  yum: DetectedTool;
  microdnf: DetectedTool;
  rpm: DetectedTool;
  aptGet: DetectedTool;
};

export type PackageManagerKind = 'dnf' | 'yum' | 'microdnf' | 'apt-get';

export type RuntimeInstallStrategy =
  | { kind: 'REUSE_PODMAN'; podmanVersion: string }
  | { kind: 'INSTALL'; packageManager: PackageManagerKind; installCommands: string[] }
  | { kind: 'UNSUPPORTED_PACKAGE_MANAGER' }
  | { kind: 'PACKAGE_MANAGER_PROBE_FAILED'; reason: string };

export function emptyTool(): DetectedTool {
  return { available: false, path: null, version: null };
}

export function toolFromCommandProbe(input: {
  pathStdout?: string | null;
  versionStdout?: string | null;
  pathExitCode?: number | null;
  versionExitCode?: number | null;
}): DetectedTool {
  const path = String(input.pathStdout || '').trim().split(/\s+/)[0] || null;
  const pathOk =
    (input.pathExitCode === 0 || input.pathExitCode === undefined) && Boolean(path);
  const version =
    input.versionExitCode === 0 || input.versionExitCode === undefined
      ? String(input.versionStdout || '').trim().split('\n')[0] || null
      : null;
  return {
    available: Boolean(pathOk),
    path: pathOk ? path : null,
    version: pathOk ? version : null,
  };
}

/**
 * Resolve OS package family from /etc/os-release facts.
 * Alibaba Cloud Linux 4 Deb Edition is debian-like (apt-get), not dnf.
 */
export function resolveOsPackageFamily(input: {
  osName?: string | null;
  osId?: string | null;
  idLike?: string | null;
  variant?: string | null;
  variantId?: string | null;
}): 'rpm' | 'debian' | 'unknown' {
  const blob = [
    input.osName,
    input.osId,
    input.idLike,
    input.variant,
    input.variantId,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (/deb edition|variant_id["']?\s*=\s*deb|ubuntu|debian/.test(blob) || /id_like=.*debian/.test(blob)) {
    return 'debian';
  }
  if (/ubuntu|debian/.test(String(input.idLike || '').toLowerCase())) {
    return 'debian';
  }
  if (
    /rhel|centos|fedora|rocky|alinux|alibaba|anolis|amzn|suse/.test(blob) &&
    !/deb edition|ubuntu|debian/.test(blob)
  ) {
    return 'rpm';
  }
  if (/alinux/.test(blob) && /deb/.test(blob)) return 'debian';
  return 'unknown';
}

export function parseOsReleaseFields(text: string): {
  osName: string;
  osVersion: string;
  osId: string;
  idLike: string;
  variant: string;
  variantId: string;
} {
  const get = (key: string) =>
    new RegExp(`(?:^|\\n)${key}="?([^"\\n]+)"?`, 'i').exec(text)?.[1]?.trim() || '';
  return {
    osName: get('NAME') || get('ID') || 'Linux',
    osVersion: get('VERSION_ID') || get('VERSION') || '',
    osId: get('ID'),
    idLike: get('ID_LIKE'),
    variant: get('VARIANT'),
    variantId: get('VARIANT_ID'),
  };
}

export function selectPackageManagersForFamily(
  family: 'rpm' | 'debian' | 'unknown',
): PackageManagerKind[] {
  if (family === 'debian') return ['apt-get'];
  if (family === 'rpm') return ['dnf', 'yum', 'microdnf'];
  // unknown: try all known managers, prefer fact presence later
  return ['dnf', 'yum', 'microdnf', 'apt-get'];
}

export function pickAvailablePackageManager(
  tools: HostToolProbe,
  preferred: PackageManagerKind[],
): PackageManagerKind | null {
  for (const kind of preferred) {
    if (kind === 'apt-get' && tools.aptGet.available) return 'apt-get';
    if (kind === 'dnf' && tools.dnf.available) return 'dnf';
    if (kind === 'yum' && tools.yum.available) return 'yum';
    if (kind === 'microdnf' && tools.microdnf.available) return 'microdnf';
  }
  // fallback: any available
  if (tools.dnf.available) return 'dnf';
  if (tools.yum.available) return 'yum';
  if (tools.microdnf.available) return 'microdnf';
  if (tools.aptGet.available) return 'apt-get';
  return null;
}

export function buildPodmanInstallCommands(pm: PackageManagerKind): string[] {
  if (pm === 'apt-get') {
    return [
      'export DEBIAN_FRONTEND=noninteractive',
      'apt-get update -y',
      'apt-get install -y podman',
      // docker CLI compatibility when available in repos
      'apt-get install -y podman-docker || apt-get install -y docker-compose-v2 || true',
    ];
  }
  if (pm === 'microdnf') {
    return ['microdnf install -y podman', 'microdnf install -y podman-docker || true'];
  }
  // dnf / yum
  return [`${pm} install -y podman`, `${pm} install -y podman-docker || true`];
}

/**
 * Decide runtime strategy from facts.
 * Podman present → REUSE (package manager not required).
 */
export function decideRuntimeInstallStrategy(input: {
  tools: HostToolProbe;
  osFamily: 'rpm' | 'debian' | 'unknown';
  probeFailed?: boolean;
  probeErrorMessage?: string | null;
}): RuntimeInstallStrategy {
  if (input.probeFailed) {
    return {
      kind: 'PACKAGE_MANAGER_PROBE_FAILED',
      reason: input.probeErrorMessage || 'host tool probe failed',
    };
  }
  if (input.tools.podman.available) {
    return {
      kind: 'REUSE_PODMAN',
      podmanVersion: input.tools.podman.version || 'podman',
    };
  }
  const preferred = selectPackageManagersForFamily(input.osFamily);
  const pm = pickAvailablePackageManager(input.tools, preferred);
  if (!pm) {
    return { kind: 'UNSUPPORTED_PACKAGE_MANAGER' };
  }
  return {
    kind: 'INSTALL',
    packageManager: pm,
    installCommands: buildPodmanInstallCommands(pm),
  };
}

export function buildRuntimePlanFromFacts(input: {
  packageFamily: 'rpm' | 'debian' | 'unknown';
  tools: HostToolProbe;
  strategy: RuntimeInstallStrategy;
}): string[] {
  const lines = [
    'detect podman',
    'detect docker',
    'detect package managers (dnf/yum/microdnf/rpm/apt-get independently)',
  ];
  if (input.strategy.kind === 'REUSE_PODMAN') {
    lines.push('podman already present → REUSE (no package manager install required)');
    lines.push('verify podman info');
    lines.push('verify docker CLI compatibility');
    return lines;
  }
  if (input.strategy.kind === 'PACKAGE_MANAGER_PROBE_FAILED') {
    lines.push(`package manager probe failed: ${input.strategy.reason}`);
    return lines;
  }
  if (input.strategy.kind === 'UNSUPPORTED_PACKAGE_MANAGER') {
    lines.push('no supported package manager found for install');
    return lines;
  }
  const pm = input.strategy.packageManager;
  if (pm === 'apt-get') {
    lines.push('apt-get selected for debian-family OS (e.g. Alibaba Cloud Linux Deb Edition)');
    lines.push('install Podman using apt-compatible strategy');
  } else if (pm === 'dnf' || pm === 'yum' || pm === 'microdnf') {
    lines.push(`${pm} selected for rpm-family OS`);
    lines.push(`install Podman using ${pm}`);
  }
  lines.push('verify podman');
  lines.push('verify docker compatibility');
  return lines;
}

export function buildRuntimeDetectionSummary(tools: HostToolProbe): {
  podmanDetected: boolean;
  dockerDetected: boolean;
  dnfDetected: boolean;
  yumDetected: boolean;
  microdnfDetected: boolean;
  rpmDetected: boolean;
  aptGetDetected: boolean;
} {
  return {
    podmanDetected: tools.podman.available,
    dockerDetected: tools.docker.available,
    dnfDetected: tools.dnf.available,
    yumDetected: tools.yum.available,
    microdnfDetected: tools.microdnf.available,
    rpmDetected: tools.rpm.available,
    aptGetDetected: tools.aptGet.available,
  };
}

export function resumeFromPhase(
  lastSuccessful: string | null | undefined,
): string {
  const order = [
    'CONNECTING',
    'DETECTING_SYSTEM',
    'PREPARING_DIRECTORIES',
    'INSTALLING_RUNTIME',
    'CONFIGURING_FIREWALL',
    'CONFIGURING_RUNTIME',
    'VERIFYING_RUNTIME',
    'READY',
  ];
  if (!lastSuccessful) return 'CONNECTING';
  const idx = order.indexOf(lastSuccessful);
  if (idx < 0) return 'CONNECTING';
  if (idx >= order.length - 1) return 'READY';
  return order[idx + 1]!;
}

/** Wrap remote command so shell builtins (command -v) work under ssh2 exec. */
export function shellCommand(command: string): string {
  return `sh -lc ${JSON.stringify(command)}`;
}
