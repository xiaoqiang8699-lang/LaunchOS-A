/**
 * Step 31.1A — read-only 502 diagnosis. No restart, no writes.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const line of readFileSync(resolve(root, '.env'), 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i <= 0) continue;
  const k = t.slice(0, i).trim();
  let v = t.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (process.env[k] === undefined) process.env[k] = v;
}

const SERVER_ID = 'cmub78pz001sdripco5pexhdz';
const TARGET_IP = '116.62.198.184';
const SI = {
  api: 'cmuc66642002hritk6h3cbwhe',
  web: 'cmucaxah704r9ritkb30z16uw',
  test: 'cmudi7z3t1autritkew7edk6c',
};

const require = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = require('@launchos/database');
const { decryptCredential, resolveServerSshUsername, redactSecrets } = require('@launchos/shared');
const { RemoteRunner } = require('@launchos/remote-runner');

function sh(cmd) {
  return `sh -lc ${JSON.stringify(cmd)}`;
}

async function soft(runner, command, timeoutMs = 25_000) {
  try {
    const r = await runner.execute(command, { timeoutMs });
    return {
      exitCode: r.exitCode,
      stdout: redactSecrets(r.stdout || ''),
      stderr: redactSecrets((r.stderr || '').slice(0, 500)),
    };
  } catch (error) {
    return {
      exitCode: -1,
      stdout: '',
      stderr: redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 500),
    };
  }
}

function summarizeHttp(raw) {
  const text = raw || '';
  if (/Connection refused|connect to 127\.0\.0\.1 port/i.test(text) || /Couldn't connect/i.test(text)) {
    return { kind: 'connection refused', status: null, summary: 'connection refused' };
  }
  if (/timed out|Operation timed out|timeout/i.test(text)) {
    return { kind: 'timeout', status: null, summary: 'timeout' };
  }
  const m = text.match(/HTTP\/\d(?:\.\d)?\s+(\d+)/);
  const status = m ? Number(m[1]) : null;
  const body = text.split(/\r?\n\r?\n/).slice(1).join('\n').replace(/\s+/g, ' ').slice(0, 180);
  return { kind: status ? 'http' : 'other', status, summary: body || text.replace(/\s+/g, ' ').slice(0, 180) };
}

async function run() {
  const prisma = new PrismaClient();
  let password = '';
  try {
    const ids = Object.values(SI);
    const instances = await prisma.serviceInstance.findMany({
      where: { id: { in: ids } },
      include: {
        gatewayRoutes: true,
        healthChecks: { orderBy: { checkedAt: 'desc' }, take: 3 },
      },
    });
    const artifactIds = instances.map((s) => s.artifactId);
    const deployments = await prisma.deployment.findMany({
      where: {
        OR: [
          { deployableArtifactId: { in: artifactIds } },
          { sourceArtifactId: { in: artifactIds } },
          { artifacts: { some: { id: { in: artifactIds } } } },
        ],
      },
      include: {
        remoteDeployments: { orderBy: { startedAt: 'desc' }, take: 2 },
      },
      orderBy: { createdAt: 'desc' },
    });
    const routes = await prisma.gatewayRoute.findMany({
      where: {
        hostname: { in: ['api-launchos.zsaos.com', 'web-launchos.zsaos.com', 'oneclick-web.zsaos.com'] },
      },
    });

    const server = await prisma.serverInstance.findUnique({ where: { id: SERVER_ID } });
    if (!server || server.host !== TARGET_IP) throw new Error('server host mismatch');
    password = decryptCredential(server.credentialEncrypted);
    const username = resolveServerSshUsername({
      serverUsername: server.username,
      provider: server.provider,
    });
    const runner = new RemoteRunner();
    await runner.connect({
      host: server.host,
      port: server.port || 22,
      username,
      password,
      readyTimeoutMs: 25_000,
    });

    const ps = await soft(
      runner,
      sh(`podman ps -a --format '{{.ID}}|{{.Names}}|{{.Status}}|{{.State}}|{{.Ports}}|{{.Image}}'`),
    );
    const ss = await soft(runner, sh(`ss -lntp | grep -E ':39000|:39001|:39002' || true`));
    const nginx = await soft(
      runner,
      sh(
        `nginx -T 2>/dev/null | awk 'BEGIN{p=0} /server_name (api-launchos|web-launchos|oneclick-web)\\.zsaos\\.com/{p=1} p{print} /server_name / && !/server_name (api-launchos|web-launchos|oneclick-web)/{if(p&&seen++) p=0}' | grep -E 'server_name|proxy_pass|listen ' | head -n 80`,
      ),
    );

    const names = (ps.stdout || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const interesting = names.filter((l) => /launchos-|39000|39001|39002/.test(l));
    const inspects = [];
    for (const line of interesting) {
      const name = line.split('|')[1];
      if (!name) continue;
      const info = await soft(
        runner,
        sh(
          `podman inspect ${name} --format '{{.Name}}|{{.State.Status}}|{{.State.ExitCode}}|{{.RestartCount}}|{{.State.StartedAt}}|{{.State.FinishedAt}}|{{.State.OOMKilled}}|{{.HostConfig.RestartPolicy.Name}}|{{json .HostConfig.PortBindings}}|{{.State.Error}}'`,
        ),
      );
      const logs = await soft(runner, sh(`podman logs --tail 80 ${name} 2>&1 | tail -n 80`), 40_000);
      inspects.push({ line, inspect: info, logs: (logs.stdout || logs.stderr || '').slice(-2500) });
    }

    const curls = {};
    for (const [key, url] of [
      ['p39000', 'http://127.0.0.1:39000/health'],
      ['p39002', 'http://127.0.0.1:39002/'],
      ['p39001', 'http://127.0.0.1:39001/'],
    ]) {
      const r = await soft(runner, sh(`curl -sS -i --max-time 5 ${url} || true`));
      curls[key] = summarizeHttp(`${r.stdout}\n${r.stderr}`);
    }

    await runner.disconnect();
    password = '';

    const report = {
      WRITE_COMMANDS_EXECUTED_THIS_RUN: false,
      serviceInstances: instances.map((s) => ({
        id: s.id,
        status: s.status,
        healthStatus: s.healthStatus,
        healthMessage: s.healthMessage,
        port: s.port,
        externalPort: s.externalPort,
        internalPort: s.internalPort,
        containerId: s.containerId,
        artifactId: s.artifactId,
        serverInstanceId: s.serverInstanceId,
        lastHealthCheckAt: s.lastHealthCheckAt,
        healthChecks: s.healthChecks.map((h) => ({
          status: h.status,
          statusCode: h.statusCode,
          message: h.message,
          checkedAt: h.checkedAt,
        })),
        gatewayRoutes: s.gatewayRoutes.map((g) => ({
          hostname: g.hostname,
          targetHost: g.targetHost,
          targetPort: g.targetPort,
          status: g.status,
        })),
      })),
      routes,
      deployments: deployments.map((d) => ({
        id: d.id,
        status: d.status,
        targetType: d.targetType,
        deployableUnitId: d.deployableUnitId,
        deployableArtifactId: d.deployableArtifactId,
        serverInstanceId: d.serverInstanceId,
        errorMessage: d.errorMessage,
        containerName: `launchos-${d.id.slice(0, 10).toLowerCase()}`,
        remote: d.remoteDeployments.map((r) => ({ id: r.id, status: r.status, finishedAt: r.finishedAt })),
      })),
      podmanPs: ps.stdout,
      listeners: ss.stdout,
      nginx: nginx.stdout || nginx.stderr,
      inspects,
      curls,
    };
    const text = JSON.stringify(report, null, 2);
    if (password && text.includes(password)) throw new Error('password leak');
    console.log(redactSecrets(text));
  } finally {
    password = '';
    await prisma.$disconnect();
  }
}

run().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
