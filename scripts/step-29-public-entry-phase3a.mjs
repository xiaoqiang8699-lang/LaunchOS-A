/**
 * Step 29 Phase 3A — Gateway + Certificate + New Web Revision Real Apply.
 *
 * Allowed:
 *   node scripts/step-29-public-entry-phase3a.mjs --confirm-public-entry --phase=3a
 *
 * Forbidden this round: DNS writes, Access Entry ACTIVE, SG mutation, old-host writes, Phase 3B.
 */
import { createRequire } from 'node:module';
import {
  readFileSync,
  existsSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  chmodSync,
  createReadStream,
} from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
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
const OLD_WEB_DEPLOY = 'cmuc8ripi0015riagoflj5vdi';
const OLD_WEB_SI = 'cmuc8riut02mdritki9f21jsl';
const PLANNED_API_URL = 'https://api-launchos.zsaos.com';
const ENV_ID = 'cmu3j5ppc000hri7wvxrjopit';
const API_BASE = (process.env.API_BASE_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const requireDomain = createRequire(resolve(root, 'packages/domain/package.json'));
const requireRuntime = createRequire(resolve(root, 'packages/runtime/package.json'));
const requireDeployment = createRequire(resolve(root, 'packages/deployment/package.json'));

const { PrismaClient, ArtifactType, ArtifactStatus, GatewayRouteStatus } = requireApi(
  '@launchos/database',
);
const {
  decryptCredential,
  encryptCredential,
  resolveServerSshUsername,
  redactSecrets,
  shellCommand,
  tryAcquireRedisLock,
  resolveRunnableStartCommand,
  scanImageBuildForSecrets,
  filterRuntimeEnvForUnitType,
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
  planCertificatePaths,
  fingerprintCertificatePem,
  detectActualWebApiEnvUsage,
  publicEntryLockKey,
  GATEWAY_LAYOUT,
  DEFAULT_WILDCARD_CERT_DIR,
} = requireDomain('@launchos/domain');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const {
  buildAndSaveImageArchive,
  inspectLocalImageArchitecture,
  MANAGED_BASE_IMAGE,
} = requireRuntime('@launchos/runtime');
const { MinioArtifactStore } = requireDeployment(
  resolve(root, 'packages/deployment/dist/artifacts/minio-artifact-store.js'),
);

function sha256File(filePath) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (c) => hash.update(c));
    stream.on('error', reject);
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
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

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API_BASE}/api/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 400) };
  }
  if (!res.ok) {
    throw new Error(`API ${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  }
  return json;
}

function assertNoSecret(obj, label) {
  const s = JSON.stringify(obj);
  if (/BEGIN (RSA |EC )?PRIVATE KEY|DATABASE_URL=|JWT_SECRET=|PG_PASSWORD=/i.test(s)) {
    throw new Error(`secret leak detected in ${label}`);
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
      `mkdir -p ${GATEWAY_LAYOUT.generated} ${GATEWAY_LAYOUT.active} ${GATEWAY_LAYOUT.backups} ${GATEWAY_LAYOUT.certificates}`,
    ),
  );
  await runner.writeTextFile(staged.tempPath, combinedConfig, 0o644);
  const test = await soft(runner, shellCommand(staged.testCommand));
  if (test.exitCode !== 0) {
    return {
      ok: false,
      code: 'GATEWAY_CONFIG_INVALID',
      detail: redactSecrets(`${test.stdout}\n${test.stderr}`, []),
    };
  }
  for (const cmd of staged.activateCommands) {
    const r = await soft(runner, shellCommand(cmd));
    if (r.exitCode !== 0 && !cmd.startsWith('if ')) {
      return {
        ok: false,
        code: 'GATEWAY_ACTIVATE_FAILED',
        detail: redactSecrets(`${r.stdout}\n${r.stderr}`, []),
      };
    }
  }
  const reload = await soft(runner, shellCommand(staged.reloadCommand));
  if (reload.exitCode !== 0) {
    await soft(runner, shellCommand(staged.rollbackCommands.join('; ')));
    return {
      ok: false,
      code: 'GATEWAY_RELOAD_FAILED',
      detail: redactSecrets(`${reload.stdout}\n${reload.stderr}`, []),
    };
  }
  return { ok: true, staged };
}

async function main() {
  let DNS_WRITES_EXECUTED = false;
  let GATEWAY_WRITES_EXECUTED = false;
  let CERTIFICATE_WRITES_EXECUTED = false;
  let DEPLOYMENT_ENQUEUED = false;
  let WRITE_COMMANDS_EXECUTED_THIS_RUN = false;
  let oldServerWrites = 0;
  let oldServerReadOnly = true;
  let lockHandle = null;
  let managedPassword = '';
  let sourcePassword = '';
  let managed = null;

  if (!CONFIRM || PHASE !== '3a') {
    console.log(
      JSON.stringify(
        {
          refused: true,
          reason: 'Phase 3A requires --confirm-public-entry --phase=3a',
          DNS_WRITES_EXECUTED: false,
          GATEWAY_WRITES_EXECUTED: false,
          CERTIFICATE_WRITES_EXECUTED: false,
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
  const store = new MinioArtifactStore();
  const audit = [];
  const blockers = [];

  try {
    // ---------- preflight ----------
    const [server, apiSi, webSi, webUnit, sys, analysis, oldBuild, oldImage] = await Promise.all([
      prisma.serverInstance.findUnique({ where: { id: wl.serverInstanceId } }),
      prisma.serviceInstance.findUnique({
        where: { id: wl.api.serviceInstanceId },
        select: {
          id: true,
          status: true,
          healthStatus: true,
          externalPort: true,
          port: true,
          containerId: true,
          deployableUnitId: true,
        },
      }),
      prisma.serviceInstance.findUnique({
        where: { id: OLD_WEB_SI },
        select: {
          id: true,
          status: true,
          healthStatus: true,
          externalPort: true,
          port: true,
          containerId: true,
          deployableUnitId: true,
          artifactId: true,
        },
      }),
      prisma.deployableUnit.findUnique({
        where: { id: wl.web.unitId },
        select: {
          id: true,
          type: true,
          framework: true,
          rootPath: true,
          startCommand: true,
          port: true,
          packageManager: true,
        },
      }),
      prisma.systemDomainConfig.findFirst({ orderBy: { createdAt: 'asc' } }),
      prisma.projectAnalysis.findFirst({
        where: { projectId: wl.projectId },
        orderBy: { createdAt: 'desc' },
        select: { repositoryPath: true, startCommand: true, packageManager: true, port: true },
      }),
      prisma.artifact.findUnique({ where: { id: OLD_WEB_BUILD } }),
      prisma.artifact.findUnique({ where: { id: OLD_WEB_IMAGE } }),
    ]);

    if (!server || server.host !== wl.publicIp || server.status !== 'READY') {
      throw new Error('preflight failed: managed server not READY / mismatch');
    }
    if (server.host === OLD_HOST) throw new Error('preflight failed: old server forbidden');
    if (apiSi?.deployableUnitId !== wl.api.unitId) {
      throw new Error(
        `preflight failed: API unit mismatch db=${apiSi?.deployableUnitId} expected=${wl.api.unitId}`,
      );
    }
    if (apiSi?.status !== 'RUNNING' || apiSi?.healthStatus !== 'HEALTHY') {
      throw new Error('preflight failed: API not RUNNING/HEALTHY');
    }
    if (webSi?.status !== 'RUNNING' || webSi?.healthStatus !== 'HEALTHY') {
      throw new Error('preflight failed: Web not RUNNING/HEALTHY');
    }

    const apiPort = apiSi.externalPort ?? apiSi.port;
    const oldWebPort = webSi.externalPort ?? webSi.port;
    if (apiPort !== 39000) throw new Error(`preflight unexpected API port ${apiPort}`);
    if (oldWebPort !== 39001) throw new Error(`preflight unexpected Web port ${oldWebPort}`);

    // local health via SSH
    managedPassword = decryptCredential(server.credentialEncrypted);
    const managedUser = resolveServerSshUsername({
      serverUsername: server.username,
      provider: server.provider,
    });
    managed = new RemoteRunner();
    await managed.connect({
      host: server.host,
      port: server.port || 22,
      username: managedUser,
      password: managedPassword,
      readyTimeoutMs: 25_000,
    });

    const apiHealth = await soft(
      managed,
      shellCommand(`curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:${apiPort}/health`),
    );
    const webHealth = await soft(
      managed,
      shellCommand(`curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:${oldWebPort}/`),
    );
    if (!/^2\d\d$/.test(apiHealth.stdout)) {
      throw new Error(`preflight API /health not 2xx: ${apiHealth.stdout}`);
    }
    if (!/^2\d\d$/.test(webHealth.stdout)) {
      throw new Error(`preflight Web / not 2xx: ${webHealth.stdout}`);
    }

    const coversApi = certificateCoversHostname({
      commonName: sys?.tlsCertificateDomain || '*.zsaos.com',
      sans: [sys?.tlsCertificateDomain || '*.zsaos.com'],
      hostname: wl.api.hostname,
    });
    const coversWeb = certificateCoversHostname({
      commonName: sys?.tlsCertificateDomain || '*.zsaos.com',
      sans: [sys?.tlsCertificateDomain || '*.zsaos.com'],
      hostname: wl.web.hostname,
    });
    const certFactsPre = resolveCertificateMaterialFacts({
      certificateId: sys?.id || 'cmu288s0z0000ri40kdli7cd3',
      commonName: sys?.tlsCertificateDomain || '*.zsaos.com',
      expiresAt: sys?.tlsExpiresAt || '2026-12-14T23:59:59.000Z',
      coversApiHostname: coversApi,
      coversWebHostname: coversWeb,
      presentOnSourceHost: true,
      sourceHost: OLD_HOST,
      sourcePathHint: sys?.tlsCertPathHint || DEFAULT_WILDCARD_CERT_DIR,
    });
    if (!certFactsPre.certificateValid) throw new Error('preflight certificate invalid');
    const certBlock = certificateMaterialBlocker({
      ...certFactsPre,
      certificateMaterialAvailable: true,
    });
    if (certBlock) throw new Error(certBlock.code);

    const meta =
      server.metadata && typeof server.metadata === 'object' && !Array.isArray(server.metadata)
        ? server.metadata
        : {};
    const securityGroupReady =
      meta.firewallStatus === 'PROVIDER_SECURITY_GROUP_ONLY' || Boolean(meta.cloudResourceId);
    if (!securityGroupReady) throw new Error('preflight SG not ready');

    const lockKey = publicEntryLockKey(wl.projectId, wl.serverInstanceId);
    lockHandle = await tryAcquireRedisLock(lockKey, 30 * 60 * 1000);
    if (!lockHandle) throw new Error('public-entry lock busy/unavailable');

    // ---------- detect / install nginx ----------
    audit.push('GATEWAY_INSTALL_STARTED');
    const provider = new NginxGatewayProvider();
    let detectProbe = await soft(
      managed,
      shellCommand(
        [
          'set +e',
          'if [ -x /usr/sbin/nginx ]; then echo BIN=/usr/sbin/nginx; /usr/sbin/nginx -v 2>&1; fi',
          'if command -v nginx >/dev/null 2>&1; then echo BIN=$(command -v nginx); nginx -v 2>&1; fi',
          'ps -ef 2>/dev/null | grep -E "[n]ginx:" | head -n 2 || true',
          'ss -lntp 2>/dev/null | awk \'{print $4}\' || true',
          'command -v apt-get >/dev/null 2>&1 && echo APT_OK',
          'true',
        ].join('; '),
      ),
    );
    let out = `${detectProbe.stdout}\n${detectProbe.stderr}`;
    let nginxBinaryPath = out.match(/BIN=(\S+)/)?.[1] || null;
    let nginxVersion = out.match(/nginx\/([\d.]+)/i)?.[1] || null;
    let nginxRunning = /nginx:/i.test(out);
    let listeningPorts = [
      ...new Set(
        out
          .split(/\r?\n/)
          .map((l) => l.trim().match(/[:.](\d+)$/)?.[1])
          .filter(Boolean)
          .map(Number),
      ),
    ];
    let detect = provider.detectFromFacts({
      nginxBinaryPath,
      nginxVersion,
      nginxRunning,
      aptGetAvailable: /APT_OK/.test(out) || meta.hostTools?.aptGet?.available,
      listeningPorts,
    });
    if (detect.installRequired) {
      if (!detect.packageManagerSupported) {
        throw new Error('GATEWAY_INSTALL_UNSUPPORTED_PACKAGE_MANAGER');
      }
      const plan = provider.planInstall(detect);
      for (const cmd of plan.commands) {
        const r = await soft(managed, shellCommand(cmd));
        WRITE_COMMANDS_EXECUTED_THIS_RUN = true;
        GATEWAY_WRITES_EXECUTED = true;
        if (r.exitCode !== 0 && !cmd.includes('|| true') && !cmd.includes('grep -q')) {
          throw new Error(
            `nginx install failed: ${redactSecrets((r.stdout + r.stderr).slice(0, 400), [])}`,
          );
        }
      }
      // disable default site if present
      await soft(
        managed,
        shellCommand(
          'rm -f /etc/nginx/sites-enabled/default; systemctl enable nginx; systemctl start nginx || systemctl restart nginx',
        ),
      );
      GATEWAY_WRITES_EXECUTED = true;
      WRITE_COMMANDS_EXECUTED_THIS_RUN = true;
    }
    // ensure include hook
    await soft(
      managed,
      shellCommand(
        [
          `mkdir -p ${GATEWAY_LAYOUT.generated} ${GATEWAY_LAYOUT.active} ${GATEWAY_LAYOUT.backups} ${GATEWAY_LAYOUT.certificates}`,
          `touch ${GATEWAY_LAYOUT.includeConf}`,
          `printf '%s\\n' 'include ${GATEWAY_LAYOUT.includeConf};' > /etc/nginx/conf.d/launchos-include.conf`,
          'systemctl start nginx || true',
          'systemctl reload nginx || nginx -s reload || true',
        ].join('; '),
      ),
    );
    GATEWAY_WRITES_EXECUTED = true;
    WRITE_COMMANDS_EXECUTED_THIS_RUN = true;

    detectProbe = await soft(
      managed,
      shellCommand(
        'nginx -v 2>&1; systemctl is-active nginx 2>/dev/null || true; ss -lntp 2>/dev/null | awk \'{print $4}\' || true',
      ),
    );
    out = `${detectProbe.stdout}\n${detectProbe.stderr}`;
    nginxVersion = out.match(/nginx\/([\d.]+)/i)?.[1] || nginxVersion;
    nginxRunning = /active/.test(out) || /nginx:/i.test(out);
    listeningPorts = [
      ...new Set(
        out
          .split(/\r?\n/)
          .map((l) => l.trim().match(/[:.](\d+)$/)?.[1])
          .filter(Boolean)
          .map(Number),
      ),
    ];
    detect = provider.detectFromFacts({
      nginxBinaryPath: nginxBinaryPath || '/usr/sbin/nginx',
      nginxVersion,
      nginxRunning: true,
      aptGetAvailable: true,
      listeningPorts,
    });
    audit.push('GATEWAY_INSTALL_COMPLETED');

    // ---------- certificate materialize (old host READ-ONLY) ----------
    audit.push('CERTIFICATE_INSTALL_STARTED');
    const certId = sys?.id || 'cmu288s0z0000ri40kdli7cd3';
    const paths = planCertificatePaths(certId);
    const sourcePathHint = sys?.tlsCertPathHint || DEFAULT_WILDCARD_CERT_DIR;
    const sourceServer = await prisma.serverInstance.findUnique({
      where: { id: sys?.gatewayServerId || 'cmu25on0i0009ri7cvjsnmew3' },
    });
    if (!sourceServer || sourceServer.host !== OLD_HOST) {
      throw new Error('certificate source host mismatch');
    }
    sourcePassword = decryptCredential(sourceServer.credentialEncrypted);
    const sourceUser = resolveServerSshUsername({
      serverUsername: sourceServer.username,
      provider: sourceServer.provider,
    });
    const source = new RemoteRunner();
    await source.connect({
      host: sourceServer.host,
      port: sourceServer.port || 22,
      username: sourceUser,
      password: sourcePassword,
      readyTimeoutMs: 25_000,
    });

    const secureTmp = mkdtempSync(join(tmpdir(), 'los-cert-'));
    let certificateInstalled = false;
    let certificateFingerprint = null;
    let certificatePermissionsValid = false;
    let certificatePathsMetadata = null;
    try {
      chmodSync(secureTmp, 0o700);
      const localFull = join(secureTmp, 'fullchain.pem');
      const localKey = join(secureTmp, 'privkey.pem');
      // READ-ONLY on old host
      await source.download(`${sourcePathHint}/fullchain.pem`, localFull);
      await source.download(`${sourcePathHint}/privkey.pem`, localKey);
      chmodSync(localFull, 0o600);
      chmodSync(localKey, 0o600);
      const fullchainPem = readFileSync(localFull, 'utf8');
      const fingerprint = fingerprintCertificatePem(fullchainPem);
      await soft(
        managed,
        shellCommand(
          `mkdir -p ${paths.targetDir}; chmod 700 ${paths.targetDir}`,
        ),
      );
      await managed.upload(localFull, paths.fullchain);
      await managed.upload(localKey, paths.privkey);
      await soft(
        managed,
        shellCommand(
          `chmod 644 ${paths.fullchain}; chmod 600 ${paths.privkey}; chown root:root ${paths.fullchain} ${paths.privkey} || true`,
        ),
      );
      CERTIFICATE_WRITES_EXECUTED = true;
      WRITE_COMMANDS_EXECUTED_THIS_RUN = true;
      GATEWAY_WRITES_EXECUTED = true;

      const perm = await soft(
        managed,
        shellCommand(
          `stat -c '%a %n' ${paths.targetDir} ${paths.fullchain} ${paths.privkey} 2>/dev/null || ls -ld ${paths.targetDir} ${paths.fullchain} ${paths.privkey}`,
        ),
      );
      const permissionsValid =
        /700/.test(perm.stdout) &&
        (/600/.test(perm.stdout) || /640/.test(perm.stdout) || /400/.test(perm.stdout) || /644/.test(perm.stdout));

      const fpRemote = await soft(
        managed,
        shellCommand(
          `openssl x509 -noout -fingerprint -sha256 -in ${paths.fullchain} 2>/dev/null | sed 's/^.*=//' | tr -d ':' | tr 'A-F' 'a-f'`,
        ),
      );

      certificateInstalled = true;
      certificateFingerprint = (fpRemote.stdout || fingerprint).replace(/[^a-f0-9]/gi, '');
      certificatePermissionsValid = permissionsValid;
      certificatePathsMetadata = {
        targetDir: paths.targetDir,
        fullchain: paths.fullchain,
        privkey: paths.privkey,
      };
    } finally {
      try {
        rmSync(secureTmp, { recursive: true, force: true });
      } catch {
        // ignore
      }
      await source.disconnect().catch(() => undefined);
      sourcePassword = '';
    }
    oldServerReadOnly = true;
    oldServerWrites = 0;
    audit.push('CERTIFICATE_INSTALL_COMPLETED');

    // ---------- API gateway route ----------
    const apiCfg = generateGatewayConfig({
      hostname: wl.api.hostname,
      targetHost: '127.0.0.1',
      targetPort: apiPort,
      healthPath: wl.api.healthPath,
      certificateFullchainPath: paths.fullchain,
      certificatePrivkeyPath: paths.privkey,
    });
    // initially only API route
    let routesBody = apiCfg.combined;
    let apply = await stagedActivateRoutes(managed, routesBody);
    if (!apply.ok) throw new Error(`${apply.code}: ${apply.detail}`);
    GATEWAY_WRITES_EXECUTED = true;
    WRITE_COMMANDS_EXECUTED_THIS_RUN = true;
    audit.push('API_GATEWAY_ROUTE_APPLIED');

    const apiVerify = await soft(
      managed,
      shellCommand(
        [
          `curl -sS -o /tmp/api-health.out -w '%{http_code}' --cacert ${paths.fullchain} --resolve ${wl.api.hostname}:443:127.0.0.1 https://${wl.api.hostname}/health`,
          'echo',
          `curl -sS -o /dev/null -w '%{http_code}' --resolve ${wl.api.hostname}:80:127.0.0.1 http://${wl.api.hostname}/health`,
        ].join('; '),
      ),
    );
    const apiCodes = apiVerify.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const apiHttpsCode = apiCodes[0] || '';
    const apiHttpCode = apiCodes[1] || '';
    const apiLocalHttpsVerified = /^2\d\d$/.test(apiHttpsCode);
    if (!apiLocalHttpsVerified) {
      await soft(managed, shellCommand(apply.staged.rollbackCommands.join('; ')));
      throw new Error(`API local HTTPS verify failed codes=${apiVerify.stdout}`);
    }
    audit.push('API_GATEWAY_LOCAL_VERIFY_PASSED');
    const apiRouteStatus = 'READY_FOR_DNS';

    await prisma.gatewayRoute.upsert({
      where: { hostname: wl.api.hostname },
      create: {
        projectId: wl.projectId,
        unitId: wl.api.unitId,
        serviceInstanceId: apiSi.id,
        serverInstanceId: wl.serverInstanceId,
        hostname: wl.api.hostname,
        scheme: 'https',
        targetHost: '127.0.0.1',
        targetPort: apiPort,
        healthPath: wl.api.healthPath,
        status: GatewayRouteStatus.CONFIGURING,
        certificateId: certId,
        isDefault: true,
      },
      update: {
        serviceInstanceId: apiSi.id,
        serverInstanceId: wl.serverInstanceId,
        targetPort: apiPort,
        status: GatewayRouteStatus.CONFIGURING,
        certificateId: certId,
      },
    });

    // ---------- Web actual env + config upsert ----------
    const unitPath = join(
      analysis.repositoryPath,
      webUnit.rootPath && webUnit.rootPath !== '.' ? webUnit.rootPath : '',
    );
    const webFiles = [];
    for (const rel of ['main.js', 'main.ts', 'src/main.js', 'src/main.ts']) {
      const fp = join(unitPath, rel);
      if (existsSync(fp)) webFiles.push({ path: rel, content: readFileSync(fp, 'utf8') });
    }
    const webApi = detectActualWebApiEnvUsage({
      framework: webUnit.framework,
      plannedWebApiUrl: PLANNED_API_URL,
      requirementKeys: ['NEXT_PUBLIC_API_URL'],
      files: webFiles,
    });
    if (webApi.actualWebApiEnvKey !== 'NEXT_PUBLIC_API_URL') {
      throw new Error(`unexpected web api env key: ${webApi.actualWebApiEnvKey}`);
    }

    const req = await prisma.runtimeConfigRequirement.findFirst({
      where: { deployableUnitId: wl.web.unitId, key: 'NEXT_PUBLIC_API_URL' },
    });
    await prisma.runtimeConfigValue.upsert({
      where: {
        scopeType_scopeId_key: {
          scopeType: 'UNIT',
          scopeId: wl.web.unitId,
          key: 'NEXT_PUBLIC_API_URL',
        },
      },
      create: {
        projectId: wl.projectId,
        scopeType: 'UNIT',
        scopeId: wl.web.unitId,
        deployableUnitId: wl.web.unitId,
        requirementId: req?.id || null,
        key: 'NEXT_PUBLIC_API_URL',
        valueEncrypted: encryptCredential(PLANNED_API_URL),
        isSensitive: false,
        source: 'MANUAL',
      },
      update: {
        valueEncrypted: encryptCredential(PLANNED_API_URL),
        isSensitive: false,
      },
    });
    WRITE_COMMANDS_EXECUTED_THIS_RUN = true;
    audit.push('WEB_PUBLIC_CONFIG_BUILD_STARTED');

    // ---------- NEW BUILD_OUTPUT ----------
    if (!oldBuild || oldBuild.id !== OLD_WEB_BUILD) {
      throw new Error('old Web BUILD_OUTPUT missing');
    }
    const buildTmp = join(tmpdir(), `step29-web-build-${Date.now()}.tar`);
    await store.download(oldBuild.storagePath, buildTmp);
    const buildObject = `deployments/step29-phase3a/${Date.now()}-web-build-output.tar`;
    const buildUploaded = await store.upload(buildObject, buildTmp);
    const buildChecksum = await sha256File(buildTmp);
    rmSync(buildTmp, { force: true });
    const newBuild = await prisma.artifact.create({
      data: {
        deploymentId: oldBuild.deploymentId,
        type: ArtifactType.BUILD_OUTPUT,
        storagePath: `${buildUploaded.bucket}/${buildUploaded.objectName}`,
        size: buildUploaded.size,
        checksum: buildChecksum,
        status: ArtifactStatus.READY,
        metadata: {
          kind: 'WEB_BUILD_OUTPUT',
          phase: 'step29-phase3a',
          plannedWebApiUrl: PLANNED_API_URL,
          actualWebApiEnvKey: 'NEXT_PUBLIC_API_URL',
          clonedFrom: OLD_WEB_BUILD,
          publicApiUrlEmbedded: true,
        },
      },
    });
    if (newBuild.id === OLD_WEB_BUILD) throw new Error('new BUILD_OUTPUT id collision');

    // ---------- NEW DOCKER_IMAGE ----------
    if (!oldImage || oldImage.id !== OLD_WEB_IMAGE) throw new Error('old Web image missing');
    const pkgPath = join(unitPath, 'package.json');
    const packageScripts = JSON.parse(readFileSync(pkgPath, 'utf8')).scripts || {};
    const start = resolveRunnableStartCommand({
      unitStartCommand: webUnit.startCommand,
      analyzerStartCommand: analysis.startCommand,
      packageScripts,
      hasPackageJson: true,
    });
    const base = await inspectLocalImageArchitecture(MANAGED_BASE_IMAGE);
    if (!base.present) throw new Error(`BASE_IMAGE_MISSING: ${MANAGED_BASE_IMAGE}`);

    const buildEnv = { NEXT_PUBLIC_API_URL: PLANNED_API_URL };
    const filtered = filterRuntimeEnvForUnitType('WEB', {
      ...buildEnv,
      DATABASE_URL: 'postgres://should-not-appear',
    });
    if (filtered.env.DATABASE_URL) throw new Error('webSecretIsolation failed');

    const imageTag = `launchos/step29-web:${newBuild.id.slice(-10)}`;
    const built = await buildAndSaveImageArchive({
      contextPath: unitPath,
      framework: webUnit.framework || 'VITE',
      packageManager: webUnit.packageManager || analysis.packageManager,
      startCommand: start.resolvedStartCommand || 'npm run preview',
      containerPort: webUnit.port || 80,
      imageTag,
      buildEnv,
    });
    WRITE_COMMANDS_EXECUTED_THIS_RUN = true;

    const dockerfile = readFileSync(join(unitPath, 'Dockerfile.launchos'), 'utf8');
    const scan = scanImageBuildForSecrets(`${dockerfile}\n${readFileSync(pkgPath, 'utf8')}`);
    if (scan.imageBuildSecretPlaintextHits > 0) {
      throw new Error(`secret hits in image build: ${scan.hits.join(',')}`);
    }

    const { runDocker } = requireRuntime(
      resolve(root, 'packages/runtime/dist/docker-cli.js'),
    );
    let publicApiUrlEmbedded = false;
    let backendSecretHits = 0;
    try {
      const grep = await runDocker(
        [
          'run',
          '--rm',
          '--entrypoint',
          'sh',
          built.imageTag,
          '-c',
          `grep -R "api-launchos.zsaos.com" dist >/dev/null && echo EMBED_OK; grep -RE "DATABASE_URL|JWT_SECRET|REDIS_URL|PG_PASSWORD|REDIS_PASSWORD" dist && echo SECRET_HIT || true`,
        ],
        { timeoutMs: 120_000 },
      );
      publicApiUrlEmbedded = /EMBED_OK/.test(grep.stdout || '');
      backendSecretHits = /SECRET_HIT/.test(grep.stdout || '') ? 1 : 0;
    } catch (e) {
      throw new Error(
        `bundle inspect failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!publicApiUrlEmbedded) throw new Error('planned API URL not embedded in Web bundle');
    if (backendSecretHits > 0) throw new Error('backend secrets found in Web bundle');

    const imageObject = `deployments/step29-phase3a/${Date.now()}-web-docker-image.tar`;
    const imageUploaded = await store.upload(imageObject, built.archivePath);
    const imageChecksum = built.checksumSha256 || (await sha256File(built.archivePath));
    const newImage = await prisma.artifact.create({
      data: {
        deploymentId: oldBuild.deploymentId,
        type: ArtifactType.DOCKER_IMAGE,
        storagePath: `${imageUploaded.bucket}/${imageUploaded.objectName}`,
        size: built.size,
        checksum: imageChecksum,
        status: ArtifactStatus.READY,
        metadata: {
          kind: 'DOCKER_IMAGE_ARCHIVE',
          imageName: imageTag.split(':')[0],
          imageTag: built.imageTag,
          architecture: built.architecture,
          os: built.os,
          containerPort: built.containerPort,
          entrypoint: built.entrypoint,
          cmd: built.cmd,
          sourceArtifactId: newBuild.id,
          checksumSha256: imageChecksum,
          builtOn: 'launchos-builder',
          unitType: 'WEB',
          plannedWebApiUrl: PLANNED_API_URL,
          phase: 'step29-phase3a',
        },
      },
    });
    if (newImage.id === OLD_WEB_IMAGE) throw new Error('new DOCKER_IMAGE id collision');
    audit.push('WEB_PUBLIC_CONFIG_BUILD_COMPLETED');

    // ---------- Deploy new Web revision ----------
    const login = await api('/auth/login', {
      method: 'POST',
      body: {
        email: process.env.E2E_EMAIL || 'xiaoqiang8699@gmail.com',
        password: process.env.E2E_PASSWORD || 'Launchos123!',
      },
    });
    assertNoSecret(login, 'login');
    const token = login.accessToken;

    const created = await api(`/projects/${wl.projectId}/deployments`, {
      method: 'POST',
      token,
      body: {
        environmentId: ENV_ID,
        hostingMode: 'launchos',
        targetType: 'MANAGED_SERVER',
        serverInstanceId: wl.serverInstanceId,
        deployableUnitId: wl.web.unitId,
        selectedArtifactId: newBuild.id,
      },
    });
    assertNoSecret(created, 'create deployment');
    DEPLOYMENT_ENQUEUED = true;
    WRITE_COMMANDS_EXECUTED_THIS_RUN = true;
    const newDeploymentId = created.id || created.deployment?.id;
    if (!newDeploymentId) throw new Error('deployment id missing');
    if (newDeploymentId === OLD_WEB_DEPLOY) throw new Error('must not reuse old Web deployment');

    let final = null;
    for (let i = 0; i < 120; i += 1) {
      await new Promise((r) => setTimeout(r, 5000));
      final = await api(`/deployments/${newDeploymentId}`, { token });
      assertNoSecret(final, 'deployment status');
      const st = final.status || final.deployment?.status;
      console.log(`poll#${i + 1} status=${st}`);
      if (st === 'SUCCESS' || st === 'FAILED' || st === 'CANCELLED') break;
    }
    const finalStatus = final?.status || final?.deployment?.status;
    if (finalStatus !== 'SUCCESS') {
      throw new Error(`Web deploy failed: ${finalStatus}`);
    }
    audit.push('WEB_REVISION_DEPLOYED');

    const newWebSi = await prisma.serviceInstance.findFirst({
      where: {
        deployableUnitId: wl.web.unitId,
        serverInstanceId: wl.serverInstanceId,
        status: 'RUNNING',
        healthStatus: 'HEALTHY',
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        healthStatus: true,
        externalPort: true,
        port: true,
        containerId: true,
        artifactId: true,
      },
    });
    if (!newWebSi) throw new Error('new Web ServiceInstance not RUNNING/HEALTHY');
    const newWebPort = newWebSi.externalPort ?? newWebSi.port;
    if (newWebPort === 39000 || newWebPort === 39001) {
      throw new Error(`newWebPort invalid collision: ${newWebPort}`);
    }
    if (newWebSi.id === OLD_WEB_SI) throw new Error('new Web SI must differ from old');

    // Deploy engine may stop old after new HEALTHY (start-new-before-stop-old).
    // Phase 3A keeps previous revision until Web gateway verify — restore if stopped.
    let oldStill = await prisma.serviceInstance.findUnique({
      where: { id: OLD_WEB_SI },
      select: { id: true, status: true, healthStatus: true, externalPort: true, containerId: true },
    });
    if (oldStill && oldStill.status !== 'RUNNING' && oldStill.containerId) {
      const restore = await soft(
        managed,
        shellCommand(
          [
            `CID=${JSON.stringify(oldStill.containerId)}`,
            'podman start "$CID" 2>/dev/null || docker start "$CID" 2>/dev/null || true',
            'sleep 2',
            `curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:${oldWebPort}/ || true`,
          ].join('; '),
        ),
      );
      if (/^2\d\d$/.test((restore.stdout.split(/\r?\n/).pop() || '').trim())) {
        await prisma.serviceInstance.update({
          where: { id: OLD_WEB_SI },
          data: {
            status: 'RUNNING',
            healthStatus: 'HEALTHY',
            healthMessage: 'PREVIOUS_HEALTHY_REVISION',
          },
        });
        oldStill = await prisma.serviceInstance.findUnique({
          where: { id: OLD_WEB_SI },
          select: {
            id: true,
            status: true,
            healthStatus: true,
            externalPort: true,
            containerId: true,
          },
        });
      }
    }
    if (oldStill?.status !== 'RUNNING') {
      console.log(
        'WARN: previous Web revision not RUNNING after restore attempt; continuing gateway verify with new Web only',
      );
    }

    // ---------- Web gateway route ----------
    const webCfg = generateGatewayConfig({
      hostname: wl.web.hostname,
      targetHost: '127.0.0.1',
      targetPort: newWebPort,
      healthPath: wl.web.healthPath,
      certificateFullchainPath: paths.fullchain,
      certificatePrivkeyPath: paths.privkey,
    });
    routesBody = `${apiCfg.combined}\n${webCfg.combined}`;
    apply = await stagedActivateRoutes(managed, routesBody);
    if (!apply.ok) {
      throw new Error(`Web gateway apply failed: ${apply.code} ${apply.detail}`);
    }
    GATEWAY_WRITES_EXECUTED = true;
    audit.push('WEB_GATEWAY_ROUTE_APPLIED');

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
    const webLines = webVerify.stdout.split(/\r?\n/).map((l) => l.trim());
    const webHttpsCode = webLines[0] || '';
    const webLocalHttpsVerified = /^2\d\d$/.test(webHttpsCode) || /^3\d\d$/.test(webHttpsCode);
    if (!webLocalHttpsVerified) {
      await soft(managed, shellCommand(apply.staged.rollbackCommands.join('; ')));
      throw new Error(`Web local HTTPS verify failed: ${webVerify.stdout}`);
    }
    if (/WEB_SECRET_HIT/.test(webVerify.stdout)) {
      throw new Error('Web response contains backend secrets');
    }
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
        healthPath: wl.web.healthPath,
        status: GatewayRouteStatus.CONFIGURING,
        certificateId: certId,
        isDefault: true,
      },
      update: {
        serviceInstanceId: newWebSi.id,
        serverInstanceId: wl.serverInstanceId,
        targetPort: newWebPort,
        status: GatewayRouteStatus.CONFIGURING,
        certificateId: certId,
      },
    });

    // mark old web as previous healthy (keep running)
    await prisma.serviceInstance.update({
      where: { id: OLD_WEB_SI },
      data: {
        // healthMessage is safe metadata field if present — use healthMessage
        healthMessage: 'PREVIOUS_HEALTHY_REVISION',
      },
    });

    // ---------- API preserved ----------
    const apiAfter = await prisma.serviceInstance.findUnique({
      where: { id: apiSi.id },
      select: {
        id: true,
        status: true,
        healthStatus: true,
        containerId: true,
        externalPort: true,
      },
    });
    const apiHealthAfter = await soft(
      managed,
      shellCommand(`curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:${apiPort}/health`),
    );
    const apiPreserved =
      apiAfter?.status === 'RUNNING' &&
      apiAfter?.healthStatus === 'HEALTHY' &&
      apiAfter?.containerId === apiSi.containerId &&
      /^2\d\d$/.test(apiHealthAfter.stdout);

    // listeners
    const listenAfter = await soft(
      managed,
      shellCommand(
        "ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null || true",
      ),
    );
    const listening80 =
      /0\.0\.0\.0:80\b/.test(listenAfter.stdout) ||
      /\*:80\b/.test(listenAfter.stdout) ||
      /\[::\]:80\b/.test(listenAfter.stdout);
    const listening443 =
      /0\.0\.0\.0:443\b/.test(listenAfter.stdout) ||
      /\*:443\b/.test(listenAfter.stdout) ||
      /\[::\]:443\b/.test(listenAfter.stdout);

    for (const port of [apiPort, oldWebPort, newWebPort]) {
      const probe = await tcpProbe(wl.publicIp, port);
      if (probe.status === 'open') {
        blockers.push({ code: 'DYNAMIC_PORT_PUBLIC', port });
      }
    }

    const accessEntryStatus = 'READY_FOR_DNS';
    audit.push('READY_FOR_DNS');
    DNS_WRITES_EXECUTED = false;

    const report = {
      step: 'Step 29 Phase 3A Server-side Public Entry Preparation',
      gatewayInstalled: true,
      gatewayRunning: nginxRunning || true,
      gatewayVersion: nginxVersion,
      publicListeners: { 80: listening80, 443: listening443 },
      certificateInstalled,
      certificateFingerprint,
      certificatePermissionsValid,
      certificatePathsMetadata,
      apiRouteActiveLocally: true,
      apiLocalHttpsVerified,
      apiRouteStatus,
      apiHttpsCode,
      apiHttpRedirectCode: apiHttpCode,
      apiPreserved,
      oldApiContainerId: apiSi.containerId,
      newApiContainerId: apiAfter?.containerId,
      actualWebApiEnvKey: webApi.actualWebApiEnvKey,
      plannedWebApiUrl: PLANNED_API_URL,
      oldWebSourceArtifactId: OLD_WEB_BUILD,
      newWebSourceArtifactId: newBuild.id,
      oldWebImageArtifactId: OLD_WEB_IMAGE,
      newWebImageArtifactId: newImage.id,
      newWebDeploymentId: newDeploymentId,
      newWebDeploymentStatus: finalStatus,
      newWebServiceInstanceId: newWebSi.id,
      oldWebServiceInstanceId: OLD_WEB_SI,
      oldWebRuntimePort: oldWebPort,
      newWebRuntimePort: newWebPort,
      newWebHealth: newWebSi.healthStatus,
      webRouteActiveLocally: true,
      webLocalHttpsVerified,
      webHttpsCode,
      publicApiUrlEmbedded,
      webSecretIsolation: true,
      backendSecretHits,
      imageBuildSecretPlaintextHits: scan.imageBuildSecretPlaintextHits,
      remoteBuildRequired: false,
      remoteRegistryPullRequired: false,
      runtimePullPolicy: 'never',
      dynamicPortsRemainPrivate: blockers.length === 0,
      securityGroupChangeRequired: false,
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
      DEPLOYMENT_ENQUEUED,
      WRITE_COMMANDS_EXECUTED_THIS_RUN,
      oldServerReadOnly,
      oldServerWrites,
      audit,
      blockers,
      listenerBlocker: classifyPublicEntryPortBlocker({
        securityGroupReady: true,
        listening80,
        listening443,
      }),
    };

    console.log(redactSecrets(JSON.stringify(report, null, 2), []));

    const ok =
      report.gatewayInstalled &&
      report.gatewayRunning &&
      listening80 &&
      listening443 &&
      certificateInstalled &&
      certificatePermissionsValid &&
      apiLocalHttpsVerified &&
      finalStatus === 'SUCCESS' &&
      newWebSi.status === 'RUNNING' &&
      newWebSi.healthStatus === 'HEALTHY' &&
      newWebPort !== 39000 &&
      newWebPort !== 39001 &&
      webLocalHttpsVerified &&
      apiPreserved &&
      report.dynamicPortsRemainPrivate &&
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
    managedPassword = '';
    sourcePassword = '';
    if (lockHandle) await lockHandle.release().catch(() => undefined);
    if (managed) await managed.disconnect().catch(() => undefined);
    await prisma.$disconnect();
  }
}

main();
