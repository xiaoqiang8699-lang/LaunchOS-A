/**
 * Step 29 Phase 2 — Public Entry Gate Unlock.
 *
 * Default / unsafe confirm without gate-only: refused.
 *
 * Allowed this round:
 *   node scripts/step-29-public-entry-phase2-gate.mjs --confirm-public-entry --gate-only
 *
 * Forbidden: real install/write/DNS/cert/deploy apply (Phase 3).
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
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
const GATE_ONLY = process.argv.includes('--gate-only');
const OLD_HOST = '8.138.113.134';

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const requireDomain = createRequire(resolve(root, 'packages/domain/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const {
  decryptCredential,
  resolveServerSshUsername,
  redactSecrets,
  shellCommand,
  tryAcquireRedisLock,
} = requireApi('@launchos/shared');
const {
  STEP29_GATEWAY_WHITELIST,
  assertGatewayTarget,
  generateGatewayConfig,
  certificateCoversHostname,
  NginxGatewayProvider,
  classifyPublicEntryPortBlocker,
  resolveCertificateMaterialFacts,
  certificateMaterialBlocker,
  planCertificateInstall,
  planDnsARecord,
  detectActualWebApiEnvUsage,
  publicEntryLockKey,
  PUBLIC_ENTRY_EXECUTION_STEPS,
  AlibabaCloudDnsProvider,
  DEFAULT_WILDCARD_CERT_DIR,
} = requireDomain('@launchos/domain');
const { RemoteRunner } = requireApi('@launchos/remote-runner');

function decryptProviderSecrets(payload) {
  const raw = decryptCredential(payload);
  const parsed = JSON.parse(raw);
  if (typeof parsed.accessKey === 'string' && typeof parsed.secretKey === 'string') {
    return { accessKey: parsed.accessKey.trim(), secretKey: parsed.secretKey.trim() };
  }
  throw new Error('Encrypted credential is missing accessKey or secretKey');
}

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
    const r = await runner.execute(cmd, { timeoutMs: 30_000 });
    return {
      exitCode: r.exitCode,
      stdout: (r.stdout || '').trim(),
      stderr: (r.stderr || '').trim().slice(0, 800),
    };
  } catch (e) {
    return {
      exitCode: -1,
      stdout: '',
      stderr: e instanceof Error ? e.message : String(e),
    };
  }
}

async function main() {
  const WRITE_COMMANDS_EXECUTED_THIS_RUN = false;
  const DEPLOYMENT_ENQUEUED = false;
  const DNS_WRITES_EXECUTED = false;
  const GATEWAY_WRITES_EXECUTED = false;
  const CERTIFICATE_WRITES_EXECUTED = false;

  if (!CONFIRM) {
    console.log(
      JSON.stringify(
        {
          refused: true,
          reason: 'Phase 2 gate requires --confirm-public-entry --gate-only',
          WRITE_COMMANDS_EXECUTED_THIS_RUN: false,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }

  if (CONFIRM && !GATE_ONLY) {
    console.log(
      JSON.stringify(
        {
          refused: true,
          reason:
            'Phase 2 refuses real --confirm-public-entry without --gate-only (Phase 3 locked)',
          WRITE_COMMANDS_EXECUTED_THIS_RUN: false,
          DNS_WRITES_EXECUTED: false,
          GATEWAY_WRITES_EXECUTED: false,
          CERTIFICATE_WRITES_EXECUTED: false,
          DEPLOYMENT_ENQUEUED: false,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaClient();
  const wl = STEP29_GATEWAY_WHITELIST;
  const blockers = [];
  let password = '';
  let sourcePassword = '';

  try {
    const [server, apiSi, webSi, webUnit, sys, dnsAccounts, analysis] = await Promise.all([
      prisma.serverInstance.findUnique({ where: { id: wl.serverInstanceId } }),
      prisma.serviceInstance.findUnique({
        where: { id: wl.api.serviceInstanceId },
        select: {
          id: true,
          status: true,
          healthStatus: true,
          externalPort: true,
          port: true,
          serverInstanceId: true,
        },
      }),
      prisma.serviceInstance.findUnique({
        where: { id: wl.web.serviceInstanceId },
        select: {
          id: true,
          status: true,
          healthStatus: true,
          externalPort: true,
          port: true,
          serverInstanceId: true,
        },
      }),
      prisma.deployableUnit.findUnique({
        where: { id: wl.web.unitId },
        select: { id: true, framework: true, type: true, rootPath: true },
      }),
      prisma.systemDomainConfig.findFirst({ orderBy: { createdAt: 'asc' } }),
      prisma.providerAccount.findMany({
        where: { provider: { type: 'ALIYUN_DNS' } },
        select: {
          id: true,
          status: true,
          credentialEncrypted: true,
          provider: { select: { type: true } },
        },
        take: 5,
      }),
      prisma.projectAnalysis.findFirst({
        where: { projectId: wl.projectId },
        orderBy: { createdAt: 'desc' },
        select: { repositoryPath: true },
      }),
    ]);

    if (!server || server.host !== wl.publicIp) {
      blockers.push({ code: 'SERVER_FORBIDDEN', message: 'managed server mismatch' });
    }
    if (server?.host === OLD_HOST) {
      blockers.push({ code: 'OLD_SERVER_FORBIDDEN', message: 'old server forbidden' });
    }

    const meta =
      server?.metadata && typeof server.metadata === 'object' && !Array.isArray(server.metadata)
        ? server.metadata
        : {};
    const aptGetAvailable = Boolean(meta.hostTools?.aptGet?.available);
    const packageManager = aptGetAvailable
      ? 'apt-get'
      : meta.selectedPackageManager || meta.packageFamily === 'debian'
        ? 'apt-get'
        : null;
    const securityGroupReady =
      meta.firewallStatus === 'PROVIDER_SECURITY_GROUP_ONLY' || Boolean(meta.cloudResourceId);

    const apiRuntimePort = apiSi?.externalPort ?? apiSi?.port ?? wl.api.targetPort;
    const webRuntimePort = webSi?.externalPort ?? webSi?.port ?? wl.web.targetPort;
    const apiHealth = apiSi?.healthStatus || null;
    const webHealth = webSi?.healthStatus || null;

    const apiRouteCheck = assertGatewayTarget({
      targetHost: '127.0.0.1',
      targetPort: apiRuntimePort,
      hostname: wl.api.hostname,
      healthPath: wl.api.healthPath,
    });
    const webRouteCheck = assertGatewayTarget({
      targetHost: '127.0.0.1',
      targetPort: webRuntimePort,
      hostname: wl.web.hostname,
      healthPath: wl.web.healthPath,
    });
    if (!apiRouteCheck.ok) {
      blockers.push({ code: apiRouteCheck.code, message: apiRouteCheck.message });
    }
    if (!webRouteCheck.ok) {
      blockers.push({ code: webRouteCheck.code, message: webRouteCheck.message });
    }

    // Generate configs (in-memory only)
    generateGatewayConfig({
      hostname: wl.api.hostname,
      targetHost: '127.0.0.1',
      targetPort: apiRuntimePort,
      healthPath: wl.api.healthPath,
    });
    generateGatewayConfig({
      hostname: wl.web.hostname,
      targetHost: '127.0.0.1',
      targetPort: webRuntimePort,
      healthPath: wl.web.healthPath,
    });

    const provider = new NginxGatewayProvider();
    let nginxBinaryPath = null;
    let nginxVersion = null;
    let nginxRunning = false;
    let listeningPorts = [];
    let presentOnTarget = false;
    let presentOnSourceHost = false;
    let sourceHost = sys?.gatewayPublicIp || OLD_HOST;
    const sourcePathHint = sys?.tlsCertPathHint || DEFAULT_WILDCARD_CERT_DIR;

    if (server?.credentialEncrypted) {
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
      try {
        const probe = await soft(
          runner,
          shellCommand(
            [
              'set +e',
              'if [ -x /usr/sbin/nginx ]; then echo BIN=/usr/sbin/nginx; /usr/sbin/nginx -v 2>&1; fi',
              'if command -v nginx >/dev/null 2>&1; then echo BIN=$(command -v nginx); nginx -v 2>&1; fi',
              'ps -ef 2>/dev/null | grep -E "[n]ginx:" | head -n 3 || true',
              'ss -lntp 2>/dev/null | awk \'{print $4}\' || true',
              'if ls /opt/launchos/gateway/certificates/*/fullchain.pem >/dev/null 2>&1 && ls /opt/launchos/gateway/certificates/*/privkey.pem >/dev/null 2>&1; then echo TARGET_CERT_PRESENT; fi',
              `if [ -f ${DEFAULT_WILDCARD_CERT_DIR}/fullchain.pem ] && [ -f ${DEFAULT_WILDCARD_CERT_DIR}/privkey.pem ]; then echo TARGET_CERT_PRESENT; fi`,
              'true',
            ].join('; '),
          ),
        );
        const out = `${probe.stdout}\n${probe.stderr}`;
        const bin = out.match(/BIN=(\S+)/);
        nginxBinaryPath = bin?.[1] || null;
        const ver = out.match(/nginx\/([\d.]+)/i);
        nginxVersion = ver?.[1] || null;
        nginxRunning = /nginx:/i.test(out);
        presentOnTarget = /TARGET_CERT_PRESENT/.test(out);
        for (const line of out.split(/\r?\n/)) {
          const m = line.trim().match(/[:.](\d+)$/);
          if (m) listeningPorts.push(Number(m[1]));
        }
        listeningPorts = [...new Set(listeningPorts)];
      } finally {
        await runner.disconnect().catch(() => undefined);
      }
    }

    // Source cert material on existing gateway host (read-only existence check)
    if (sys?.gatewayServerId) {
      const sourceServer = await prisma.serverInstance.findUnique({
        where: { id: sys.gatewayServerId },
      });
      if (sourceServer?.credentialEncrypted && sourceServer.host) {
        sourceHost = sourceServer.host;
        try {
          sourcePassword = decryptCredential(sourceServer.credentialEncrypted);
          const sourceUser = resolveServerSshUsername({
            serverUsername: sourceServer.username,
            provider: sourceServer.provider,
          });
          const runner = new RemoteRunner();
          await runner.connect({
            host: sourceServer.host,
            port: sourceServer.port || 22,
            username: sourceUser,
            password: sourcePassword,
            readyTimeoutMs: 20_000,
          });
          try {
            const probe = await soft(
              runner,
              shellCommand(
                `if [ -f ${sourcePathHint}/fullchain.pem ] && [ -f ${sourcePathHint}/privkey.pem ]; then echo SOURCE_CERT_PRESENT; ls -l ${sourcePathHint}/fullchain.pem | awk '{print $5}'; else echo SOURCE_CERT_MISSING; fi`,
              ),
            );
            presentOnSourceHost = /SOURCE_CERT_PRESENT/.test(probe.stdout || '');
          } finally {
            await runner.disconnect().catch(() => undefined);
          }
        } catch {
          presentOnSourceHost = false;
        }
      }
    }

    const detect = provider.detectFromFacts({
      nginxBinaryPath,
      nginxVersion,
      nginxRunning,
      aptGetAvailable: aptGetAvailable || packageManager === 'apt-get',
      listeningPorts,
    });
    const installPlan = provider.planInstall(detect);
    const gatewayInstallSupported = detect.packageManagerSupported;

    const listenerBlocker = classifyPublicEntryPortBlocker({
      securityGroupReady,
      listening80: detect.publicPortsListening.includes(80),
      listening443: detect.publicPortsListening.includes(443),
    });
    if (listenerBlocker.code) {
      blockers.push({
        code: listenerBlocker.code,
        message: '80/443 not listening yet — OS gateway listener pending, not SG mutation',
      });
    }

    const coversWeb = certificateCoversHostname({
      commonName: sys?.tlsCertificateDomain || '*.zsaos.com',
      sans: [sys?.tlsCertificateDomain || '*.zsaos.com'],
      hostname: wl.web.hostname,
    });
    const coversApi = certificateCoversHostname({
      commonName: sys?.tlsCertificateDomain || '*.zsaos.com',
      sans: [sys?.tlsCertificateDomain || '*.zsaos.com'],
      hostname: wl.api.hostname,
    });
    const certFacts = resolveCertificateMaterialFacts({
      certificateId: sys?.id || null,
      commonName: sys?.tlsCertificateDomain || null,
      expiresAt: sys?.tlsExpiresAt || null,
      coversApiHostname: coversApi,
      coversWebHostname: coversWeb,
      presentOnTarget,
      presentOnSourceHost,
      sourceHost,
      sourcePathHint,
    });
    const certBlocker = certificateMaterialBlocker(certFacts);
    if (certBlocker) blockers.push(certBlocker);
    const certInstallPlan = planCertificateInstall(certFacts);

    // DNS plans
    const dnsAccount =
      dnsAccounts.find((a) => a.status === 'VERIFIED' || a.status === 'ACTIVE') ||
      dnsAccounts[0] ||
      null;
    const dnsAccountReady = Boolean(
      dnsAccount && dnsAccount.provider.type === 'ALIYUN_DNS' && dnsAccount.credentialEncrypted,
    );
    if (!dnsAccountReady) {
      blockers.push({ code: 'DNS_ACCOUNT_NOT_READY', message: 'ALIYUN_DNS missing' });
    }

    let apiExisting = null;
    let webExisting = null;
    if (dnsAccountReady) {
      try {
        const secrets = decryptProviderSecrets(dnsAccount.credentialEncrypted);
        const dns = new AlibabaCloudDnsProvider(
          { accessKey: secrets.accessKey, secretKey: secrets.secretKey },
          wl.rootDomain,
        );
        const apiRr = wl.api.hostname.replace(`.${wl.rootDomain}`, '');
        const webRr = wl.web.hostname.replace(`.${wl.rootDomain}`, '');
        const apiRecs = await dns.findARecordsReadOnly(apiRr);
        const webRecs = await dns.findARecordsReadOnly(webRr);
        apiExisting = apiRecs[0]
          ? {
              rr: apiRecs[0].rr,
              type: apiRecs[0].type,
              value: apiRecs[0].value,
              recordId: apiRecs[0].recordId || null,
              managedByLaunchOS: false,
            }
          : null;
        webExisting = webRecs[0]
          ? {
              rr: webRecs[0].rr,
              type: webRecs[0].type,
              value: webRecs[0].value,
              recordId: webRecs[0].recordId || null,
              managedByLaunchOS: false,
            }
          : null;
      } catch (e) {
        blockers.push({
          code: 'DNS_READ_FAILED',
          message: e instanceof Error ? e.message.slice(0, 160) : 'dns read failed',
        });
      }
    }

    const apiDnsPlan = planDnsARecord({
      hostname: wl.api.hostname,
      rootDomain: wl.rootDomain,
      desiredIp: wl.publicIp,
      existing: apiExisting,
    });
    const webDnsPlan = planDnsARecord({
      hostname: wl.web.hostname,
      rootDomain: wl.rootDomain,
      desiredIp: wl.publicIp,
      existing: webExisting,
    });
    if (apiDnsPlan.action === 'DNS_RECORD_CONFLICT') {
      blockers.push({
        code: 'DNS_RECORD_CONFLICT',
        message: `API DNS conflict current=${apiDnsPlan.previousValue}`,
      });
    }
    if (webDnsPlan.action === 'DNS_RECORD_CONFLICT') {
      blockers.push({
        code: 'DNS_RECORD_CONFLICT',
        message: `Web DNS conflict current=${webDnsPlan.previousValue}`,
      });
    }

    // Web actual env usage from source
    const webFiles = [];
    if (analysis?.repositoryPath && webUnit?.rootPath != null) {
      const unitPath = join(
        analysis.repositoryPath,
        webUnit.rootPath && webUnit.rootPath !== '.' ? webUnit.rootPath : '',
      );
      for (const rel of ['main.js', 'main.ts', 'src/main.js', 'src/main.ts', 'index.js', 'App.jsx', 'App.tsx']) {
        const fp = join(unitPath, rel);
        if (existsSync(fp)) {
          webFiles.push({ path: rel, content: readFileSync(fp, 'utf8') });
        }
      }
    }
    const webReqs = await prisma.runtimeConfigRequirement.findMany({
      where: { deployableUnitId: wl.web.unitId },
      select: { key: true, injectionPhase: true },
    });
    const webApi = detectActualWebApiEnvUsage({
      framework: webUnit?.framework,
      plannedWebApiUrl: `https://${wl.api.hostname}`,
      requirementKeys: webReqs.map((r) => r.key),
      files: webFiles,
    });

    // Public entry lock readiness (acquire+release immediately for gate-only)
    const lockKey = publicEntryLockKey(wl.projectId, wl.serverInstanceId);
    let publicEntryLockReady = false;
    try {
      const handle = await tryAcquireRedisLock(lockKey, 5_000);
      if (handle) {
        publicEntryLockReady = true;
        await handle.release().catch(() => undefined);
      } else {
        blockers.push({
          code: 'PUBLIC_ENTRY_LOCK_BUSY',
          message: `lock busy: ${lockKey}`,
        });
      }
    } catch {
      blockers.push({ code: 'PUBLIC_ENTRY_LOCK_UNAVAILABLE', message: 'redis lock unavailable' });
    }

    if (detect.installRequired && !gatewayInstallSupported) {
      blockers.push({
        code: 'GATEWAY_INSTALL_UNSUPPORTED_PACKAGE_MANAGER',
        message: 'apt-get required for nginx install on Deb Edition',
      });
    }

    const dynProbes = [];
    for (const port of [apiRuntimePort, webRuntimePort]) {
      dynProbes.push(await tcpProbe(wl.publicIp, port));
    }
    const dynamicPortsRemainPrivate = !dynProbes.some((p) => p.status === 'open');

    const hardBlockers = blockers.filter((b) =>
      [
        'SERVER_FORBIDDEN',
        'OLD_SERVER_FORBIDDEN',
        'CERTIFICATE_MATERIAL_UNAVAILABLE',
        'DNS_ACCOUNT_NOT_READY',
        'DNS_RECORD_CONFLICT',
        'GATEWAY_INSTALL_UNSUPPORTED_PACKAGE_MANAGER',
        'PUBLIC_ENTRY_LOCK_BUSY',
        'PUBLIC_ENTRY_LOCK_UNAVAILABLE',
      ].includes(b.code),
    );

    const canApplyPublicEntry =
      apiRouteCheck.ok &&
      webRouteCheck.ok &&
      dnsAccountReady &&
      certFacts.certificateMaterialAvailable &&
      gatewayInstallSupported &&
      publicEntryLockReady &&
      hardBlockers.length === 0;

    const report = {
      step: 'Step 29 Phase 2 Public Entry Gate Unlock',
      phase2ConfirmPathEnabled: true,
      projectId: wl.projectId,
      serverInstanceId: wl.serverInstanceId,
      publicIp: wl.publicIp,
      apiServiceInstance: apiSi?.id || null,
      apiRuntimePort,
      apiHealth,
      apiStatus: apiSi?.status || null,
      webServiceInstance: webSi?.id || null,
      webRuntimePort,
      webHealth,
      webStatus: webSi?.status || null,
      gatewayProvider: 'NGINX',
      gatewayInstalled: detect.installed,
      gatewayRunning: detect.running,
      gatewayInstallRequired: detect.installRequired,
      gatewayInstallSupported,
      packageManager: detect.packageManager || packageManager,
      gatewayInstallPlanSafe: installPlan
        ? {
            packageName: installPlan.packageName,
            packageManager: installPlan.packageManager,
            publicPorts: installPlan.publicPorts,
            dynamicRuntimePortsPrivate: installPlan.dynamicRuntimePortsPrivate,
          }
        : null,
      securityGroupReady,
      securityGroupChangeRequired: false,
      certificateId: certFacts.certificateId,
      certificateValid: certFacts.certificateValid,
      certificateMaterialAvailable: certFacts.certificateMaterialAvailable,
      certificateInstallRequired: certFacts.certificateInstallRequired,
      certificateSource: certFacts.source,
      certificateSourceHost: certFacts.sourceHost,
      coversApiHostname: certFacts.coversApiHostname,
      coversWebHostname: certFacts.coversWebHostname,
      certificateFingerprint: certFacts.certificateFingerprint,
      certificateInstallPlanSafe: certInstallPlan
        ? {
            sourceHost: certInstallPlan.sourceHost,
            targetDir: certInstallPlan.targetDir,
            auditSafeNote: certInstallPlan.auditSafeNote,
          }
        : null,
      apiHostname: wl.api.hostname,
      apiTarget: { host: '127.0.0.1', port: apiRuntimePort, healthPath: wl.api.healthPath },
      apiRouteValid: apiRouteCheck.ok,
      webHostname: wl.web.hostname,
      webTarget: { host: '127.0.0.1', port: webRuntimePort, healthPath: wl.web.healthPath },
      webRouteValid: webRouteCheck.ok,
      dnsProvider: 'ALIYUN_DNS',
      dnsAccountReady,
      dnsAccountId: dnsAccount?.id || null,
      apiDnsCurrent: apiDnsPlan.current,
      apiDnsDesired: apiDnsPlan.desiredValue,
      apiDnsAction: apiDnsPlan.action,
      webDnsCurrent: webDnsPlan.current,
      webDnsDesired: webDnsPlan.desiredValue,
      webDnsAction: webDnsPlan.action,
      webApiConfigMode: webApi.webApiConfigMode,
      actualWebApiEnvKey: webApi.actualWebApiEnvKey,
      actualWebApiEnvUsage: webApi.actualWebApiEnvUsage,
      webRebuildRequired: webApi.webRebuildRequired,
      plannedWebApiUrl: webApi.plannedWebApiUrl,
      publicConfigOnly: true,
      dynamicPortsRemainPrivate,
      publicEntryLockReady,
      publicEntryLockKey: lockKey,
      executionOrder: PUBLIC_ENTRY_EXECUTION_STEPS,
      accessEntryStatus: 'ACCESS_ENTRY_PENDING',
      canApplyPublicEntry,
      blockers,
      DEPLOYMENT_ENQUEUED,
      DNS_WRITES_EXECUTED,
      GATEWAY_WRITES_EXECUTED,
      CERTIFICATE_WRITES_EXECUTED,
      WRITE_COMMANDS_EXECUTED_THIS_RUN,
      oldServerUntouched: true,
      note: 'gate-only — no external writes',
    };

    console.log(redactSecrets(JSON.stringify(report, null, 2), []));
    console.log('\nCONFIRM_PATH_FIXTURE complete (gate-only).');
    console.log('wouldApplyPublicEntry=' + canApplyPublicEntry);
    console.log('DEPLOYMENT_ENQUEUED=false');
    console.log('DNS_WRITES_EXECUTED=false');
    console.log('GATEWAY_WRITES_EXECUTED=false');
    console.log('CERTIFICATE_WRITES_EXECUTED=false');
    console.log('WRITE_COMMANDS_EXECUTED_THIS_RUN=false');
    console.log('oldServerUntouched=true');
  } finally {
    password = '';
    sourcePassword = '';
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(redactSecrets(e instanceof Error ? e.message : String(e), []));
  process.exitCode = 1;
});
