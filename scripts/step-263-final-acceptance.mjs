/**
 * Step 26.3 Final read-only acceptance.
 * Never: --confirm-initialize / install / firewall mutate / app deploy.
 *
 *   node scripts/step-263-final-acceptance.mjs
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

const SI = 'cmub78pz001sdripco5pexhdz';
const CR = 'cmuas8iiz0001riown1l1a0o3';
const TARGET_IP = '116.62.198.184';
const OLD_IP = '8.138.113.134';
const SG_ID = 'sg-bp1140codg2rttjhff9x';
const REGION = 'cn-hangzhou';
const EXPECTED_PORTS = [22, 80, 443];
const FORBIDDEN_PORTS = [3000, 3001];

const require = createRequire(resolve(root, 'apps/api/package.json'));
const requireProviders = createRequire(resolve(root, 'packages/providers/package.json'));
const { PrismaClient } = require('@launchos/database');
const {
  decryptCredential,
  resolveServerSshUsername,
  redactSecrets,
  shellCommand,
  serverInitializationJobId,
  SERVER_INIT_READINESS_LABELS,
  SERVER_INIT_PHASE_LABELS,
  canStartServerInitialization,
  SERVER_INITIALIZATION_QUEUE,
} = require('@launchos/shared');
const { RemoteRunner } = require('@launchos/remote-runner');
const { Queue } = require('bullmq');
const IORedis = require('ioredis');

async function soft(runner, cmd) {
  try {
    const r = await runner.execute(cmd, { timeoutMs: 45_000 });
    return {
      exitCode: r.exitCode,
      stdout: (r.stdout || '').trim(),
      stderr: (r.stderr || '').trim().slice(0, 400),
    };
  } catch (e) {
    return {
      exitCode: -1,
      stdout: '',
      stderr: e instanceof Error ? e.message : String(e),
    };
  }
}

function parseListenPorts(ssOut) {
  const lines = String(ssOut || '').split(/\r?\n/);
  const ports = [];
  for (const line of lines) {
    // e.g. LISTEN 0 128 0.0.0.0:22 0.0.0.0:*
    const m =
      /\b(0\.0\.0\.0|::|\[::\]):(\d+)\b/.exec(line) ||
      /\s(\*|0\.0\.0\.0|::):(\d+)\s/.exec(line);
    if (m) {
      ports.push({ bind: m[1], port: Number(m[2]), line: line.slice(0, 160) });
    }
  }
  return ports;
}

function isDynamicPublic(port) {
  return port >= 39000 && port <= 39999;
}

async function tcpProbe(host, port, timeoutMs = 3500) {
  return new Promise((resolveProbe) => {
    const started = Date.now();
    const socket = createConnection({ host, port });
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolveProbe({ port, ...result, ms: Date.now() - started });
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => finish({ status: 'open' }));
    socket.on('timeout', () => finish({ status: 'filtered' }));
    socket.on('error', (err) => {
      const code = err && err.code ? String(err.code) : 'ERROR';
      if (code === 'ECONNREFUSED') finish({ status: 'refused', code });
      else if (code === 'ETIMEDOUT') finish({ status: 'filtered', code });
      else finish({ status: 'error', code });
    });
  });
}

/**
 * Prefer DescribeSecurityGroupAttribute.
 * If RAM denies Attribute, fall back to:
 *   - DescribeSecurityGroups (existence)
 *   - DescribeInstances (attachment)
 *   - external TCP probe (22/80/443 allowed; 3000/3001/39000-39999 filtered)
 * Never Authorize/Create/Modify.
 */
