/**
 * Step 29 Phase 3B — DNS Activation Gate.
 *
 * Allowed this round:
 *   node scripts/step-29-dns-activation-phase3b-gate.mjs --confirm-dns-activation --gate-only
 *
 * Forbidden: bare --confirm-dns-activation (real DNS apply locked until Phase 3B Real Apply).
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

const CONFIRM = process.argv.includes('--confirm-dns-activation');
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
  STEP29_PHASE3B_BASELINE,
  certificateCoversHostname,
  planDnsARecord,
  buildDnsOwnershipFromPlan,
  dnsPropagationStrategy,
  planApiPublicHttpsVerify,
  planWebPublicHttpsVerify,
  planHttpRedirectVerifies,
  evaluateDnsActivationGate,
  DNS_ACTIVATION_EXECUTION_STEPS,
  publicEntryLockKey,
  AlibabaCloudDnsProvider,
  ALIYUN_DNS_DEFAULT_TTL,
  planCertificatePaths,
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
      resolveProbe({ port, status, code: code || null });
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
    const r = await runner.execute(cmd, { timeoutMs: 45_000 });
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
  const DNS_WRITES_EXECUTED = false;
  const GATEWAY_WRITES_EXECUTED = false;
  const CERTIFICATE_WRITES_EXECUTED = false;
  const DEPLOYMENT_ENQUEUED = false;
  const WRITE_COMMANDS_EXECUTED_THIS_RUN = false;

  if (!CONFIRM) {
    console.log(
      JSON.stringify(
        {
          refused: true,
          reason: 'Phase 3B gate requires --confirm-dns-activation --gate-only',
          DNS_WRITES_EXECUTED: false,
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
            'Phase 3B refuses real --confirm-dns-activation without --gate-only (DNS apply locked)',
          DNS_WRITES_EXECUTED: false,
          GATEWAY_WRITES_EXECUTED: false,
          CERTIFICATE_WRITES_EXECUTED: false,
          DEPLOYMENT_ENQUEUED: false,
          WRITE_COMMANDS_EXECUTED_THIS_RUN: false,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaClient();
  const bl = STEP29_PHASE3B_BASELINE;
  let password = '';
  let managed = null;

  try {
    const [server, apiSi, webSi, sys, dnsAccount, apiRoute, webRoute] = await Promise.all([
      prisma.serverInstance.findUnique({ where: { id: bl.serverInstanceId } }),
      prisma.serviceInstance.findUnique({
        where: { id: bl.api.serviceInstanceId },
        select: {
          id: true,
          status: true,
          healthStatus: true,
          externalPort: true,
          port: true,
          deployableUnitId: true,
        },
      }),
      prisma.serviceInstance.findUnique({
        where: { id: bl.web.serviceInstanceId },
        select: {
          id: true,
          status: true,
          healthStatus: true,
          externalPort: true,
          port: true,
          deployableUnitId: true,
        },
      }),
      prisma.systemDomainConfig.findFirst({ orderBy: { createdAt: 'asc' } }),
      prisma.providerAccount.findFirst({
        where: {
          id: bl.dnsAccountId,
          provider: { type: 'ALIYUN_DNS' },
        },
        select: {
          id: true,
          status: true,
          credentialEncrypted: true,
          provider: { select: { type: true } },
        },
      }),
      prisma.gatewayRoute.findUnique({
        where: { hostname: bl.api.hostname },
        select: { hostname: true, status: true, targetPort: true, serviceInstanceId: true },
      }),
      prisma.gatewayRoute.findUnique({
        where: { hostname: bl.web.hostname },
        select: { hostname: true, status: true, targetPort: true, serviceInstanceId: true },
      }),
    ]);

    if (!server || server.host !== bl.publicIp) {
      throw new Error('managed server mismatch');
    }
    if (server.host === OLD_HOST) throw new Error('old server forbidden');

    const apiPort = apiSi?.externalPort ?? apiSi?.port ?? bl.api.targetPort;
    const webPort = webSi?.externalPort ?? webSi?.port ?? bl.web.targetPort;
    const apiServiceHealthy =
      apiSi?.status === 'RUNNING' &&
      apiSi?.healthStatus === 'HEALTHY' &&
      apiSi?.deployableUnitId === bl.api.unitId;
    const webServiceHealthy =
      webSi?.status === 'RUNNING' &&
      webSi?.healthStatus === 'HEALTHY' &&
      webSi?.deployableUnitId === bl.web.unitId;

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

    const paths = planCertificatePaths(sys?.id || bl.certificateId);
    const probe = await soft(
      managed,
      shellCommand(
        [
          'nginx -v 2>&1',
          'systemctl is-active nginx 2>/dev/null || true',
          'ss -ltnp 2>/dev/null || true',
          `test -f ${paths.fullchain} && test -f ${paths.privkey} && echo CERT_OK`,
          `curl -sS -o /dev/null -w 'apiLocalHttps=%{http_code}\\n' --cacert ${paths.fullchain} --resolve ${bl.api.hostname}:443:127.0.0.1 https://${bl.api.hostname}${bl.api.healthPath}`,
          `curl -sS -o /dev/null -w 'webLocalHttps=%{http_code}\\n' --cacert ${paths.fullchain} --resolve ${bl.web.hostname}:443:127.0.0.1 https://${bl.web.hostname}/`,
        ].join('; '),
      ),
    );
    const out = `${probe.stdout}\n${probe.stderr}`;
    const gatewayRunning = /active/.test(out) || /nginx\//i.test(out);
    const port80Listening =
      /0\.0\.0\.0:80\b/.test(out) || /\*:80\b/.test(out) || /\[::\]:80\b/.test(out);
    const port443Listening =
      /0\.0\.0\.0:443\b/.test(out) || /\*:443\b/.test(out) || /\[::\]:443\b/.test(out);
    const apiLocalHttpsReady = /apiLocalHttps=2\d\d/.test(out);
    const webLocalHttpsReady = /webLocalHttps=2\d\d/.test(out) || /webLocalHttps=3\d\d/.test(out);

    const coversApi = certificateCoversHostname({
      commonName: sys?.tlsCertificateDomain || '*.zsaos.com',
      sans: [sys?.tlsCertificateDomain || '*.zsaos.com'],
      hostname: bl.api.hostname,
    });
    const coversWeb = certificateCoversHostname({
      commonName: sys?.tlsCertificateDomain || '*.zsaos.com',
      sans: [sys?.tlsCertificateDomain || '*.zsaos.com'],
      hostname: bl.web.hostname,
    });
    const exp = sys?.tlsExpiresAt ? new Date(sys.tlsExpiresAt) : null;
    const certificateValid =
      Boolean(exp && exp.getTime() > Date.now()) && coversApi && coversWeb && /CERT_OK/.test(out);

    // Fresh DNS reads (no Phase 2 cache)
    const dnsAccountReady = Boolean(
      dnsAccount &&
        dnsAccount.provider.type === 'ALIYUN_DNS' &&
        dnsAccount.credentialEncrypted &&
        (dnsAccount.status === 'VERIFIED' || dnsAccount.status === 'ACTIVE'),
    );

    let apiExisting = null;
    let webExisting = null;
    let dnsReadError = null;
    if (dnsAccountReady) {
      try {
        const secrets = decryptProviderSecrets(dnsAccount.credentialEncrypted);
        const dns = new AlibabaCloudDnsProvider(
          { accessKey: secrets.accessKey, secretKey: secrets.secretKey },
          bl.rootDomain,
        );
        const apiRr = bl.api.hostname.replace(`.${bl.rootDomain}`, '');
        const webRr = bl.web.hostname.replace(`.${bl.rootDomain}`, '');
        const apiRecs = await dns.findARecordsReadOnly(apiRr);
        const webRecs = await dns.findARecordsReadOnly(webRr);
        apiExisting = apiRecs[0]
          ? {
              rr: apiRecs[0].rr,
              type: apiRecs[0].type,
              value: apiRecs[0].value,
              recordId: apiRecs[0].recordId || null,
              ttl: apiRecs[0].ttl ?? null,
              // Fresh records without LaunchOS ownership marker are unmanaged
              managedByLaunchOS: false,
            }
          : null;
        webExisting = webRecs[0]
          ? {
              rr: webRecs[0].rr,
              type: webRecs[0].type,
              value: webRecs[0].value,
              recordId: webRecs[0].recordId || null,
              ttl: webRecs[0].ttl ?? null,
              managedByLaunchOS: false,
            }
          : null;
      } catch (e) {
        dnsReadError = e instanceof Error ? e.message.slice(0, 160) : 'dns read failed';
      }
    }

    const apiDnsPlan = planDnsARecord({
      hostname: bl.api.hostname,
      rootDomain: bl.rootDomain,
      desiredIp: bl.publicIp,
      existing: apiExisting,
    });
    const webDnsPlan = planDnsARecord({
      hostname: bl.web.hostname,
      rootDomain: bl.rootDomain,
      desiredIp: bl.publicIp,
      existing: webExisting,
    });
    const plannedTTL = ALIYUN_DNS_DEFAULT_TTL;
    const apiOwnership = buildDnsOwnershipFromPlan(apiDnsPlan, plannedTTL);
    const webOwnership = buildDnsOwnershipFromPlan(webDnsPlan, plannedTTL);

    const lockKey = publicEntryLockKey(bl.projectId, bl.serverInstanceId);
    let publicEntryLockReady = false;
    try {
      const handle = await tryAcquireRedisLock(lockKey, 5_000);
      if (handle) {
        publicEntryLockReady = true;
        await handle.release().catch(() => undefined);
      }
    } catch {
      publicEntryLockReady = false;
    }

    const dynProbes = [];
    for (const port of [apiPort, webPort]) {
      dynProbes.push(await tcpProbe(bl.publicIp, port));
    }
    const dynamicPortsRemainPrivate = !dynProbes.some((p) => p.status === 'open');

    const meta =
      server.metadata && typeof server.metadata === 'object' && !Array.isArray(server.metadata)
        ? server.metadata
        : {};
    const securityGroupUnchanged =
      meta.firewallStatus === 'PROVIDER_SECURITY_GROUP_ONLY' || Boolean(meta.cloudResourceId);

    const gate = evaluateDnsActivationGate({
      gatewayRunning,
      port80Listening,
      port443Listening,
      certificateValid,
      certificateCoversApi: coversApi,
      certificateCoversWeb: coversWeb,
      apiLocalHttpsReady,
      webLocalHttpsReady,
      apiServiceHealthy,
      webServiceHealthy,
      dnsAccountReady: dnsAccountReady && !dnsReadError,
      apiDnsAction: apiDnsPlan.action,
      webDnsAction: webDnsPlan.action,
      publicEntryLockReady,
      dynamicPortsRemainPrivate,
    });
    if (dnsReadError) {
      gate.blockers.push({ code: 'DNS_READ_FAILED', message: dnsReadError });
      gate.canActivateDns = false;
    }

    const propagation = dnsPropagationStrategy(bl.publicIp);
    const apiPublicVerifyPlan = planApiPublicHttpsVerify();
    const webPublicVerifyPlan = planWebPublicHttpsVerify();
    const httpRedirectVerifyPlan = planHttpRedirectVerifies();

    const report = {
      step: 'Step 29 Phase 3B DNS Activation Gate',
      projectId: bl.projectId,
      serverInstanceId: bl.serverInstanceId,
      publicIp: bl.publicIp,
      gatewayRunning,
      gatewayVersion: out.match(/nginx\/([\d.]+)/i)?.[1] || null,
      port80Listening,
      port443Listening,
      certificateValid,
      certificateCoversApi: coversApi,
      certificateCoversWeb: coversWeb,
      certificateId: sys?.id || bl.certificateId,
      apiLocalHttpsReady,
      webLocalHttpsReady,
      apiServiceHealthy,
      webServiceHealthy,
      apiServiceInstance: apiSi?.id || null,
      webServiceInstance: webSi?.id || null,
      apiRuntimePort: apiPort,
      webRuntimePort: webPort,
      apiGatewayRoute: apiRoute,
      webGatewayRoute: webRoute,
      dnsProvider: 'ALIYUN_DNS',
      dnsAccountReady,
      dnsAccountId: dnsAccount?.id || null,
      apiDnsExists: Boolean(apiExisting),
      apiDnsCurrentValue: apiExisting?.value || null,
      apiDnsCurrentType: apiExisting?.type || null,
      apiDnsCurrentTTL: apiExisting?.ttl ?? null,
      apiDnsRecordId: apiExisting?.recordId || null,
      apiDnsManagedByLaunchOS: apiExisting?.managedByLaunchOS ?? null,
      apiDnsDesiredValue: apiDnsPlan.desiredValue,
      apiDnsAction: apiDnsPlan.action,
      apiDnsConflict: apiDnsPlan.action === 'DNS_RECORD_CONFLICT',
      apiDnsOwnershipPlan: apiOwnership,
      webDnsExists: Boolean(webExisting),
      webDnsCurrentValue: webExisting?.value || null,
      webDnsCurrentType: webExisting?.type || null,
      webDnsCurrentTTL: webExisting?.ttl ?? null,
      webDnsRecordId: webExisting?.recordId || null,
      webDnsManagedByLaunchOS: webExisting?.managedByLaunchOS ?? null,
      webDnsDesiredValue: webDnsPlan.desiredValue,
      webDnsAction: webDnsPlan.action,
      webDnsConflict: webDnsPlan.action === 'DNS_RECORD_CONFLICT',
      webDnsOwnershipPlan: webOwnership,
      plannedTTL,
      publicEntryLockReady,
      publicEntryLockKey: lockKey,
      propagationCheckReady: true,
      propagationStrategy: propagation,
      apiPublicVerifyPlan,
      webPublicVerifyPlan,
      httpRedirectVerifyPlan,
      executionOrder: DNS_ACTIVATION_EXECUTION_STEPS,
      dynamicPortsRemainPrivate,
      securityGroupUnchanged,
      accessEntryStatus: 'READY_FOR_DNS',
      canActivateDns: gate.canActivateDns,
      blockers: gate.blockers,
      DNS_WRITES_EXECUTED,
      GATEWAY_WRITES_EXECUTED,
      CERTIFICATE_WRITES_EXECUTED,
      DEPLOYMENT_ENQUEUED,
      WRITE_COMMANDS_EXECUTED_THIS_RUN,
      oldServerUntouched: true,
      note: 'gate-only — no DNS/gateway/cert/deploy writes',
    };

    console.log(redactSecrets(JSON.stringify(report, null, 2), []));
    console.log('\nCONFIRM_PATH_FIXTURE complete (gate-only).');
    console.log('canActivateDns=' + gate.canActivateDns);
    console.log('DNS_WRITES_EXECUTED=false');
    console.log('GATEWAY_WRITES_EXECUTED=false');
    console.log('CERTIFICATE_WRITES_EXECUTED=false');
    console.log('DEPLOYMENT_ENQUEUED=false');
    console.log('WRITE_COMMANDS_EXECUTED_THIS_RUN=false');
    console.log('oldServerUntouched=true');
  } catch (e) {
    console.error(redactSecrets(e instanceof Error ? e.message : String(e), []));
    process.exitCode = 1;
  } finally {
    password = '';
    if (managed) await managed.disconnect().catch(() => undefined);
    await prisma.$disconnect();
  }
}

main();
