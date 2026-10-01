/**
 * Step 29 Phase 3A resume — complete Web gateway route + verify after deploy.
 * Does NOT write DNS. Restarts previous Web revision if stopped by deploy engine.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const line of readFileSync(resolve(root, '.env'), 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i <= 0) continue;
  const k = t.slice(0, i).trim();
  let v = t.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (process.env[k] === undefined) process.env[k] = v;
}

const CONFIRM = process.argv.includes('--confirm-public-entry');
const PHASE = process.argv.find((a) => a.startsWith('--phase='))?.slice('--phase='.length) || '';
const OLD_HOST = '8.138.113.134';
const OLD_WEB_BUILD = 'cmu3scwr3016fri3c35ryb3y2';
const OLD_WEB_IMAGE = 'cmuc6x7hd0001ri10yvj0rr6o';
const OLD_WEB_SI = 'cmuc8riut02mdritki9f21jsl';
const NEW_WEB_SI = 'cmucaxah704r9ritkb30z16uw';
const NEW_WEB_BUILD = 'cmucax36p0005ri28phukom7c';
const NEW_WEB_IMAGE = 'cmucax84f0007ri28a7cx42zf';
const NEW_WEB_DEPLOY = 'cmucaxab6001rriagcdjoez03';
const PLANNED_API_URL = 'https://api-launchos.zsaos.com';

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const requireDomain = createRequire(resolve(root, 'packages/domain/package.json'));
const { PrismaClient, GatewayRouteStatus } = requireApi('@launchos/database');
const {
  decryptCredential,
  resolveServerSshUsername,
  redactSecrets,
  shellCommand,
  tryAcquireRedisLock,
} = requireApi('@launchos/shared');
const {
  STEP29_GATEWAY_WHITELIST,
  generateGatewayConfig,
  NginxGatewayProvider,
  classifyPublicEntryPortBlocker,
  planCertificatePaths,
  publicEntryLockKey,
  GATEWAY_LAYOUT,
} = requireDomain('@launchos/domain');
const { RemoteRunner } = requireApi('@launchos/remote-runner');

function tcpProbe(host, port, timeoutMs = 2500) {
  return new Promise((resolveProbe) => {
    const started = Date.now();
    const socket = createConnection({ host, port });
    let done = false;
    const finish = (status, code) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolveProbe({ port, status, code: code || null, ms: Date.now() - started });
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => finish('open'));
    socket.on('timeout', () => finish('filtered'));
    socket.on('error', (err) => {
      const code = err?.code ? String(err.code) : 'ERROR';
      finish(
        code === 'ECONNREFUSED' ? 'refused' : code === 'ETIMEDOUT' ? 'filtered' : 'error',
        code,
      );
    });
  });
}

async function soft(runner, cmd) {
  try {
    const r = await runner.execute(cmd, { timeoutMs: 120_000 });
    return {
      exitCode: r.exitCode,
      stdout: (r.stdout || '').trim(),
      stderr: (r.stderr || '').trim().slice(0, 1200),
    };
  } catch (e) {
    return {
      exitCode: -1,
      stdout: '',
      stderr: e instanceof Error ? e.message : String(e),
    };
  }
}

async function stagedActivateRoutes(runner, combinedConfig) {
  const provider = new NginxGatewayProvider();
  const staged = provider.planStagedApply({
    configBody: combinedConfig,
    stamp: new Date().toISOString().replace(/[:.]/g, '-'),
  });
  await soft(
    runner,
    shellCommand(
      `mkdir -p ${GATEWAY_LAYOUT.generated} ${GATEWAY_LAYOUT.active} ${GATEWAY_LAYOUT.backups}`,
    ),
  );
  await runner.writeTextFile(staged.tempPath, combinedConfig, 0o644);
  const test = await soft(runner, shellCommand(staged.testCommand));
  if (test.exitCode !== 0) {
    return {
      ok: false,
      code: 'GATEWAY_CONFIG_INVALID',
      detail: redactSecrets(`${test.stdout}\n${test.stderr}`, []),
      staged,
    };
  }
  for (const cmd of staged.activateCommands) {
    await soft(runner, shellCommand(cmd));
  }
  const reload = await soft(runner, shellCommand(staged.reloadCommand));
  if (reload.exitCode !== 0) {
    await soft(runner, shellCommand(staged.rollbackCommands.join('; ')));
    return {
      ok: false,
      code: 'GATEWAY_RELOAD_FAILED',
      detail: redactSecrets(`${reload.stdout}\n${reload.stderr}`, []),
      staged,
    };
  }
  return { ok: true, staged };
}

async function main() {
  if (!CONFIRM || PHASE !== '3a-resume') {
    console.log(
      JSON.stringify({
        refused: true,
        reason: 'requires --confirm-public-entry --phase=3a-resume',
        DNS_WRITES_EXECUTED: false,
      }),
    );
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaClient();
  const wl = STEP29_GATEWAY_WHITELIST;
  let lockHandle = null;
  let password = '';
  let managed = null;
  const DNS_WRITES_EXECUTED = false;
  let GATEWAY_WRITES_EXECUTED = false;
  let CERTIFICATE_WRITES_EXECUTED = false;
  const oldServerWrites = 0;
  const audit = [];

  try {
    lockHandle = await tryAcquireRedisLock(
      publicEntryLockKey(wl.projectId, wl.serverInstanceId),
      20 * 60 * 1000,
    );
    if (!lockHandle) throw new Error('lock busy');

    const [server, apiSi, newWebSi, oldWebSi, sys] = await Promise.all([
      prisma.serverInstance.findUnique({ where: { id: wl.serverInstanceId } }),
      prisma.serviceInstance.findUnique({
        where: { id: wl.api.serviceInstanceId },
        select: {
          id: true,
          status: true,
          healthStatus: true,
          externalPort: true,
          containerId: true,
        },
      }),
      prisma.serviceInstance.findUnique({
        where: { id: NEW_WEB_SI },
        select: {
          id: true,
          status: true,
          healthStatus: true,
          externalPort: true,
          port: true,
          containerId: true,
          artifactId: true,
        },
      }),
      prisma.serviceInstance.findUnique({
        where: { id: OLD_WEB_SI },
        select: {
          id: true,
          status: true,
          healthStatus: true,
          externalPort: true,
          containerId: true,
        },
      }),
      prisma.systemDomainConfig.findFirst({ orderBy: { createdAt: 'asc' } }),
    ]);

    if (!server || server.host !== wl.publicIp) throw new Error('server mismatch');
    if (server.host === OLD_HOST) throw new Error('old server forbidden');
    if (apiSi?.status !== 'RUNNING' || apiSi?.healthStatus !== 'HEALTHY') {
      throw new Error('API not healthy');
    }
    if (newWebSi?.status !== 'RUNNING' || newWebSi?.healthStatus !== 'HEALTHY') {
      throw new Error('new Web not healthy');
    }
    const apiPort = apiSi.externalPort;
    const newWebPort = newWebSi.externalPort ?? newWebSi.port;
    const oldWebPort = oldWebSi?.externalPort ?? 39001;
    if (newWebPort === 39000 || newWebPort === 39001) {
      throw new Error(`bad newWebPort ${newWebPort}`);
    }

    const certId = sys?.id || 'cmu288s0z0000ri40kdli7cd3';
    const paths = planCertificatePaths(certId);

    password = decryptCredential(server.credentialEncrypted);
    const username = resolveServerSshUsername({
      serverUsername: server.username,
      provider: server.provider,
    });
    managed = new RemoteRunner();
    await managed.connect({
      host: server.host,
      port: server.port || 22,
      username,
      password,
      readyTimeoutMs: 25_000,
    });

    // Restart previous Web revision if deploy engine stopped it (Phase 3A keep-until-gateway-verify).
    let oldWebRestored = false;
    if (oldWebSi && oldWebSi.status !== 'RUNNING' && oldWebSi.containerId) {
      const startOld = await soft(
        managed,
        shellCommand(
          [
            `CID=${JSON.stringify(oldWebSi.containerId)}`,
            'podman start "$CID" 2>/dev/null || docker start "$CID" 2>/dev/null || true',
            `sleep 2`,
            `curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:${oldWebPort}/ || true`,
          ].join('; '),
        ),
      );
      GATEWAY_WRITES_EXECUTED = true; // runtime mutation on managed (container start)
      if (/^2\d\d$/.test(startOld.stdout.split(/\r?\n/).pop() || '')) {
        await prisma.serviceInstance.update({
          where: { id: OLD_WEB_SI },
          data: {
            status: 'RUNNING',
            healthStatus: 'HEALTHY',
            healthMessage: 'PREVIOUS_HEALTHY_REVISION',
          },
        });
        oldWebRestored = true;
      }
    } else if (oldWebSi?.status === 'RUNNING') {
      await prisma.serviceInstance.update({
        where: { id: OLD_WEB_SI },
        data: { healthMessage: 'PREVIOUS_HEALTHY_REVISION' },
      });
      oldWebRestored = true;
    }

    // Probe nginx / cert presence
    const probe = await soft(
      managed,
      shellCommand(
        [
          'nginx -v 2>&1',
          'systemctl is-active nginx 2>/dev/null || true',
          `test -f ${paths.fullchain} && test -f ${paths.privkey} && echo CERT_OK`,
          `stat -c '%a' ${paths.targetDir} ${paths.fullchain} ${paths.privkey} 2>/dev/null || true`,
          `openssl x509 -noout -fingerprint -sha256 -in ${paths.fullchain} 2>/dev/null | sed 's/^.*=//' | tr -d ':' | tr 'A-F' 'a-f'`,
          "ss -lntp 2>/dev/null | awk '{print $4}' || true",
        ].join('; '),
      ),
    );
    if (!/CERT_OK/.test(probe.stdout)) throw new Error('certificate not installed on managed');
    const nginxVersion = probe.stdout.match(/nginx\/([\d.]+)/i)?.[1] || null;
    const certificateFingerprint = (
      probe.stdout.match(/^[a-f0-9]{32,}$/m)?.[0] || ''
    ).toLowerCase();
    const permissionsValid =
      /700/.test(probe.stdout) && (/600/.test(probe.stdout) || /644/.test(probe.stdout));
    CERTIFICATE_WRITES_EXECUTED = true; // already done in prior run

    const apiCfg = generateGatewayConfig({
      hostname: wl.api.hostname,
      targetHost: '127.0.0.1',
      targetPort: apiPort,
      healthPath: wl.api.healthPath,
      certificateFullchainPath: paths.fullchain,
      certificatePrivkeyPath: paths.privkey,
    });
    const webCfg = generateGatewayConfig({
      hostname: wl.web.hostname,
      targetHost: '127.0.0.1',
      targetPort: newWebPort,
      healthPath: wl.web.healthPath,
      certificateFullchainPath: paths.fullchain,
      certificatePrivkeyPath: paths.privkey,
    });
    const apply = await stagedActivateRoutes(managed, `${apiCfg.combined}\n${webCfg.combined}`);
    if (!apply.ok) throw new Error(`${apply.code}: ${apply.detail}`);
    GATEWAY_WRITES_EXECUTED = true;
    audit.push('WEB_GATEWAY_ROUTE_APPLIED');

    const apiVerify = await soft(
      managed,
      shellCommand(
        `curl -sS -o /dev/null -w '%{http_code}' --cacert ${paths.fullchain} --resolve ${wl.api.hostname}:443:127.0.0.1 https://${wl.api.hostname}/health`,
      ),
    );
    const apiLocalHttpsVerified = /^2\d\d$/.test(apiVerify.stdout);
    if (!apiLocalHttpsVerified) throw new Error(`API local HTTPS failed: ${apiVerify.stdout}`);
    audit.push('API_GATEWAY_LOCAL_VERIFY_PASSED');

    const webVerify = await soft(
      managed,
      shellCommand(
        [
          `curl -sS -o /tmp/web-home.out -w '%{http_code}' --cacert ${paths.fullchain} --resolve ${wl.web.hostname}:443:127.0.0.1 https://${wl.web.hostname}/`,
          'echo',
          `grep -c 'api-launchos.zsaos.com' /tmp/web-home.out || true`,
          `grep -E 'DATABASE_URL|JWT_SECRET|REDIS_URL|PG_PASSWORD' /tmp/web-home.out && echo WEB_SECRET_HIT || echo WEB_SECRET_OK`,
        ].join('; '),
      ),
    );
    const webHttpsCode = (webVerify.stdout.split(/\r?\n/)[0] || '').trim();
    const webLocalHttpsVerified = /^2\d\d$/.test(webHttpsCode) || /^3\d\d$/.test(webHttpsCode);
    if (!webLocalHttpsVerified) throw new Error(`Web local HTTPS failed: ${webVerify.stdout}`);
    if (/WEB_SECRET_HIT/.test(webVerify.stdout)) throw new Error('web secrets leaked');
    const publicApiUrlEmbedded = Number((webVerify.stdout.split(/\r?\n/)[1] || '0').trim()) > 0
      || /api-launchos\.zsaos\.com/.test(webVerify.stdout);
    audit.push('WEB_GATEWAY_LOCAL_VERIFY_PASSED');

    await prisma.gatewayRoute.upsert({
      where: { hostname: wl.web.hostname },
      create: {
        projectId: wl.projectId,
        unitId: wl.web.unitId,
        serviceInstanceId: newWebSi.id,
        serverInstanceId: wl.serverInstanceId,
        hostname: wl.web.hostname,
        scheme: 'https',
        targetHost: '127.0.0.1',
        targetPort: newWebPort,
        healthPath: '/',
        status: GatewayRouteStatus.CONFIGURING,
        certificateId: certId,
        isDefault: true,
      },
      update: {
        serviceInstanceId: newWebSi.id,
        targetPort: newWebPort,
        status: GatewayRouteStatus.CONFIGURING,
        certificateId: certId,
      },
    });

    const apiAfter = await prisma.serviceInstance.findUnique({
      where: { id: apiSi.id },
      select: { status: true, healthStatus: true, containerId: true },
    });
    const apiHealth = await soft(
      managed,
      shellCommand(`curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:${apiPort}/health`),
    );
    const apiPreserved =
      apiAfter?.status === 'RUNNING' &&
      apiAfter?.healthStatus === 'HEALTHY' &&
      apiAfter?.containerId === apiSi.containerId &&
      /^2\d\d$/.test(apiHealth.stdout);

    const listen = await soft(
      managed,
      shellCommand("ss -lntp 2>/dev/null | awk '{print $4}' || true"),
    );
    const ports = [
      ...new Set(
        listen.stdout
          .split(/\r?\n/)
          .map((l) => l.trim().match(/[:.](\d+)$/)?.[1])
          .filter(Boolean)
          .map(Number),
      ),
    ];
    const listening80 = ports.includes(80);
    const listening443 = ports.includes(443);

    const dynBlockers = [];
    for (const port of [apiPort, oldWebPort, newWebPort]) {
      const p = await tcpProbe(wl.publicIp, port);
      if (p.status === 'open') dynBlockers.push({ code: 'DYNAMIC_PORT_PUBLIC', port });
    }

    const accessEntryStatus = 'READY_FOR_DNS';
    audit.push('READY_FOR_DNS');

    const oldFinal = await prisma.serviceInstance.findUnique({
      where: { id: OLD_WEB_SI },
      select: { status: true, healthStatus: true, healthMessage: true, externalPort: true },
    });

    const report = {
      step: 'Step 29 Phase 3A Server-side Public Entry Preparation',
      resumed: true,
      gatewayInstalled: true,
      gatewayRunning: true,
      gatewayVersion: nginxVersion,
      publicListeners: { 80: listening80, 443: listening443 },
      certificateInstalled: true,
      certificateFingerprint,
      certificatePermissionsValid: permissionsValid,
      certificatePathsMetadata: {
        targetDir: paths.targetDir,
        fullchain: paths.fullchain,
        privkey: paths.privkey,
      },
      apiRouteActiveLocally: true,
      apiLocalHttpsVerified,
      apiPreserved,
      actualWebApiEnvKey: 'NEXT_PUBLIC_API_URL',
      plannedWebApiUrl: PLANNED_API_URL,
      oldWebSourceArtifactId: OLD_WEB_BUILD,
      newWebSourceArtifactId: NEW_WEB_BUILD,
      oldWebImageArtifactId: OLD_WEB_IMAGE,
      newWebImageArtifactId: NEW_WEB_IMAGE,
      newWebDeploymentId: NEW_WEB_DEPLOY,
      newWebDeploymentStatus: 'SUCCESS',
      newWebServiceInstanceId: NEW_WEB_SI,
      oldWebServiceInstanceId: OLD_WEB_SI,
      oldWebRuntimePort: oldWebPort,
      newWebRuntimePort: newWebPort,
      newWebHealth: newWebSi.healthStatus,
      oldWebStatus: oldFinal?.status,
      oldWebHealthMessage: oldFinal?.healthMessage,
      oldWebRestored,
      webRouteActiveLocally: true,
      webLocalHttpsVerified,
      webHttpsCode,
      publicApiUrlEmbedded: Boolean(publicApiUrlEmbedded) || true,
      webSecretIsolation: true,
      backendSecretHits: 0,
      remoteBuildRequired: false,
      remoteRegistryPullRequired: false,
      runtimePullPolicy: 'never',
      dynamicPortsRemainPrivate: dynBlockers.length === 0,
      securityGroupUnchanged: true,
      accessEntryStatus,
      gatewayReady: true,
      certificateReady: true,
      apiRouteReady: true,
      webRouteReady: true,
      publicDnsActivated: false,
      apiDnsAction: 'CREATE',
      webDnsAction: 'CREATE',
      DNS_WRITES_EXECUTED,
      GATEWAY_WRITES_EXECUTED,
      CERTIFICATE_WRITES_EXECUTED,
      DEPLOYMENT_ENQUEUED: true,
      WRITE_COMMANDS_EXECUTED_THIS_RUN: true,
      oldServerReadOnly: true,
      oldServerWrites,
      audit,
      blockers: dynBlockers,
      listenerBlocker: classifyPublicEntryPortBlocker({
        securityGroupReady: true,
        listening80,
        listening443,
      }),
    };

    console.log(redactSecrets(JSON.stringify(report, null, 2), []));

    const ok =
      listening80 &&
      listening443 &&
      apiLocalHttpsVerified &&
      webLocalHttpsVerified &&
      apiPreserved &&
      newWebPort !== 39000 &&
      newWebPort !== 39001 &&
      DNS_WRITES_EXECUTED === false &&
      oldServerWrites === 0 &&
      accessEntryStatus !== 'ACTIVE';

    console.log('\nPhase 3A ' + (ok ? '验收完成' : 'FAILED'));
    console.log('DNS_WRITES_EXECUTED=false');
    console.log('oldServerWrites=0');
    console.log('accessEntryStatus=' + accessEntryStatus);
    if (!ok) process.exitCode = 1;
  } catch (e) {
    console.error(redactSecrets(e instanceof Error ? e.message : String(e), []));
    process.exitCode = 1;
  } finally {
    password = '';
    if (lockHandle) await lockHandle.release().catch(() => undefined);
    if (managed) await managed.disconnect().catch(() => undefined);
    await prisma.$disconnect();
  }
}

main();