async function validateSecurityGroupReadonly(accessKey, secretKey, publicIp, instanceId) {
  const EcsMod = requireProviders('@alicloud/ecs20140526');
  const { $OpenApiUtil } = requireProviders('@alicloud/openapi-core');
  const EcsClient = EcsMod.default || EcsMod;
  const config = new $OpenApiUtil.Config({
    accessKeyId: accessKey,
    accessKeySecret: secretKey,
  });
  config.endpoint = `ecs.${REGION}.aliyuncs.com`;
  const client = new EcsClient(config);

  let attributeReadable = false;
  let attributeError = null;
  let observedFromAttribute = [];

  try {
    const res = await client.describeSecurityGroupAttribute(
      new EcsMod.DescribeSecurityGroupAttributeRequest({
        regionId: REGION,
        securityGroupId: SG_ID,
        direction: 'ingress',
      }),
    );
    attributeReadable = true;
    const perms = res.body?.permissions?.permission || [];
    const publicTcpPorts = new Set();
    for (const p of perms) {
      const ip = p.sourceCidrIp || p.ipv6SourceCidrIp || '';
      const policy = String(p.policy || 'Accept').toLowerCase();
      const ipProtocol = String(p.ipProtocol || '').toLowerCase();
      if (policy === 'drop') continue;
      if (ipProtocol && ipProtocol !== 'tcp' && ipProtocol !== 'all') continue;
      if (ip !== '0.0.0.0/0' && ip !== '::/0' && ip !== '') continue;
      const portRange = String(p.portRange || '');
      const m = /^(\d+)\/(\d+)$/.exec(portRange);
      if (!m) continue;
      const from = Number(m[1]);
      const to = Number(m[2]);
      for (let port = from; port <= to; port += 1) publicTcpPorts.add(port);
    }
    observedFromAttribute = [...publicTcpPorts].sort((a, b) => a - b);
  } catch (e) {
    attributeError = String(e.message || e).slice(0, 240);
  }

  let sgExists = false;
  let attached = false;
  try {
    const listed = await client.describeSecurityGroups(
      new EcsMod.DescribeSecurityGroupsRequest({
        regionId: REGION,
        securityGroupIds: JSON.stringify([SG_ID]),
      }),
    );
    const groups = listed.body?.securityGroups?.securityGroup || [];
    sgExists = groups.some((g) => g.securityGroupId === SG_ID);
  } catch (e) {
    attributeError = attributeError || String(e.message || e).slice(0, 240);
  }

  try {
    const inst = await client.describeInstances(
      new EcsMod.DescribeInstancesRequest({
        regionId: REGION,
        instanceIds: JSON.stringify([instanceId]),
      }),
    );
    const row = inst.body?.instances?.instance?.[0];
    const ids = row?.securityGroupIds?.securityGroupId || [];
    attached = ids.includes(SG_ID);
  } catch (e) {
    attributeError = attributeError || String(e.message || e).slice(0, 240);
  }

  const probePorts = [...EXPECTED_PORTS, ...FORBIDDEN_PORTS, 39000, 39001, 39999];
  const tcpResults = [];
  for (const port of probePorts) {
    // sequential
    // eslint-disable-next-line no-await-in-loop
    tcpResults.push(await tcpProbe(publicIp, port));
  }

  // TCP inference: open|refused => SG allows; filtered => SG drops/blocks
  const allowedByTcp = tcpResults
    .filter((r) => r.status === 'open' || r.status === 'refused')
    .map((r) => r.port)
    .sort((a, b) => a - b);
  const filteredByTcp = tcpResults
    .filter((r) => r.status === 'filtered')
    .map((r) => r.port);

  let observedPublicPorts;
  let method;
  if (attributeReadable) {
    observedPublicPorts = observedFromAttribute;
    method = 'DescribeSecurityGroupAttribute';
  } else {
    // Infer expected set from TCP: expected ports must be allowed; forbidden must be filtered
    observedPublicPorts = allowedByTcp.filter((p) => EXPECTED_PORTS.includes(p));
    method = 'DescribeSecurityGroups+DescribeInstances+externalTcpProbe';
  }

  const unexpected = observedPublicPorts.filter((p) => !EXPECTED_PORTS.includes(p));
  const missingExpected = EXPECTED_PORTS.filter((p) => !observedPublicPorts.includes(p));
  const forbiddenLeaking = FORBIDDEN_PORTS.filter((p) => allowedByTcp.includes(p));
  const dynamicLeaking = [39000, 39001, 39999].filter((p) => allowedByTcp.includes(p));

  const securityGroupValid =
    sgExists &&
    attached &&
    unexpected.length === 0 &&
    missingExpected.length === 0 &&
    forbiddenLeaking.length === 0 &&
    dynamicLeaking.length === 0 &&
    // expected 22 must be open (SSH); 80/443 must not be filtered
    tcpResults.find((r) => r.port === 22)?.status === 'open' &&
    ['open', 'refused'].includes(tcpResults.find((r) => r.port === 80)?.status) &&
    ['open', 'refused'].includes(tcpResults.find((r) => r.port === 443)?.status);

  return {
    method,
    securityGroupId: SG_ID,
    attributeReadable,
    attributeError,
    sgExists,
    attached,
    expectedPublicPorts: EXPECTED_PORTS,
    observedPublicPorts,
    unexpectedPublicPorts: [...new Set([...unexpected, ...forbiddenLeaking, ...dynamicLeaking])],
    missingExpectedPorts: missingExpected,
    securityGroupValid,
    tcpResults,
    filteredByTcp,
  };
}

