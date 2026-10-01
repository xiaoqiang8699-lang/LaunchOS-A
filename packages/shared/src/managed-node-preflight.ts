import { DYNAMIC_PORT_RANGE_END, DYNAMIC_PORT_RANGE_START } from './server-initialization';

export type ManagedPortObservation = 'free' | 'gateway' | 'occupied' | 'unknown';

export type ManagedNodeProbeFacts = {
  sshReachable: boolean;
  authOk: boolean;
  dockerAvailable: boolean;
  dockerDaemonUsable: boolean;
  diskFreeMb: number | null;
  workdirWritable: boolean;
  port80: ManagedPortObservation;
  port443: ManagedPortObservation;
  gatewayExecutable: boolean;
  gatewayConfigPresent: boolean;
  portRangeUsable: boolean;
  loopbackHttpOk: boolean;
};

export type ManagedNodePreflightBlocker = {
  code: string;
  message: string;
};

const MIN_DISK_FREE_MB = 2048;

export function evaluateManagedNodePreflight(facts: ManagedNodeProbeFacts): {
  status: 'READY' | 'UNAVAILABLE';
  localGatewayReady: boolean;
  blockers: ManagedNodePreflightBlocker[];
} {
  const blockers: ManagedNodePreflightBlocker[] = [];
  if (!facts.sshReachable) {
    blockers.push({ code: 'SSH_UNREACHABLE', message: '无法连接托管节点' });
  }
  if (!facts.authOk) {
    blockers.push({ code: 'SSH_AUTH_FAILED', message: '托管节点认证失败' });
  }
  if (!facts.dockerAvailable) {
    blockers.push({ code: 'DOCKER_MISSING', message: '托管节点没有 Docker' });
  }
  if (!facts.dockerDaemonUsable) {
    blockers.push({ code: 'DOCKER_DAEMON_UNUSABLE', message: 'Docker 守护进程不可用' });
  }
  if (facts.diskFreeMb == null || facts.diskFreeMb < MIN_DISK_FREE_MB) {
    blockers.push({ code: 'DISK_LOW', message: '托管节点磁盘空间不足' });
  }
  if (!facts.workdirWritable) {
    blockers.push({ code: 'WORKDIR_NOT_WRITABLE', message: '运行目录不可写' });
  }
  if (facts.port80 === 'unknown' || facts.port443 === 'unknown') {
    blockers.push({ code: 'PUBLIC_PORT_UNKNOWN', message: '无法判断 80/443 占用' });
  }
  if (!facts.gatewayExecutable || !facts.gatewayConfigPresent) {
    blockers.push({ code: 'GATEWAY_NOT_INSTALLED', message: '节点上没有可用的 Gateway' });
  }
  if (!facts.portRangeUsable) {
    blockers.push({ code: 'PORT_RANGE_UNAVAILABLE', message: '动态端口范围不可用' });
  }
  if (!facts.loopbackHttpOk) {
    blockers.push({ code: 'LOOPBACK_HTTP_FAILED', message: '节点本机 HTTP 不可访问' });
  }

  const gatewayListening = facts.port80 === 'gateway' || facts.port443 === 'gateway';
  const gatewayPortsClear =
    facts.port80 !== 'occupied' && facts.port443 !== 'occupied' && facts.port80 !== 'unknown' && facts.port443 !== 'unknown';
  const localGatewayReady =
    facts.gatewayExecutable &&
    facts.gatewayConfigPresent &&
    gatewayListening &&
    gatewayPortsClear &&
    facts.loopbackHttpOk &&
    facts.portRangeUsable;

  if (!localGatewayReady) {
    blockers.push({ code: 'LOCAL_GATEWAY_NOT_READY', message: 'Gateway 未在该节点就绪' });
  }

  const unique = dedupe(blockers);
  return {
    status: unique.length === 0 ? 'READY' : 'UNAVAILABLE',
    localGatewayReady: unique.length === 0 && localGatewayReady,
    blockers: unique,
  };
}

function dedupe(blockers: ManagedNodePreflightBlocker[]): ManagedNodePreflightBlocker[] {
  const seen = new Set<string>();
  return blockers.filter((item) => {
    if (seen.has(item.code)) return false;
    seen.add(item.code);
    return true;
  });
}

/** True when at least one host port in 39000–39999 is not already taken. */
export function managedPortRangeHasFreePort(listening: Iterable<number>): boolean {
  const taken = new Set<number>();
  for (const port of listening) {
    if (port >= DYNAMIC_PORT_RANGE_START && port <= DYNAMIC_PORT_RANGE_END) {
      taken.add(port);
    }
  }
  for (let port = DYNAMIC_PORT_RANGE_START; port <= DYNAMIC_PORT_RANGE_END; port += 1) {
    if (!taken.has(port)) return true;
  }
  return false;
}

export type ManagedNodeProbeRecord = Record<string, string>;

/**
 * Map a read-only SSH probe into preflight facts.
 * Docker-compatible CLIs (including podman-docker) count as runtime-ready.
 * systemd docker.service is ignored.
 */
export function interpretManagedNodeProbe(record: ManagedNodeProbeRecord): ManagedNodeProbeFacts {
  const listening = String(record.LISTENING_MANAGED_PORTS || '')
    .split(/[,\s]+/)
    .map((item) => Number(item))
    .filter((port) => Number.isInteger(port) && port > 0);
  const loopbackCode = Number(record.LOOPBACK_HTTP || '0');
  return {
    sshReachable: true,
    authOk: true,
    dockerAvailable: record.DOCKER_BIN === '1',
    dockerDaemonUsable: record.DOCKER_INFO_OK === '1' && record.DOCKER_PS_OK === '1',
    diskFreeMb: parseDiskMb(record.DISK_FREE_MB),
    workdirWritable: record.WORKDIR_WRITABLE === '1',
    port80: asPortObservation(record.PORT80),
    port443: asPortObservation(record.PORT443),
    gatewayExecutable: record.NGINX_BIN === '1',
    gatewayConfigPresent: record.GATEWAY_CONF === '1',
    portRangeUsable: managedPortRangeHasFreePort(listening),
    loopbackHttpOk: loopbackCode >= 100 && loopbackCode <= 599,
  };
}

export function parseManagedNodeProbeOutput(stdout: string): ManagedNodeProbeRecord {
  const record: ManagedNodeProbeRecord = {};
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    record[trimmed.slice(0, eq)] = trimmed.slice(eq + 1).trim();
  }
  return record;
}

function parseDiskMb(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function asPortObservation(raw: string | undefined): ManagedPortObservation {
  if (raw === 'free' || raw === 'gateway' || raw === 'occupied' || raw === 'unknown') return raw;
  return 'unknown';
}

export function passingManagedNodeProbe(): ManagedNodeProbeFacts {
  return {
    sshReachable: true,
    authOk: true,
    dockerAvailable: true,
    dockerDaemonUsable: true,
    diskFreeMb: 8_000,
    workdirWritable: true,
    port80: 'gateway',
    port443: 'gateway',
    gatewayExecutable: true,
    gatewayConfigPresent: true,
    portRangeUsable: true,
    loopbackHttpOk: true,
  };
}
