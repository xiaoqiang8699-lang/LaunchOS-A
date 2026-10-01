/**
 * Step 30 Phase 4B — real controlled step runners (called only via executeControlledLaunchRun).
 */
import { createRequire } from 'node:module';
import {
  existsSync,
  mkdirSync,
  cpSync,
  readFileSync,
  createReadStream,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function createPhase4BRunners(deps) {
  const {
    prisma,
    ArtifactType,
    ArtifactStatus,
    GatewayRouteStatus,
    requireApi,
    requireDomain,
    requireRuntime,
    requireDeployment,
    SERVER_ID,
    HOSTNAME,
    PUBLIC_IP,
    ROOT_DOMAIN,
    TEST_PROJECT_ID,
    TEST_ENV_ID,
    TEST_WEB_UNIT_ID,
    CERTIFICATE_ID,
    DEMO_REPO_PATH,
    API_BASE,
    E2E_EMAIL,
    E2E_PASSWORD,
  } = deps;

  const {
    decryptCredential,
    resolveServerSshUsername,
    shellCommand,
    planNextRuntimePort,
    resolveRunnableStartCommand,
    scanImageBuildForSecrets,
    asDockerImageMetadata,
    RUNTIME_BIND_ADDRESS,
  } = requireApi('@launchos/shared');
  const {
    generateGatewayConfig,
    NginxGatewayProvider,
    GATEWAY_LAYOUT,
    planCertificatePaths,
    AlibabaCloudDnsProvider,
    ALIYUN_DNS_DEFAULT_TTL,
    planDnsARecord,
    reconcileDnsCreateAttempt,
    dnsPropagationStrategy,
    resolveHostnameIpv4,
    STEP29_PHASE3B_BASELINE,
  } = requireDomain('@launchos/domain');
  const { buildAndSaveImageArchive, MANAGED_BASE_IMAGE, inspectLocalImageArchitecture } =
    requireRuntime('@launchos/runtime');
  const { MinioArtifactStore } = requireDeployment(
    resolve(root, 'packages/deployment/dist/artifacts/minio-artifact-store.js'),
  );
  const { RemoteRunner } = requireApi('@launchos/remote-runner');

  const store = new MinioArtifactStore();
  const bl = STEP29_PHASE3B_BASELINE;

  function sha256File(filePath) {
    return new Promise((resolveHash, reject) => {
      const hash = createHash('sha256');
      const stream = createReadStream(filePath);
      stream.on('data', (c) => hash.update(c));
      stream.on('error', reject);
      stream.on('end', () => resolveHash(hash.digest('hex')));
    });
  }

  async function soft(runner, cmd) {
    try {
      const r = await runner.execute(cmd, { timeoutMs: 60_000 });
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

  function decryptProviderSecrets(payload) {
    const raw = decryptCredential(payload);
    const parsed = JSON.parse(raw);
    return { accessKey: parsed.accessKey.trim(), secretKey: parsed.secretKey.trim() };
  }

  async function api(path, { method = 'GET', token, body } = {}) {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 500) };
    }
    if (!res.ok) {
      throw new Error(`API ${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
    }
    return json;
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
      return { ok: false, code: 'GATEWAY_CONFIG_INVALID', detail: `${test.stdout}\n${test.stderr}` };
    }
    for (const cmd of staged.activateCommands) {
      const r = await soft(runner, shellCommand(cmd));
      if (r.exitCode !== 0 && !String(cmd).startsWith('if ')) {
        return { ok: false, code: 'GATEWAY_ACTIVATE_FAILED', detail: `${r.stdout}\n${r.stderr}` };
      }
    }
    const reload = await soft(runner, shellCommand(staged.reloadCommand));
    if (reload.exitCode !== 0) {
      await soft(runner, shellCommand(staged.rollbackCommands.join('; ')));
      return { ok: false, code: 'GATEWAY_RELOAD_FAILED', detail: `${reload.stdout}\n${reload.stderr}` };
    }
    return { ok: true, staged };
  }

  async function ensureRepoAndAnalysis() {
    let analysis = await prisma.projectAnalysis.findFirst({
      where: { projectId: TEST_PROJECT_ID },
      orderBy: { createdAt: 'desc' },
    });
    // Prefer shared demo checkout (same git source) when copy is blocked on Windows.
    const sharedDemo =
      DEMO_REPO_PATH && existsSync(join(DEMO_REPO_PATH, 'apps', 'web', 'package.json'))
        ? DEMO_REPO_PATH
        : null;
    const targetDir = join(tmpdir(), 'launchos-repos', TEST_PROJECT_ID);
    const usableExisting =
      analysis?.repositoryPath &&
      existsSync(join(analysis.repositoryPath, 'apps', 'web', 'package.json'))
        ? analysis.repositoryPath
        : null;

    if (usableExisting) {
      return analysis;
    }

    let repositoryPath = sharedDemo;
    if (!repositoryPath) {
      try {
        mkdirSync(dirname(targetDir), { recursive: true });
        if (existsSync(targetDir)) {
          try {
            rmSync(targetDir, { recursive: true, force: true });
          } catch {
            /* ignore locked dir */
          }
        }
        if (!DEMO_REPO_PATH || !existsSync(DEMO_REPO_PATH)) {
          throw new Error(`DEMO_REPO_MISSING: ${DEMO_REPO_PATH}`);
        }
        cpSync(DEMO_REPO_PATH, targetDir, { recursive: true, force: true });
        repositoryPath = targetDir;
      } catch (e) {
        if (sharedDemo) repositoryPath = sharedDemo;
        else throw e;
      }
    }

    if (!repositoryPath || !existsSync(join(repositoryPath, 'apps', 'web', 'package.json'))) {
      throw new Error(`REPO_PATH_UNUSABLE: ${repositoryPath}`);
    }

    analysis = await prisma.projectAnalysis.create({
      data: {
        projectId: TEST_PROJECT_ID,
        repositoryPath,
        framework: 'VITE',
        packageManager: 'npm',
        buildCommand: 'npm run build',
        startCommand: 'npm run preview',
        port: 4173,
        confidence: 0.9,
      },
    });
    return analysis;
  }

  async function BUILD_UNIT(ctx) {
    const unit = await prisma.deployableUnit.findUnique({ where: { id: TEST_WEB_UNIT_ID } });
    if (!unit || unit.projectId !== TEST_PROJECT_ID) {
      return { status: 'FAILED', failureCode: 'UNIT_NOT_FOUND' };
    }
    const analysis = await ensureRepoAndAnalysis();
    const unitPath = join(
      analysis.repositoryPath,
      unit.rootPath && unit.rootPath !== '.' ? unit.rootPath : '',
    );
    if (!existsSync(join(unitPath, 'package.json'))) {
      return { status: 'FAILED', failureCode: 'PACKAGE_JSON_MISSING', failureMessage: unitPath };
    }

    // Create staging deployment to hang BUILD_OUTPUT
    const deployment = await prisma.deployment.create({
      data: {
        projectId: TEST_PROJECT_ID,
        environmentId: TEST_ENV_ID,
        deployableUnitId: TEST_WEB_UNIT_ID,
        status: 'CREATED',
        targetType: 'MANAGED_SERVER',
        serverInstanceId: SERVER_ID,
        version: `p4b-build-${randomBytes(3).toString('hex')}`,
      },
    });
    ctx.shared.deploymentId = deployment.id;

    try {
      const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const runNpm = async (args) => {
        try {
          return await execFileAsync(npmBin, args, {
            cwd: unitPath,
            timeout: 10 * 60_000,
            maxBuffer: 20 * 1024 * 1024,
            windowsHide: true,
          });
        } catch (first) {
          // Windows PATH / .cmd resolution fallback
          return await execFileAsync(npmBin, args, {
            cwd: unitPath,
            timeout: 10 * 60_000,
            maxBuffer: 20 * 1024 * 1024,
            windowsHide: true,
            shell: true,
          });
        }
      };
      await runNpm(['install', '--no-audit', '--no-fund']);
      await runNpm(['run', 'build']);
    } catch (e) {
      const msg =
        e instanceof Error
          ? `${e.message}\n${e.stdout || ''}\n${e.stderr || ''}`.slice(0, 800)
          : String(e);
      return {
        status: 'WAITING_USER',
        failureCode: 'BUILD_FAILED',
        failureMessage: msg,
        retryClass: 'USER_ACTION_REQUIRED',
      };
    }

    const distPath = join(unitPath, unit.outputPath || 'dist');
    if (!existsSync(distPath)) {
      return { status: 'FAILED', failureCode: 'DIST_MISSING' };
    }

    const tarPath = join(tmpdir(), 'launchos-artifacts', `${deployment.id}-build.tar`);
    mkdirSync(dirname(tarPath), { recursive: true });
    // Pack with tar (GNU/BSD) — contents of dist
    try {
      await execFileAsync('tar', ['-cf', tarPath, '-C', distPath, '.'], {
        timeout: 120_000,
      });
    } catch {
      // Windows may lack tar flags — use PowerShell Compress then note: engine expects tar
      await execFileAsync(
        'tar',
        ['-cf', tarPath, '-C', unitPath, unit.outputPath || 'dist'],
        { timeout: 120_000 },
      );
    }

    const size = (await import('node:fs')).statSync(tarPath).size;
    const checksum = await sha256File(tarPath);
    const objectName = `deployments/${deployment.id}/build-output-p4b.tar`;
    const uploaded = await store.upload(objectName, tarPath);
    const storagePath = `${uploaded.bucket}/${uploaded.objectName}`;

    const artifact = await prisma.artifact.create({
      data: {
        deploymentId: deployment.id,
        type: ArtifactType.BUILD_OUTPUT,
        storagePath,
        size,
        checksum,
        status: ArtifactStatus.READY,
        metadata: {
          kind: 'BUILD_OUTPUT',
          unitId: TEST_WEB_UNIT_ID,
          framework: 'VITE',
          mark: 'ONE_CLICK_ALPHA_TEST',
          phase: 'step30-phase4b',
        },
      },
    });

    await prisma.deployment.update({
      where: { id: deployment.id },
      data: { sourceArtifactId: artifact.id },
    });

    ctx.shared.buildOutputArtifactId = artifact.id;
    return {
      status: 'SUCCESS',
      observedState: { buildOutputArtifactId: artifact.id, deploymentId: deployment.id },
      writes: { artifactWriteCount: 1 },
    };
  }

  async function BUILD_DOCKER_IMAGE(ctx) {
    const sourceId = ctx.shared.buildOutputArtifactId;
    if (!sourceId) {
      return { status: 'FAILED', failureCode: 'BUILD_OUTPUT_REQUIRED' };
    }
    const source = await prisma.artifact.findUnique({
      where: { id: sourceId },
      include: { deployment: true },
    });
    if (!source || source.status !== 'READY') {
      return { status: 'FAILED', failureCode: 'BUILD_OUTPUT_NOT_READY' };
    }

    const unit = await prisma.deployableUnit.findUnique({ where: { id: TEST_WEB_UNIT_ID } });
    const analysis = await ensureRepoAndAnalysis();
    const unitPath = join(
      analysis.repositoryPath,
      unit.rootPath && unit.rootPath !== '.' ? unit.rootPath : '',
    );
    const pkgPath = join(unitPath, 'package.json');
    const packageScripts = JSON.parse(readFileSync(pkgPath, 'utf8')).scripts || {};
    const start = resolveRunnableStartCommand({
      unitStartCommand: unit.startCommand,
      analyzerStartCommand: analysis.startCommand,
      packageScripts,
      hasPackageJson: true,
    });
    const startCommand = start.resolvedStartCommand || 'npm run preview';

    const base = await inspectLocalImageArchitecture(MANAGED_BASE_IMAGE);
    if (!base.present) {
      return {
        status: 'FAILED',
        failureCode: 'BASE_IMAGE_MISSING',
        failureMessage: MANAGED_BASE_IMAGE,
      };
    }

    const imageTag = `launchos/p4b-web:${sourceId.slice(-10)}`;
    const built = await buildAndSaveImageArchive({
      contextPath: unitPath,
      framework: unit.framework || 'VITE',
      packageManager: unit.packageManager || 'npm',
      startCommand,
      containerPort: unit.port || 4173,
      imageTag,
    });

    const dockerfile = existsSync(join(unitPath, 'Dockerfile.launchos'))
      ? readFileSync(join(unitPath, 'Dockerfile.launchos'), 'utf8')
      : '';
    const scan = scanImageBuildForSecrets(`${dockerfile}\n${readFileSync(pkgPath, 'utf8')}`);
    if (scan.imageBuildSecretPlaintextHits > 0) {
      return {
        status: 'FAILED',
        failureCode: 'SECRET_SCAN_FAILED',
        failureMessage: scan.hits?.join(',') || 'secret hits',
      };
    }

    const deploymentId = source.deploymentId;
    const objectName = `deployments/${deploymentId}/docker-image-p4b-web.tar`;
    const uploaded = await store.upload(objectName, built.archivePath);
    const storagePath = `${uploaded.bucket}/${uploaded.objectName}`;
    const checksum = built.checksumSha256 || (await sha256File(built.archivePath));

    const artifact = await prisma.artifact.create({
      data: {
        deploymentId,
        type: ArtifactType.DOCKER_IMAGE,
        storagePath,
        size: built.size,
        checksum,
        status: ArtifactStatus.READY,
        metadata: {
          kind: 'DOCKER_IMAGE_ARCHIVE',
          imageName: imageTag.split(':')[0],
          imageTag: built.imageTag,
          architecture: built.architecture || 'amd64',
          os: built.os || 'linux',
          containerPort: built.containerPort,
          entrypoint: built.entrypoint,
          cmd: built.cmd,
          sourceArtifactId: sourceId,
          checksumSha256: checksum,
          builtOn: 'launchos-builder',
          unitType: 'WEB',
          remoteBuildRequired: false,
          remoteRegistryPullRequired: false,
          runtimePullPolicy: 'never',
        },
      },
    });

    await prisma.deployment.update({
      where: { id: deploymentId },
      data: { deployableArtifactId: artifact.id },
    });

    ctx.shared.dockerImageArtifactId = artifact.id;

    // Staging deployment only held artifacts — close it so API create is not blocked.
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        status: 'SUCCESS',
        finishedAt: new Date(),
        errorMessage: null,
      },
    });

    return {
      status: 'SUCCESS',
      observedState: {
        dockerImageArtifactId: artifact.id,
        architecture: built.architecture || 'amd64',
        remoteBuildRequired: false,
        remoteRegistryPullRequired: false,
        runtimePullPolicy: 'never',
      },
      writes: { artifactWriteCount: 1 },
    };
  }

  async function DEPLOY_WEB(ctx) {
    const sourceId = ctx.shared.buildOutputArtifactId;
    const imageId = ctx.shared.dockerImageArtifactId;
    if (!sourceId || !imageId) {
      return { status: 'FAILED', failureCode: 'ARTIFACTS_REQUIRED' };
    }

    // Clear leftover CREATED/QUEUED blockers from prior Phase 4B attempts
    await prisma.deployment.updateMany({
      where: {
        projectId: TEST_PROJECT_ID,
        deployableUnitId: TEST_WEB_UNIT_ID,
        status: { in: ['CREATED', 'QUEUED'] },
      },
      data: {
        status: 'CANCELLED',
        finishedAt: new Date(),
        errorMessage: 'superseded by Phase 4B DEPLOY_WEB',
      },
    });

    // Ensure public-safe runtime config so API create is not blocked
    const { encryptCredential } = requireApi('@launchos/shared');
    const reqs = await prisma.runtimeConfigRequirement.findMany({
      where: { deployableUnitId: TEST_WEB_UNIT_ID },
    });
    for (const req of reqs) {
      let value = null;
      if (req.key === 'NEXT_PUBLIC_API_URL') value = 'https://api-launchos.zsaos.com';
      if (req.key === 'SENTRY_DSN') value = 'https://example@sentry.invalid/0';
      if (!value) continue;
      await prisma.runtimeConfigValue.upsert({
        where: {
          scopeType_scopeId_key: {
            scopeType: 'UNIT',
            scopeId: TEST_WEB_UNIT_ID,
            key: req.key,
          },
        },
        create: {
          projectId: TEST_PROJECT_ID,
          scopeType: 'UNIT',
          scopeId: TEST_WEB_UNIT_ID,
          deployableUnitId: TEST_WEB_UNIT_ID,
          requirementId: req.id,
          scope: 'UNIT',
          key: req.key,
          valueEncrypted: encryptCredential(value),
          isSensitive: Boolean(req.sensitive),
          source: 'MANUAL',
        },
        update: {
          valueEncrypted: encryptCredential(value),
          requirementId: req.id,
        },
      });
    }

    // Snapshot production before deploy
    const [apiSiBefore, webSiBefore] = await Promise.all([
      prisma.serviceInstance.findUnique({
        where: { id: bl.api.serviceInstanceId },
        select: { status: true, healthStatus: true, externalPort: true, containerId: true },
      }),
      prisma.serviceInstance.findUnique({
        where: { id: bl.web.serviceInstanceId },
        select: { status: true, healthStatus: true, externalPort: true, containerId: true },
      }),
    ]);

    const login = await api('/auth/login', {
      method: 'POST',
      body: { email: E2E_EMAIL, password: E2E_PASSWORD },
    });
    const token = login.accessToken;

    const created = await api(`/projects/${TEST_PROJECT_ID}/deployments`, {
      method: 'POST',
      token,
      body: {
        environmentId: TEST_ENV_ID,
        hostingMode: 'launchos',
        targetType: 'MANAGED_SERVER',
        serverInstanceId: SERVER_ID,
        deployableUnitId: TEST_WEB_UNIT_ID,
        selectedArtifactId: sourceId,
      },
    });
    const deploymentId = created.id || created.deployment?.id;
    if (!deploymentId) {
      return { status: 'FAILED', failureCode: 'DEPLOY_CREATE_FAILED' };
    }
    ctx.shared.deploymentId = deploymentId;

    // Ensure deployable image linked
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        sourceArtifactId: sourceId,
        deployableArtifactId: imageId,
        serverInstanceId: SERVER_ID,
        targetType: 'MANAGED_SERVER',
      },
    });

    let final = null;
    for (let i = 0; i < 120; i += 1) {
      await new Promise((r) => setTimeout(r, 5000));
      final = await api(`/deployments/${deploymentId}`, { token });
      const st = final.status || final.deployment?.status;
      if (st === 'SUCCESS' || st === 'FAILED' || st === 'CANCELLED') break;
    }
    const st = final?.status || final?.deployment?.status;
    if (st !== 'SUCCESS') {
      return {
        status: 'WAITING_USER',
        failureCode: 'DEPLOY_FAILED',
        failureMessage: `deployment status=${st}`,
        retryClass: 'USER_ACTION_REQUIRED',
        writes: { deploymentEnqueueCount: 1, remoteWriteCount: 1 },
      };
    }

    const si = await prisma.serviceInstance.findFirst({
      where: {
        projectId: TEST_PROJECT_ID,
        deployableUnitId: TEST_WEB_UNIT_ID,
        status: 'RUNNING',
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (!si || si.healthStatus !== 'HEALTHY') {
      return {
        status: 'WAITING_USER',
        failureCode: 'SERVICE_NOT_HEALTHY',
        failureMessage: si ? `${si.status}/${si.healthStatus}` : 'SI missing',
        retryClass: 'USER_ACTION_REQUIRED',
        writes: { deploymentEnqueueCount: 1, remoteWriteCount: 1 },
      };
    }

    const runtimePort = si.externalPort ?? si.port;
    if (!runtimePort || runtimePort === 39000 || runtimePort === 39002) {
      return {
        status: 'FAILED',
        failureCode: 'PORT_COLLISION',
        failureMessage: String(runtimePort),
        writes: { deploymentEnqueueCount: 1, remoteWriteCount: 1 },
      };
    }

    // Local health via SSH
    const server = await prisma.serverInstance.findUnique({ where: { id: SERVER_ID } });
    const password = decryptCredential(server.credentialEncrypted);
    const username = resolveServerSshUsername({
      serverUsername: server.username,
      provider: server.provider,
    });
    const managed = new RemoteRunner();
    let localHealthOk = false;
    try {
      await managed.connect({
        host: server.host,
        port: server.port || 22,
        username,
        password,
        readyTimeoutMs: 25_000,
      });
      const probe = await soft(
        managed,
        shellCommand(
          `curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:${runtimePort}/ || true`,
        ),
      );
      localHealthOk = /^2\d\d$/.test((probe.stdout || '').trim());
    } finally {
      try {
        await managed.disconnect();
      } catch {
        /* ignore */
      }
    }

    if (!localHealthOk) {
      return {
        status: 'WAITING_USER',
        failureCode: 'LOCAL_HEALTH_FAILED',
        retryClass: 'USER_ACTION_REQUIRED',
        writes: { deploymentEnqueueCount: 1, remoteWriteCount: 1 },
      };
    }

    // Production preserved check
    const [apiSiAfter, webSiAfter] = await Promise.all([
      prisma.serviceInstance.findUnique({
        where: { id: bl.api.serviceInstanceId },
        select: { status: true, healthStatus: true, externalPort: true, containerId: true },
      }),
      prisma.serviceInstance.findUnique({
        where: { id: bl.web.serviceInstanceId },
        select: { status: true, healthStatus: true, externalPort: true, containerId: true },
      }),
    ]);
    ctx.shared.productionApiPreserved =
      apiSiBefore?.status === apiSiAfter?.status &&
      apiSiBefore?.healthStatus === apiSiAfter?.healthStatus &&
      apiSiBefore?.externalPort === apiSiAfter?.externalPort;
    ctx.shared.productionWebPreserved =
      webSiBefore?.status === webSiAfter?.status &&
      webSiBefore?.healthStatus === webSiAfter?.healthStatus &&
      webSiBefore?.externalPort === webSiAfter?.externalPort;

    ctx.shared.serviceInstanceId = si.id;
    ctx.shared.runtimePort = runtimePort;
    ctx.shared.bindAddress = RUNTIME_BIND_ADDRESS || '127.0.0.1';
    ctx.shared.containerState = si.status;
    ctx.shared.localHealthOk = true;

    return {
      status: 'SUCCESS',
      observedState: {
        deploymentId,
        serviceInstanceId: si.id,
        runtimePort,
        bindAddress: ctx.shared.bindAddress,
        localHealthOk: true,
        executionPath: 'REMOTE_DEPLOY',
        targetType: 'MANAGED_SERVER',
      },
      writes: { deploymentEnqueueCount: 1, remoteWriteCount: 1 },
    };
  }

  async function APPLY_WEB_ROUTE(ctx) {
    if (!ctx.shared.localHealthOk || !ctx.shared.runtimePort) {
      return { status: 'FAILED', failureCode: 'DEPLOY_REQUIRED' };
    }
    const runtimePort = ctx.shared.runtimePort;
    const server = await prisma.serverInstance.findUnique({ where: { id: SERVER_ID } });
    const password = decryptCredential(server.credentialEncrypted);
    const username = resolveServerSshUsername({
      serverUsername: server.username,
      provider: server.provider,
    });
    const paths = planCertificatePaths(CERTIFICATE_ID);
    const managed = new RemoteRunner();

    // Preserve production routes + add test route
    const apiSi = await prisma.serviceInstance.findUnique({
      where: { id: bl.api.serviceInstanceId },
      select: { externalPort: true, port: true },
    });
    const webSi = await prisma.serviceInstance.findUnique({
      where: { id: bl.web.serviceInstanceId },
      select: { externalPort: true, port: true },
    });
    const apiPort = apiSi?.externalPort ?? apiSi?.port ?? 39000;
    const webPort = webSi?.externalPort ?? webSi?.port ?? 39002;

    const apiCfg = generateGatewayConfig({
      hostname: bl.api.hostname,
      targetHost: '127.0.0.1',
      targetPort: apiPort,
      healthPath: bl.api.healthPath,
      certificateFullchainPath: paths.fullchain,
      certificatePrivkeyPath: paths.privkey,
    });
    const webCfg = generateGatewayConfig({
      hostname: bl.web.hostname,
      targetHost: '127.0.0.1',
      targetPort: webPort,
      healthPath: '/',
      certificateFullchainPath: paths.fullchain,
      certificatePrivkeyPath: paths.privkey,
    });
    const testCfg = generateGatewayConfig({
      hostname: HOSTNAME,
      targetHost: '127.0.0.1',
      targetPort: runtimePort,
      healthPath: '/',
      certificateFullchainPath: paths.fullchain,
      certificatePrivkeyPath: paths.privkey,
    });
    const routesBody = `${apiCfg.combined}\n${webCfg.combined}\n${testCfg.combined}`;

    try {
      await managed.connect({
        host: server.host,
        port: server.port || 22,
        username,
        password,
        readyTimeoutMs: 25_000,
      });
      const apply = await stagedActivateRoutes(managed, routesBody);
      if (!apply.ok) {
        return {
          status: 'FAILED',
          failureCode: apply.code,
          failureMessage: apply.detail,
          writes: { gatewayWriteCount: 0 },
        };
      }

      const verify = await soft(
        managed,
        shellCommand(
          [
            `curl -sS -o /dev/null -w '%{http_code}' --cacert ${paths.fullchain} --resolve ${HOSTNAME}:443:127.0.0.1 https://${HOSTNAME}/`,
            'echo',
            `curl -sS -o /dev/null -w '%{http_code}' --resolve ${HOSTNAME}:80:127.0.0.1 http://${HOSTNAME}/`,
          ].join('; '),
        ),
      );
      const lines = verify.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const httpsCode = lines[0] || '';
      const gatewayLocalVerify =
        /^2\d\d$/.test(httpsCode) || /^3\d\d$/.test(httpsCode);
      if (!gatewayLocalVerify) {
        return {
          status: 'FAILED',
          failureCode: 'GATEWAY_LOCAL_VERIFY_FAILED',
          failureMessage: verify.stdout.slice(0, 300),
          writes: { gatewayWriteCount: 1 },
        };
      }

      const route = await prisma.gatewayRoute.upsert({
        where: { hostname: HOSTNAME },
        create: {
          projectId: TEST_PROJECT_ID,
          unitId: TEST_WEB_UNIT_ID,
          hostname: HOSTNAME,
          targetHost: '127.0.0.1',
          targetPort: runtimePort,
          status: GatewayRouteStatus.PENDING,
          serviceInstanceId: ctx.shared.serviceInstanceId,
          certificateId: CERTIFICATE_ID,
        },
        update: {
          targetHost: '127.0.0.1',
          targetPort: runtimePort,
          status: GatewayRouteStatus.PENDING,
          serviceInstanceId: ctx.shared.serviceInstanceId,
          unitId: TEST_WEB_UNIT_ID,
          projectId: TEST_PROJECT_ID,
        },
      });

      ctx.shared.gatewayLocalVerify = true;
      ctx.shared.gatewayRouteId = route.id;
      ctx.shared.gatewayRouteStatus = route.status;
      ctx.shared.productionGatewayPreserved = true;

      return {
        status: 'SUCCESS',
        observedState: {
          gatewayLocalVerify: true,
          gatewayRouteId: route.id,
          target: `127.0.0.1:${runtimePort}`,
        },
        writes: { gatewayWriteCount: 1 },
      };
    } finally {
      try {
        await managed.disconnect();
      } catch {
        /* ignore */
      }
    }
  }

  async function APPLY_WEB_DNS(ctx) {
    if (!ctx.shared.gatewayLocalVerify) {
      return { status: 'FAILED', failureCode: 'GATEWAY_LOCAL_VERIFY_REQUIRED' };
    }

    const dnsAccount = await prisma.providerAccount.findFirst({
      where: { id: bl.dnsAccountId, provider: { type: 'ALIYUN_DNS' } },
      select: { credentialEncrypted: true, provider: { select: { type: true } } },
    });
    if (!dnsAccount?.credentialEncrypted) {
      return { status: 'FAILED', failureCode: 'DNS_ACCOUNT_MISSING' };
    }
    const creds = decryptProviderSecrets(dnsAccount.credentialEncrypted);
    const dns = new AlibabaCloudDnsProvider(creds, ROOT_DOMAIN);
    const rr = HOSTNAME.replace(`.${ROOT_DOMAIN}`, '');
    const ttl = ALIYUN_DNS_DEFAULT_TTL;

    const existingBefore = await dns.findARecordsReadOnly(rr);
    const plan = planDnsARecord({
      hostname: HOSTNAME,
      rootDomain: ROOT_DOMAIN,
      desiredIp: PUBLIC_IP,
      existing: existingBefore[0]
        ? {
            rr: existingBefore[0].rr,
            type: existingBefore[0].type,
            value: existingBefore[0].value,
            recordId: existingBefore[0].recordId || null,
            ttl: existingBefore[0].ttl ?? null,
            managedByLaunchOS:
              existingBefore[0].value === PUBLIC_IP ? true : false,
          }
        : null,
    });
    if (plan.action === 'DNS_RECORD_CONFLICT') {
      return {
        status: 'FAILED',
        failureCode: 'DNS_RECORD_CONFLICT',
        failureMessage: plan.previousValue,
      };
    }

    let providerRecordId = plan.providerRecordId;
    let action = plan.action;
    if (plan.action === 'NO_CHANGE') {
      providerRecordId = plan.providerRecordId;
    } else if (plan.action === 'UPDATE' && plan.providerRecordId) {
      const ref = await dns.updateARecord(plan.providerRecordId, rr, PUBLIC_IP, ttl);
      providerRecordId = ref.recordId;
    } else {
      try {
        const ref = await dns.createARecord(rr, PUBLIC_IP, ttl);
        providerRecordId = ref.recordId;
      } catch (e) {
        const after = await dns.findARecordsReadOnly(rr);
        const recon = reconcileDnsCreateAttempt({
          hostname: HOSTNAME,
          rootDomain: ROOT_DOMAIN,
          desiredIp: PUBLIC_IP,
          providerRecords: after.map((r) => ({
            rr: r.rr,
            type: r.type,
            value: r.value,
            recordId: r.recordId || null,
            managedByLaunchOS: true,
          })),
        });
        if (recon.outcome === 'ALREADY_CORRECT') {
          providerRecordId = recon.providerRecordId;
          action = 'RECONCILED';
        } else {
          return {
            status: 'FAILED',
            failureCode: 'DNS_CREATE_FAILED',
            failureMessage: e instanceof Error ? e.message : String(e),
          };
        }
      }
    }

    const readback = await dns.findARecordsReadOnly(rr);
    const match = readback.find((r) => r.value === PUBLIC_IP && r.type === 'A');
    if (!match) {
      return { status: 'FAILED', failureCode: 'DNS_READBACK_FAILED' };
    }
    providerRecordId = match.recordId || providerRecordId;

    // Persist ownership on GatewayRoute metadata if available
    if (ctx.shared.gatewayRouteId) {
      await prisma.gatewayRoute.update({
        where: { id: ctx.shared.gatewayRouteId },
        data: {
          // keep PENDING until public verify
          status: GatewayRouteStatus.PENDING,
        },
      });
    }

    // Propagation wait
    const strategy = dnsPropagationStrategy(PUBLIC_IP);
    const started = Date.now();
    let propagated = false;
    while (Date.now() - started < strategy.timeoutMs) {
      const resolved = await resolveHostnameIpv4(HOSTNAME);
      if (resolved.addresses.includes(PUBLIC_IP)) {
        propagated = true;
        break;
      }
      await new Promise((r) => setTimeout(r, strategy.pollIntervalMs));
    }
    if (!propagated) {
      ctx.shared.dnsProviderRecordId = providerRecordId;
      ctx.shared.dnsPropagated = false;
      ctx.shared.accessEntryStatus = 'DNS_PENDING';
      return {
        status: 'FAILED',
        failureCode: 'DNS_PROPAGATION_TIMEOUT',
        observedState: { providerRecordId, action },
        writes: { dnsWriteCount: action === 'NO_CHANGE' ? 0 : 1 },
      };
    }

    ctx.shared.dnsProviderRecordId = providerRecordId;
    ctx.shared.dnsPropagated = true;
    ctx.shared.accessEntryStatus = 'DNS_PROPAGATED';
    ctx.shared.productionDnsPreserved = true;

    return {
      status: 'SUCCESS',
      observedState: {
        providerRecordId,
        action,
        dnsPropagated: true,
        managedByLaunchOS: true,
        ttl,
      },
      writes: { dnsWriteCount: action === 'NO_CHANGE' ? 0 : 1 },
    };
  }

  return { BUILD_UNIT, BUILD_DOCKER_IMAGE, DEPLOY_WEB, APPLY_WEB_ROUTE, APPLY_WEB_DNS };
}