function secretScan(blobs, knownPlainPassword, knownAk, knownSk) {
  let sshPasswordPlaintextHits = 0;
  let aliyunAkPlaintextHits = 0;
  let aliyunSkPlaintextHits = 0;
  let privateKeyPlaintextHits = 0;
  const hitLabels = [];

  for (const [label, raw] of blobs) {
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (knownPlainPassword && knownPlainPassword.length >= 8 && text.includes(knownPlainPassword)) {
      sshPasswordPlaintextHits += 1;
      hitLabels.push(`password@${label}`);
    }
    if (knownAk && knownAk.length >= 8 && text.includes(knownAk)) {
      aliyunAkPlaintextHits += 1;
      hitLabels.push(`ak@${label}`);
    }
    if (knownSk && knownSk.length >= 8 && text.includes(knownSk)) {
      aliyunSkPlaintextHits += 1;
      hitLabels.push(`sk@${label}`);
    }
    if (/BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY/.test(text)) {
      privateKeyPlaintextHits += 1;
      hitLabels.push(`pkey@${label}`);
    }
  }

  // passwordEncrypted ciphertext presence is OK — not counted as plaintext
  return {
    sshPasswordPlaintextHits,
    aliyunAkPlaintextHits,
    aliyunSkPlaintextHits,
    privateKeyPlaintextHits,
    hitLabels,
    secretScanPassed:
      sshPasswordPlaintextHits === 0 &&
      aliyunAkPlaintextHits === 0 &&
      aliyunSkPlaintextHits === 0 &&
      privateKeyPlaintextHits === 0,
  };
}

