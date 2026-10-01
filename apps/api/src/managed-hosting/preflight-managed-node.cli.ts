import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { PrismaClient, ServerScope } from '@launchos/database';
import { RemoteRunner } from '@launchos/remote-runner';
import {
  decryptCredential,
  interpretManagedNodeProbe,
  parseManagedNodeProbeOutput,
} from '@launchos/shared';
import { applyManagedNodePreflight } from './managed-node-registry';

config({ path: resolve(process.cwd(), '.env') });
config({ path: resolve(process.cwd(), '../../.env') });
loadManagedNodeFile(resolve(process.cwd(), '.env.step26.local'));
loadManagedNodeFile(resolve(process.cwd(), '../../.env.step26.local'));

const host = process.env.MANAGED_NODE_HOST?.trim() || '';
if (!host) {
  console.error('需要运行时提供 MANAGED_NODE_HOST，用于匹配已登记的平台节点。');
  process.exit(1);
}

const READ_ONLY_PROBE = `
set +e
if command -v docker >/dev/null 2>&1; then echo DOCKER_BIN=1; else echo DOCKER_BIN=0; fi
if docker info >/dev/null 2>&1; then echo DOCKER_INFO_OK=1; else echo DOCKER_INFO_OK=0; fi
if docker ps >/dev/null 2>&1; then echo DOCKER_PS_OK=1; else echo DOCKER_PS_OK=0; fi
engine=docker-compatible
if docker info 2>/dev/null | grep -qi podman; then engine=podman; fi
docker_path=$(command -v docker 2>/dev/null || true)
if [ -n "$docker_path" ] && readlink -f "$docker_path" 2>/dev/null | grep -qi podman; then engine=podman; fi
echo "RUNTIME_ENGINE=$engine"
df -Pk / | awk 'NR==2 { printf "DISK_FREE_MB=%d\\n", $4/1024 }'
if test -w /opt/launchos; then echo WORKDIR_WRITABLE=1; else echo WORKDIR_WRITABLE=0; fi
if command -v nginx >/dev/null 2>&1; then echo NGINX_BIN=1; else echo NGINX_BIN=0; fi
if test -f /opt/launchos/gateway/active/launchos-routes.conf; then echo GATEWAY_CONF=1; else echo GATEWAY_CONF=0; fi
nginx_active=0
if systemctl is-active nginx >/dev/null 2>&1; then nginx_active=1; fi
port_state() {
  local port="$1"
  local line matched=0
  line=$(ss -ltnp 2>/dev/null | awk -v want="$port" 'NR>1 {
    n = split($4, parts, ":")
    p = parts[n]
    gsub(/\\]/, "", p)
    if (p == want) { print; exit }
  }')
  if [ -z "$line" ]; then echo free; return; fi
  if echo "$line" | grep -qi nginx; then echo gateway; return; fi
  if [ "$nginx_active" = "1" ]; then echo gateway; return; fi
  echo occupied
}
echo "PORT80=$(port_state 80)"
echo "PORT443=$(port_state 443)"
ports=$(ss -ltn 2>/dev/null | awk 'NR>1 {
  n = split($4, parts, ":")
  p = parts[n]
  gsub(/\\]/, "", p)
  if (p+0 >= 39000 && p+0 <= 39999) print p
}' | sort -u | paste -sd, -)
echo "LISTENING_MANAGED_PORTS=\${ports}"
if command -v curl >/dev/null 2>&1; then
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1/ || true)
  echo "LOOPBACK_HTTP=\${code:-000}"
else
  echo LOOPBACK_HTTP=000
fi
count=$(docker ps -q 2>/dev/null | wc -l | tr -d ' ')
echo "CONTAINER_COUNT=\${count:-0}"
`.trim();

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const runner = new RemoteRunner();
  try {
    const node = await prisma.serverInstance.findFirst({
      where: {
        scope: ServerScope.PLATFORM_MANAGED,
        workspaceId: null,
        host,
      },
      select: {
        id: true,
        host: true,
        port: true,
        username: true,
        status: true,
        dockerStatus: true,
        scope: true,
        workspaceId: true,
        credentialEncrypted: true,
      },
    });
    if (!node) {
      console.error('没有找到匹配 MANAGED_NODE_HOST 的 PLATFORM_MANAGED 节点。');
      process.exitCode = 1;
      return;
    }
    const beforeStatus = node.status;
    const password = decryptCredential(node.credentialEncrypted);
    await runner.connect({
      host: node.host,
      port: node.port,
      username: node.username,
      password,
    });
    const probe = await runner.execute(READ_ONLY_PROBE, { timeoutMs: 30_000 });
    if (probe.exitCode !== 0 && !probe.stdout.includes('DOCKER_BIN=')) {
      console.error(`预检命令没有返回结果，exit=${probe.exitCode}`);
      process.exitCode = 1;
      return;
    }
    const record = parseManagedNodeProbeOutput(probe.stdout);
    const facts = interpretManagedNodeProbe(record);
    const updated = await applyManagedNodePreflight(prisma, node.id, facts);
    const stored = await prisma.serverInstance.findUnique({
      where: { id: node.id },
      select: { metadata: true },
    });
    const metadata = asObject(stored?.metadata);
    console.log(
      JSON.stringify({
        id: updated.id,
        host: updated.host,
        port: updated.port,
        scope: updated.scope,
        workspaceId: updated.workspaceId,
        beforeStatus,
        status: updated.status,
        dockerStatus: updated.dockerStatus,
        runtimeEngine: record.RUNTIME_ENGINE || 'unknown',
        containerCount: Number(record.CONTAINER_COUNT || '0'),
        preflightStatus: metadata.preflightStatus ?? null,
        localGatewayReady: metadata.localGatewayReady === true,
        schedulable: metadata.schedulable === true,
        preflightBlockers: Array.isArray(metadata.preflightBlockers) ? metadata.preflightBlockers : [],
        diskFreeMb: facts.diskFreeMb,
        portRangeUsable: facts.portRangeUsable,
      }),
    );
    if (updated.status !== 'READY') {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(redact(error instanceof Error ? error.message : '预检失败'));
    process.exitCode = 1;
  } finally {
    await runner.disconnect().catch(() => undefined);
    await prisma.$disconnect();
  }
}

function loadManagedNodeFile(file: string): void {
  if (!existsSync(file)) return;
  const text = readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key.startsWith('MANAGED_NODE_')) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function redact(message: string): string {
  const secret = process.env.MANAGED_NODE_PASSWORD || '';
  if (secret && message.includes(secret)) {
    return message.split(secret).join('[REDACTED]');
  }
  return message;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

void main();
