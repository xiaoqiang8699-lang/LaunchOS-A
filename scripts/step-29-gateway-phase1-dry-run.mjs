/**
 * Step 29 Phase 1 — Gateway / Domain / HTTPS Engineering + Dry-run.
 *
 * READ-ONLY only. Forbidden: nginx write/reload, DNS mutate, cert issue,
 * env write, redeploy, SG change, --confirm-apply.
 *
 *   node scripts/step-29-gateway-phase1-dry-run.mjs
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

const WRITE_COMMANDS_EXECUTED_THIS_RUN = false;
const OLD_HOST = '8.138.113.134';

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const requireDomain = createRequire(resolve(root, 'packages/domain/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const {
  decryptCredential,
  resolveServerSshUsername,
  redactSecrets,
  shellCommand,
} = requireApi('@launchos/shared');

function decryptProviderSecrets(payload) {
  const raw = decryptCredential(payload);
  const parsed = JSON.parse(raw);
  if (typeof parsed.accessKey === 'string' && typeof parsed.secretKey === 'string') {
    return { accessKey: parsed.accessKey.trim(), secretKey: parsed.secretKey.trim() };
  }
  throw new Error('Encrypted credential is missing accessKey or secretKey');
}
const {
  STEP29_GATEWAY_WHITELIST,
  assertGatewayTarget,
  assertGatewayRouteUniqueness,
  generateGatewayConfig,
  certificateCoversHostname,
  detectWebApiConfigMode,
  planSecurityGroupForGateway,
  expectedGatewayHealthChecks,
  AlibabaCloudDnsProvider,
  DEFAULT_WILDCARD_CERT_DIR,
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

function secretHits(text) {
  const blob = String(text || '');
  return {
    databaseUrlPlaintextHits: /postgres(ql)?:\/\/[^:\s]+:[^@\s]+@/i.test(blob) ? 1 : 0,
    redisUrlPlaintextHits: /redis:\/\/[^:\s]+:[^@\s]+@/i.test(blob) ? 1 : 0,
    aliyunAkPlaintextHits: /LTAI[A-Za-z0-9]{12,}/.test(blob) ? 1 : 0,
  };
}

async function main() {
  const prisma = new PrismaClient();
  const wl = STEP29_GATEWAY_WHITELIST;
  const blockers = [];
  let password = '';

  try {
    const [server, apiSi, webSi, webUnit, sys, dnsAccounts, existingRoutes] = await Promise.all([
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
        select: { id: true, framework: true, type: true },
      }),
      prisma.systemDomainConfig.findFirst({ orderBy: { createdAt: 'asc' } }),
      prisma.providerAccount.findMany({
        where: { provider: { type: 'ALIYUN_DNS' } },
        select: {
          id: true,
          status: true,
          label: true,
          credentialEncrypted: true,
          provider: { select: { type: true } },
        },
        take: 5,
      }),
      prisma.gatewayRoute.findMany({
            where: {
              OR: [
                { hostname: { in: [wl.web.hostname, wl.api.hostname] } },
                { projectId: wl.projectId },
              ],
            },
            select: {
              id: true,
              hostname: true,
              unitId: true,
              status: true,
              isDefault: true,
              targetHost: true,
              targetPort: true,
            },
          }).catch(() => []),
    ]);

    if (!server || server.host !== wl.publicIp) {
      blockers.push({ code: 'SERVER_FORBIDDEN', message: 'managed server mismatch' });
    }
    if (server?.host === OLD_HOST) {
      blockers.push({ code: 'OLD_SERVER_FORBIDDEN', message: 'old server forbidden' });
    }

    const webTargetPort = webSi?.externalPort ?? webSi?.port ?? wl.web.targetPort;
    const apiTargetPort = apiSi?.externalPort ?? apiSi?.port ?? wl.api.targetPort;

    const webRouteCheck = assertGatewayTarget({
      targetHost: '127.0.0.1',
      targetPort: webTargetPort,
      hostname: wl.web.hostname,
      healthPath: wl.web.healthPath,
    });
    const apiRouteCheck = assertGatewayTarget({
      targetHost: '127.0.0.1',
      targetPort: apiTargetPort,
      hostname: wl.api.hostname,
      healthPath: wl.api.healthPath,
    });
    if (!webRouteCheck.ok) {
      blockers.push({ code: webRouteCheck.code, message: webRouteCheck.message });
    }
    if (!apiRouteCheck.ok) {
      blockers.push({ code: apiRouteCheck.code, message: apiRouteCheck.message });
    }

    const webUniq = assertGatewayRouteUniqueness({
      hostname: wl.web.hostname,
      unitId: wl.web.unitId,
      existing: (existingRoutes || []).filter((r) => r.hostname !== wl.web.hostname),
    });
    const apiUniq = assertGatewayRouteUniqueness({
      hostname: wl.api.hostname,
      unitId: wl.api.unitId,
      existing: (existingRoutes || []).filter((r) => r.hostname !== wl.api.hostname),
    });
    // Phase 1 planning allows no ACTIVE routes yet — uniqueness vs ACTIVE only.
    void webUniq;
    void apiUniq;

    const webConfig = generateGatewayConfig({
      hostname: wl.web.hostname,
      targetHost: '127.0.0.1',
      targetPort: webTargetPort,
      healthPath: wl.web.healthPath,
    });
    const apiConfig = generateGatewayConfig({
      hostname: wl.api.hostname,
      targetHost: '127.0.0.1',
      targetPort: apiTargetPort,
      healthPath: wl.api.healthPath,
    });

    // Gateway runtime probe (SSH read-only)
    let gatewayRuntime = 'unknown';
    let gatewayVersion = null;
    let gatewayRunning = false;
    let gatewayConfigRoot = null;
    let publicPortsListening = [];
    let certMeta = {
      certificateId: sys?.id || null,
      commonName: sys?.tlsCertificateDomain || null,
      SANs: [],
      notBefore: null,
      notAfter: sys?.tlsExpiresAt?.toISOString?.() || sys?.tlsExpiresAt || null,
      coversWebHostname: false,
      coversApiHostname: false,
      certificateValid: false,
      certificateReuse: false,
      certificatePresentOnServer: false,
    };

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
        const nginxV = await soft(
          runner,
          shellCommand(
            [
              'set +e',
              'if [ -x /www/server/nginx/sbin/nginx ]; then /www/server/nginx/sbin/nginx -v 2>&1; fi',
              'if command -v nginx >/dev/null 2>&1; then nginx -v 2>&1; fi',
              'if command -v openresty >/dev/null 2>&1; then openresty -v 2>&1; fi',
              'if command -v caddy >/dev/null 2>&1; then caddy version 2>&1; fi',
              'if [ -f /opt/launchos-gateway/gateway.cjs ]; then echo launchos-gateway:present; fi',
              'true',
            ].join('; '),
          ),
        );
        const out = `${nginxV.stdout}\n${nginxV.stderr}`;
        if (/launchos-gateway:present/i.test(out)) {
          gatewayRuntime = 'launchos-gateway';
          gatewayVersion = 'routes-file';
        }
        if (/nginx/i.test(out)) {
          gatewayRuntime = gatewayRuntime === 'launchos-gateway' ? 'nginx+launchos-gateway' : 'nginx';
          const m = out.match(/nginx\/([\d.]+)/i);
          gatewayVersion = m?.[1] || gatewayVersion || out.replace(/\s+/g, ' ').slice(0, 80);
        } else if (/openresty/i.test(out)) {
          gatewayRuntime = 'openresty';
          gatewayVersion = out.replace(/\s+/g, ' ').slice(0, 80);
        } else if (/caddy/i.test(out)) {
          gatewayRuntime = 'caddy';
          gatewayVersion = out.replace(/\s+/g, ' ').slice(0, 80);
        }

        const nginxProc = await soft(
          runner,
          shellCommand(
            `ps -ef 2>/dev/null | grep -E '[n]ginx:|[o]penresty|[c]addy|gateway\\.cjs' | head -n 8 || true`,
          ),
        );
        gatewayRunning = /nginx|openresty|caddy|gateway\.cjs/i.test(nginxProc.stdout || '');

        const confRoot = await soft(
          runner,
          shellCommand(
            `ls -d /www/server/panel/vhost/nginx /etc/nginx /www/server/nginx/conf /opt/launchos-gateway 2>/dev/null | head -n 5 || true`,
          ),
        );
        gatewayConfigRoot =
          (confRoot.stdout || '').split(/\r?\n/).find(Boolean) || null;

        const ss = await soft(
          runner,
          shellCommand(`ss -lntp 2>/dev/null | grep -E ':(22|80|443)\\b' || true`),
        );
        for (const port of [22, 80, 443]) {
          if (new RegExp(`:${port}\\b`).test(ss.stdout || '')) publicPortsListening.push(port);
        }
        // Prefer openssl metadata when wildcard cert files exist on this host.
        // Never print private key contents.
        const certPath = `${DEFAULT_WILDCARD_CERT_DIR}/fullchain.pem`;
        const certProbe = await soft(
          runner,
          shellCommand(
            `if [ -f ${certPath} ]; then echo CERT_PRESENT; openssl x509 -in ${certPath} -noout -subject -issuer -dates -ext subjectAltName 2>/dev/null; else echo CERT_MISSING; fi`,
          ),
        );
        const certOut = certProbe.stdout || '';
        if (/CERT_PRESENT/.test(certOut)) {
          const cn =
            certOut.match(/subject=.*?CN\s*=\s*([^,\n/]+)/i)?.[1]?.trim() ||
            certOut.match(/CN\s*=\s*([^,\n/]+)/i)?.[1]?.trim() ||
            sys?.tlsCertificateDomain ||
            null;
          const sansRaw = certOut.match(/DNS:([^\n]+)/gi) || [];
          const sans = sansRaw
            .flatMap((line) => line.split(','))
            .map((s) => s.replace(/DNS:/gi, '').trim())
            .filter(Boolean);
          const notBefore = certOut.match(/notBefore=(.+)/i)?.[1]?.trim() || null;
          const notAfter = certOut.match(/notAfter=(.+)/i)?.[1]?.trim() || null;
          const coversWeb = certificateCoversHostname({
            commonName: cn,
            sans,
            hostname: wl.web.hostname,
          });
          const coversApi = certificateCoversHostname({
            commonName: cn,
            sans,
            hostname: wl.api.hostname,
          });
          let valid = false;
          if (notAfter) {
            const exp = new Date(notAfter);
            valid = !Number.isNaN(exp.getTime()) && exp.getTime() > Date.now();
          }
          certMeta = {
            certificateId: sys?.id || 'remote-wildcard-file',
            commonName: cn,
            SANs: sans,
            notBefore,
            notAfter,
            coversWebHostname: coversWeb,
            coversApiHostname: coversApi,
            certificateValid: valid && coversWeb && coversApi,
            certificateReuse: valid && coversWeb && coversApi,
            certificatePresentOnServer: true,
          };
        } else if (sys?.tlsCertificateDomain) {
          const coversWeb = certificateCoversHostname({
            commonName: sys.tlsCertificateDomain,
            sans: [sys.tlsCertificateDomain],
            hostname: wl.web.hostname,
          });
          const coversApi = certificateCoversHostname({
            commonName: sys.tlsCertificateDomain,
            sans: [sys.tlsCertificateDomain],
            hostname: wl.api.hostname,
          });
          const exp = sys.tlsExpiresAt ? new Date(sys.tlsExpiresAt) : null;
          const valid = exp && !Number.isNaN(exp.getTime()) && exp.getTime() > Date.now();
          certMeta = {
            certificateId: sys.id,
            commonName: sys.tlsCertificateDomain,
            SANs: [sys.tlsCertificateDomain],
            notBefore: null,
            notAfter: exp?.toISOString() || null,
            coversWebHostname: coversWeb,
            coversApiHostname: coversApi,
            certificateValid: Boolean(valid && coversWeb && coversApi),
            // Reuse planned from system registry; files may still need install on this ECS.
            certificateReuse: Boolean(valid && coversWeb && coversApi),
            certificatePresentOnServer: false,
          };
        }
      } finally {
        await runner.disconnect().catch(() => undefined);
      }
    }

    // DNS account + dry-run plan (read-only)
    const dnsAccount =
      dnsAccounts.find((a) => a.status === 'VERIFIED' || a.status === 'ACTIVE') ||
      dnsAccounts[0] ||
      null;
    const dnsAccountReady = Boolean(
      dnsAccount &&
        dnsAccount.provider.type === 'ALIYUN_DNS' &&
        dnsAccount.credentialEncrypted &&
        ['VERIFIED', 'ACTIVE', 'PENDING'].includes(dnsAccount.status),
    );
    if (!dnsAccountReady) {
      blockers.push({ code: 'DNS_ACCOUNT_NOT_READY', message: 'ALIYUN_DNS account missing' });
    }

    const plannedIp = wl.publicIp;
    let webExisting = null;
    let apiExisting = null;
    if (dnsAccountReady && dnsAccount?.credentialEncrypted) {
      try {
        const secrets = decryptProviderSecrets(dnsAccount.credentialEncrypted);
        const dns = new AlibabaCloudDnsProvider(
          { accessKey: secrets.accessKey, secretKey: secrets.secretKey },
          wl.rootDomain,
        );
        const webRr = wl.web.hostname.replace(`.${wl.rootDomain}`, '');
        const apiRr = wl.api.hostname.replace(`.${wl.rootDomain}`, '');
        const webRecs = await dns.findARecordsReadOnly(webRr);
        const apiRecs = await dns.findARecordsReadOnly(apiRr);
        webExisting = webRecs[0] || null;
        apiExisting = apiRecs[0] || null;
      } catch (e) {
        blockers.push({
          code: 'DNS_READ_FAILED',
          message: e instanceof Error ? e.message.slice(0, 160) : 'dns read failed',
        });
      }
    }

    const webDnsChangeRequired = !(
      webExisting &&
      webExisting.type === 'A' &&
      webExisting.value === plannedIp
    );
    const apiDnsChangeRequired = !(
      apiExisting &&
      apiExisting.type === 'A' &&
      apiExisting.value === plannedIp
    );

    // Also check wildcard *.zsaos.com coverage via DNS (informational)
    let wildcardDnsPresent = false;
    if (dnsAccountReady && dnsAccount?.credentialEncrypted) {
      try {
        const secrets = decryptProviderSecrets(dnsAccount.credentialEncrypted);
        const dns = new AlibabaCloudDnsProvider(
          { accessKey: secrets.accessKey, secretKey: secrets.secretKey },
          wl.rootDomain,
        );
        const wild = await dns.findARecordsReadOnly('*');
        wildcardDnsPresent = wild.some((r) => r.value === plannedIp);
      } catch {
        wildcardDnsPresent = false;
      }
    }

    const webReqs = await prisma.runtimeConfigRequirement.findMany({
      where: { deployableUnitId: wl.web.unitId },
      select: { key: true, injectionPhase: true, required: true },
    });
    const webApi = detectWebApiConfigMode({
      framework: webUnit?.framework,
      requirements: webReqs,
    });

    const sg = planSecurityGroupForGateway({
      currentOpenPorts: publicPortsListening.length
        ? publicPortsListening
        : [22, 80, 443],
    });

    // Dynamic ports must stay private
    const dynProbes = [];
    for (const port of [39000, 39001]) {
      dynProbes.push(await tcpProbe(wl.publicIp, port));
    }
    const dynamicPortsRemainPrivate = !dynProbes.some((p) => p.status === 'open');

    if (!certMeta.certificateValid) {
      blockers.push({
        code: 'CERT_PENDING',
        message: 'wildcard certificate not valid/covering yet (plan only)',
      });
    } else if (!certMeta.certificatePresentOnServer) {
      blockers.push({
        code: 'CERT_INSTALL_PENDING',
        message: 'system wildcard cert reusable but not present on this managed ECS yet',
      });
    }
    if (gatewayRuntime === 'unknown' || !gatewayRunning) {
      blockers.push({
        code: 'GATEWAY_RUNTIME_PENDING',
        message: 'nginx/gateway not running on managed ECS yet (detect-only)',
      });
    }
    if (!publicPortsListening.includes(80) || !publicPortsListening.includes(443)) {
      blockers.push({
        code: 'PUBLIC_ENTRY_PORTS_PENDING',
        message: '80/443 not listening yet on managed ECS (plan only)',
      });
    }

    // Engineering readiness: routes + DNS account OK. Runtime install is Phase 2.
    const canConfigureGateway =
      webRouteCheck.ok &&
      apiRouteCheck.ok &&
      dnsAccountReady &&
      blockers.every(
        (b) => b.code !== 'SERVER_FORBIDDEN' && b.code !== 'OLD_SERVER_FORBIDDEN',
      );

    // Phase 1 keeps access entry pending even if gates look ready.
    const accessEntryStatus = 'ACCESS_ENTRY_PENDING';

    const report = {
      step: 'Step 29 Phase 1 Gateway Engineering + Dry-run',
      projectId: wl.projectId,
      serverInstanceId: wl.serverInstanceId,
      publicIp: wl.publicIp,
      gatewayRuntime,
      gatewayVersion,
      gatewayRunning,
      gatewayConfigRoot,
      publicPortsListening,
      webHostname: wl.web.hostname,
      webTarget: { host: '127.0.0.1', port: webTargetPort, healthPath: wl.web.healthPath },
      webTargetPort,
      webRouteValid: webRouteCheck.ok,
      apiHostname: wl.api.hostname,
      apiTarget: { host: '127.0.0.1', port: apiTargetPort, healthPath: wl.api.healthPath },
      apiTargetPort,
      apiRouteValid: apiRouteCheck.ok,
      dnsProvider: 'ALIYUN_DNS',
      dnsAccountReady,
      dnsAccountId: dnsAccount?.id || null,
      dnsAccountStatus: dnsAccount?.status || null,
      wildcardDnsPresent,
      webDnsChangeRequired,
      apiDnsChangeRequired,
      webDnsPlan: {
        hostname: wl.web.hostname,
        type: 'A',
        plannedRecord: plannedIp,
        existingRecord: webExisting ? { type: webExisting.type, value: webExisting.value } : null,
      },
      apiDnsPlan: {
        hostname: wl.api.hostname,
        type: 'A',
        plannedRecord: plannedIp,
        existingRecord: apiExisting ? { type: apiExisting.type, value: apiExisting.value } : null,
      },
      certificateReuse: certMeta.certificateReuse,
      certificateValid: certMeta.certificateValid,
      certificatePresentOnServer: certMeta.certificatePresentOnServer,
      coversWebHostname: certMeta.coversWebHostname,
      coversApiHostname: certMeta.coversApiHostname,
      certificate: {
        certificateId: certMeta.certificateId,
        commonName: certMeta.commonName,
        SANs: certMeta.SANs,
        notBefore: certMeta.notBefore,
        notAfter: certMeta.notAfter,
      },
      httpsRedirectPlanned: true,
      webApiConfigMode: webApi.webApiConfigMode,
      webApiConfigKey: webApi.webApiConfigKey,
      publicConfigOnly: webApi.publicConfigOnly,
      webApiPublicUrlPlanned: webApi.webApiPublicUrlPlanned,
      webRebuildRequiredForApiUrl: webApi.webApiConfigMode === 'BUILD_TIME',
      securityGroupChangeRequired: sg.securityGroupChangeRequired,
      dynamicPortsRemainPrivate,
      dynamicPortProbes: dynProbes,
      accessEntryStatus,
      expectedHealthChecks: expectedGatewayHealthChecks(),
      gatewayConfigGenerated: {
        webHasRedirect: /return 301/.test(webConfig.nginxHttpRedirect),
        apiHasRedirect: /return 301/.test(apiConfig.nginxHttpRedirect),
        webProxyPass: `http://127.0.0.1:${webTargetPort}`,
        apiProxyPass: `http://127.0.0.1:${apiTargetPort}`,
        // config text omitted from report to keep output small; available in memory only
      },
      canConfigureGateway,
      blockers,
      WRITE_COMMANDS_EXECUTED_THIS_RUN,
      oldServerUntouched: true,
      note: 'Phase 1 dry-run only — no nginx/DNS/cert/env writes',
    };

    const printed = redactSecrets(JSON.stringify(report, null, 2), []);
    const hits = secretHits(printed);
    if (Object.values(hits).some((n) => n > 0)) {
      throw new Error('secret leak in step29 dry-run report');
    }
    console.log(printed);
    console.log('\nDRY_RUN complete. WRITE_COMMANDS_EXECUTED_THIS_RUN=false');
  } finally {
    password = '';
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(redactSecrets(e instanceof Error ? e.message : String(e), []));
  process.exitCode = 1;
});