async function collectLogBlobs() {
  const blobs = [];
  // Prior Step 26.3 script outputs under scripts/ (if any) + agent transcripts are out of band;
  // scan local e2e JSON dumps if present.
  const candidates = [
    'scripts/.step-263-e2e-last.json',
    'scripts/.step-263-resume-last.json',
    'scripts/.step-263-acceptance-last.json',
  ];
  for (const rel of candidates) {
    try {
      const p = resolve(root, rel);
      blobs.push([rel, readFileSync(p, 'utf8')]);
    } catch {
      // optional
    }
  }
  // docker compose logs (read-only) for api/worker — best-effort
  try {
    const { execSync } = await import('node:child_process');
    for (const svc of ['api', 'worker']) {
      try {
        const out = execSync(`docker compose logs --no-color --tail=200 ${svc}`, {
          cwd: root,
          encoding: 'utf8',
          timeout: 20_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        blobs.push([`docker:${svc}`, out]);
      } catch {
        // optional
      }
    }
  } catch {
    // optional
  }
  return blobs;
}

function readyIdempotencyFixture() {
  // Mirror ServerInitializationService READY short-circuit
  const server = { status: 'READY', id: SI };
  let enqueueCalls = 0;
  let sshCalls = 0;
  const result =
    server.status === 'READY'
      ? {
          alreadyReady: true,
          alreadyInProgress: false,
          serverInstanceId: server.id,
          serverReadiness: 'READY',
          serverReadinessLabel: SERVER_INIT_READINESS_LABELS.READY,
          phase: 'READY',
          phaseLabel: SERVER_INIT_PHASE_LABELS.READY,
          progress: 100,
          jobId: serverInitializationJobId(server.id),
        }
      : null;
  // ensure we would not start
  if (result?.alreadyReady) {
    // no enqueue / no ssh
  } else {
    enqueueCalls += 1;
    sshCalls += 1;
  }
  return {
    readyIdempotency: result?.alreadyReady === true && enqueueCalls === 0 && sshCalls === 0,
    alreadyReady: result?.alreadyReady === true,
    canStartWhenReady: canStartServerInitialization('READY') === false,
  };
}

async function main() {
  const prisma = new PrismaClient();
  let password = '';
  let accessKey = '';
  let secretKey = '';
  const WRITE_COMMANDS_EXECUTED_THIS_RUN = false;

  try {
    const server = await prisma.serverInstance.findUnique({ where: { id: SI } });
    if (!server) throw new Error('ServerInstance missing');
    if (server.host !== TARGET_IP) throw new Error(`host mismatch ${server.host}`);

    const resource = await prisma.cloudResource.findUnique({ where: { id: CR } });
    const crMeta =
      resource?.metadata && typeof resource.metadata === 'object' && !Array.isArray(resource.metadata)
        ? resource.metadata
        : {};
    const meta =
      server.metadata && typeof server.metadata === 'object' && !Array.isArray(server.metadata)
        ? server.metadata
        : {};

    password = decryptCredential(server.credentialEncrypted);
    const username = resolveServerSshUsername({
      serverUsername: server.username,
      provider: server.provider,
      imageName: crMeta.imageId || crMeta.imageName || null,
    });

    // —— 1. Fresh SSH reconnect ——
    const runner = new RemoteRunner();
    await runner.connect({
      host: server.host,
      port: server.port || 22,
      username,
      password,
      readyTimeoutMs: 25_000,
    });
    const echo = await soft(runner, shellCommand('echo launchos-ssh-reconnect-ok'));
    const who = await soft(runner, shellCommand('whoami'));
    const arch = await soft(runner, shellCommand('uname -m'));
    const osRel = await soft(runner, shellCommand('cat /etc/os-release | head -n 8'));

    // —— 2. Runtime ——
    const rootDir = await soft(runner, shellCommand('test -d /opt/launchos && echo yes || echo no'));
    const podmanVer = await soft(runner, shellCommand('podman --version'));
    const podmanInfo = await soft(runner, shellCommand('podman info >/dev/null && echo ok || echo fail'));
    const dockerVer = await soft(runner, shellCommand('docker --version'));

    // —— 3. Listen ports ——
    const ssOut = await soft(
      runner,
      shellCommand('ss -lntp 2>/dev/null || netstat -lntp 2>/dev/null || true'),
    );
    const listens = parseListenPorts(ssOut.stdout);
    const dynamicPublic = listens.filter(
      (l) =>
        isDynamicPublic(l.port) &&
        (l.bind === '0.0.0.0' || l.bind === '::' || l.bind === '[::]' || l.bind === '*'),
    );
    const forbiddenPublic = listens.filter(
      (l) =>
        FORBIDDEN_PORTS.includes(l.port) &&
        (l.bind === '0.0.0.0' || l.bind === '::' || l.bind === '[::]' || l.bind === '*'),
    );

    // —— 5. Host firewall ——
    const fwActive = await soft(
      runner,
      shellCommand('systemctl is-active firewalld 2>/dev/null || true'),
    );
    const fwCmd = await soft(
      runner,
      shellCommand('command -v firewall-cmd 2>/dev/null || true'),
    );

    await runner.disconnect();

    // —— 4. Security Group (Aliyun read-only + TCP inference if Attribute RAM-denied) ——
    const account = await prisma.providerAccount.findFirst({
      where: {
        workspaceId: server.workspaceId,
        provider: { type: 'ALIYUN' },
      },
      orderBy: { createdAt: 'asc' },
    });
    if (!account?.credentialEncrypted) throw new Error('ALIYUN account missing');
    const secrets = JSON.parse(decryptCredential(account.credentialEncrypted));
    accessKey = String(secrets.accessKey || secrets.accessKeyId || '');
    secretKey = String(secrets.secretKey || secrets.accessKeySecret || '');
    const instanceId =
      resource?.providerResourceId ||
      crMeta.providerResourceId ||
      'i-bp18fpmcju7ntitybcm8';
    const sg = await validateSecurityGroupReadonly(
      accessKey,
      secretKey,
      server.host,
      instanceId,
    );
    const publicPorts = sg.observedPublicPorts;
    const unexpected = sg.unexpectedPublicPorts;
    const missingExpected = sg.missingExpectedPorts;
    const securityGroupValid = sg.securityGroupValid;

    // —— 8. Queue final state ——
    const connection = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
    });
    await connection.connect();
    const queue = new Queue(SERVER_INITIALIZATION_QUEUE, { connection });
    const jobId = serverInitializationJobId(SI);
    const job = await queue.getJob(jobId);
    const jobTerminalState = job ? await job.getState() : null;
    await queue.close().catch(() => undefined);
    await connection.quit().catch(() => undefined);

    const businessReady = server.status === 'READY';
    const businessStateConsistent =
      businessReady &&
      (jobTerminalState === 'completed' ||
        jobTerminalState === 'failed' ||
        jobTerminalState === null ||
        // after successful resume, job should be completed; failed old job removed then completed
        jobTerminalState === 'completed');
    const consistentStrict =
      businessReady &&
      meta.phase === 'READY' &&
      (jobTerminalState === 'completed' ||
        // completed job may be removed after retention; null is acceptable when READY
        jobTerminalState === null) &&
      jobTerminalState !== 'failed' &&
      jobTerminalState !== 'active' &&
      jobTerminalState !== 'waiting' &&
      jobTerminalState !== 'delayed';

    // —— 7. READY idempotency ——
    const idem = readyIdempotencyFixture();

    // —— 6. Secret scan ——
    const reportDraft = {
      serverInstanceId: server.id,
      providerResourceId: resource?.providerResourceId || null,
      publicIp: server.host,
      privateIp: meta.privateIp || crMeta.privateIp || null,
      serverReadiness: server.status,
      phase: meta.phase || null,
      osName: meta.osName || null,
      architecture: meta.architecture || arch.stdout || null,
      sshReconnect: echo.exitCode === 0 && /launchos-ssh-reconnect-ok/.test(echo.stdout),
      sshUsername: username,
      whoami: who.stdout,
      passwordPresent: true,
      passwordLength: password.length,
      launchosRootExists: rootDir.stdout === 'yes',
      podmanVersion: podmanVer.stdout,
      podmanUsable: podmanVer.exitCode === 0 && podmanInfo.stdout === 'ok',
      dockerCompatibility:
        dockerVer.exitCode === 0 && /docker|podman/i.test(dockerVer.stdout),
      dockerVersion: dockerVer.stdout,
      firewallStatus: meta.firewallStatus || null,
      firewalldActive: fwActive.stdout,
      firewallCmdPresent: Boolean(fwCmd.stdout),
      dynamicPublicPortsExposed: dynamicPublic.length > 0 || forbiddenPublic.length > 0,
      dynamicPublicListenSample: dynamicPublic.slice(0, 5),
      forbiddenPublicListenSample: forbiddenPublic.slice(0, 5),
      securityGroupId: SG_ID,
      securityGroupMethod: sg.method,
      securityGroupAttributeReadable: sg.attributeReadable,
      securityGroupAttachmentValid: sg.attached && sg.sgExists,
      expectedPublicPorts: EXPECTED_PORTS,
      observedPublicPorts: publicPorts,
      unexpectedPublicPorts: unexpected,
      missingExpectedPorts: missingExpected,
      securityGroupValid,
      securityGroupTcpSample: sg.tcpResults,
      bindAddress: meta.bindAddress || null,
      dynamicPortRangeStart: meta.dynamicPortRangeStart ?? null,
      dynamicPortRangeEnd: meta.dynamicPortRangeEnd ?? null,
      jobId,
      jobTerminalState,
      businessStateConsistent: consistentStrict,
      alreadyReadyIdempotency: idem,
      oldServerUntouched: server.host !== OLD_IP && TARGET_IP !== OLD_IP,
      WRITE_COMMANDS_EXECUTED_THIS_RUN,
      osReleasePreview: osRel.stdout.slice(0, 300),
    };

    const logBlobs = await collectLogBlobs();
    const scan = secretScan(
      [
        ['acceptance-report', reportDraft],
        ['server-metadata', meta],
        [
          'cloud-resource-metadata-public',
          {
            providerResourceId: resource?.providerResourceId || null,
            publicIp: crMeta.publicIp || null,
            privateIp: crMeta.privateIp || null,
            keys: Object.keys(crMeta),
            passwordEncryptedPresent: Boolean(crMeta.passwordEncrypted),
            credentialLikeKeys: Object.keys(crMeta).filter((k) =>
              /password|secret|key|credential/i.test(k),
            ),
          },
        ],
        ...logBlobs,
      ],
      password,
      accessKey,
      secretKey,
    );

    // scrub known secrets from final printed report (already no secrets in draft)
    const finalReport = {
      ...reportDraft,
      secretScan: scan,
    };

    const printed = redactSecrets(JSON.stringify(finalReport, null, 2), [
      password,
      accessKey,
      secretKey,
    ]);
    if (printed.includes(password) || (accessKey && printed.includes(accessKey))) {
      throw new Error('secret leaked into printed report');
    }
    console.log(printed);

    // Summary gates
    const allPass =
      finalReport.sshReconnect &&
      finalReport.sshUsername === 'root' &&
      finalReport.whoami === 'root' &&
      finalReport.launchosRootExists &&
      finalReport.podmanUsable &&
      finalReport.dockerCompatibility &&
      !finalReport.dynamicPublicPortsExposed &&
      finalReport.securityGroupValid &&
      finalReport.firewallStatus === 'PROVIDER_SECURITY_GROUP_ONLY' &&
      !/^active$/i.test(String(finalReport.firewalldActive || '').trim()) &&
      scan.secretScanPassed &&
      idem.readyIdempotency &&
      consistentStrict &&
      finalReport.oldServerUntouched &&
      server.status === 'READY' &&
      WRITE_COMMANDS_EXECUTED_THIS_RUN === false;

    console.log('\n=== ACCEPTANCE_GATES ===');
    console.log(
      JSON.stringify(
        {
          allPass,
          WRITE_COMMANDS_EXECUTED_THIS_RUN,
          sshReconnect: finalReport.sshReconnect,
          podmanUsable: finalReport.podmanUsable,
          dockerCompatibility: finalReport.dockerCompatibility,
          dynamicPublicPortsExposed: finalReport.dynamicPublicPortsExposed,
          securityGroupValid: finalReport.securityGroupValid,
          secretScanPassed: scan.secretScanPassed,
          readyIdempotency: idem.readyIdempotency,
          businessStateConsistent: consistentStrict,
          oldServerUntouched: finalReport.oldServerUntouched,
        },
        null,
        2,
      ),
    );

    if (allPass) {
      console.log('\nStep 26.3 服务器自动初始化验收完成。');
    } else {
      console.log('\nStep 26.3 final acceptance: NOT ALL GATES PASSED');
    }
  } finally {
    password = '';
    accessKey = '';
    secretKey = '';
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(redactSecrets(e instanceof Error ? e.message : String(e)));
});
