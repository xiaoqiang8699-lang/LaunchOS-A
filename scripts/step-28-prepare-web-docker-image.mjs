/**
 * Step 28 — Build Web Unit DOCKER_IMAGE archive on LaunchOS builder.
 * Does NOT SSH to managed ECS. Does NOT --confirm-deploy.
 *
 *   node scripts/step-28-prepare-web-docker-image.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

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

const PROJECT_ID = 'cmu3j24mv0001ri7wcsoa30hj';
const UNIT_ID = 'cmu3j27340007ri7wcno1xrai';
const SOURCE_ARTIFACT_ID =
  process.argv.find((a) => a.startsWith('--source-artifact-id='))?.slice('--source-artifact-id='.length) ||
  'cmu3scwr3016fri3c35ryb3y2';

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const requireRuntime = createRequire(resolve(root, 'packages/runtime/package.json'));
const requireDeployment = createRequire(resolve(root, 'packages/deployment/package.json'));
const { PrismaClient, ArtifactType, ArtifactStatus } = requireApi('@launchos/database');
const {
  buildAndSaveImageArchive,
  inspectLocalImageArchitecture,
  MANAGED_BASE_IMAGE,
} = requireRuntime('@launchos/runtime');
const {
  resolveRunnableStartCommand,
  scanImageBuildForSecrets,
  asDockerImageMetadata,
  STEP28_MULTI_UNIT_DEPLOY_WHITELIST,
} = requireApi('@launchos/shared');
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

async function main() {
  const prisma = new PrismaClient();
  const store = new MinioArtifactStore();

  try {
    if (UNIT_ID !== STEP28_MULTI_UNIT_DEPLOY_WHITELIST.webUnitId) {
      throw new Error('web unit not in Step 28 whitelist');
    }

    const source = await prisma.artifact.findUnique({
      where: { id: SOURCE_ARTIFACT_ID },
      select: {
        id: true,
        deploymentId: true,
        type: true,
        status: true,
        size: true,
        deployment: { select: { deployableUnitId: true, projectId: true } },
      },
    });
    if (
      !source ||
      source.type !== 'BUILD_OUTPUT' ||
      source.status !== 'READY' ||
      source.deployment?.deployableUnitId !== UNIT_ID ||
      source.deployment?.projectId !== PROJECT_ID
    ) {
      throw new Error(`Web BUILD_OUTPUT missing/invalid: ${SOURCE_ARTIFACT_ID}`);
    }

    const existing = await prisma.artifact.findFirst({
      where: {
        type: ArtifactType.DOCKER_IMAGE,
        status: ArtifactStatus.READY,
        size: { gt: 0 },
        deployment: { projectId: PROJECT_ID, deployableUnitId: UNIT_ID },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (
      existing &&
      asDockerImageMetadata(existing.metadata)?.sourceArtifactId === SOURCE_ARTIFACT_ID
    ) {
      console.log(
        JSON.stringify(
          {
            reused: true,
            unitId: UNIT_ID,
            unitType: 'WEB',
            sourceArtifactId: SOURCE_ARTIFACT_ID,
            deployableArtifactId: existing.id,
            size: existing.size,
            checksum: existing.checksum,
            metadata: existing.metadata,
            remoteBuildRequired: false,
            remoteRegistryPullRequired: false,
            runtimePullPolicy: 'never',
            WRITE_COMMANDS_EXECUTED_THIS_RUN: false,
            remoteEcsWrite: false,
          },
          null,
          2,
        ),
      );
      return;
    }

    const unit = await prisma.deployableUnit.findUnique({
      where: { id: UNIT_ID },
      select: {
        rootPath: true,
        startCommand: true,
        port: true,
        framework: true,
        packageManager: true,
        type: true,
      },
    });
    const analysis = await prisma.projectAnalysis.findFirst({
      where: { projectId: PROJECT_ID },
      orderBy: { createdAt: 'desc' },
      select: {
        repositoryPath: true,
        startCommand: true,
        framework: true,
        packageManager: true,
        port: true,
      },
    });
    if (!unit || unit.type !== 'WEB' || !analysis?.repositoryPath) {
      throw new Error('web unit/analysis missing');
    }

    const unitPath = join(
      analysis.repositoryPath,
      unit.rootPath && unit.rootPath !== '.' ? unit.rootPath : '',
    );
    const pkgPath = join(unitPath, 'package.json');
    if (!existsSync(pkgPath)) throw new Error(`package.json missing at ${unitPath}`);
    const packageScripts = JSON.parse(readFileSync(pkgPath, 'utf8')).scripts || {};
    const start = resolveRunnableStartCommand({
      unitStartCommand: unit.startCommand,
      analyzerStartCommand: analysis.startCommand,
      packageScripts,
      hasPackageJson: true,
    });
    // Vite archives embed CMD via serve; still record resolved script for audit.
    const startCommand = start.resolvedStartCommand || 'npm run preview';

    const base = await inspectLocalImageArchitecture(MANAGED_BASE_IMAGE);
    if (!base.present) {
      throw new Error(`BASE_IMAGE_MISSING: ${MANAGED_BASE_IMAGE}`);
    }

    const imageTag = `launchos/step28-web:${SOURCE_ARTIFACT_ID.slice(-10)}`;
    const built = await buildAndSaveImageArchive({
      contextPath: unitPath,
      framework: unit.framework || 'VITE',
      packageManager: unit.packageManager || analysis.packageManager,
      startCommand,
      containerPort: unit.port || 4173,
      imageTag,
    });

    const dockerfile = readFileSync(join(unitPath, 'Dockerfile.launchos'), 'utf8');
    const scan = scanImageBuildForSecrets(`${dockerfile}\n${readFileSync(pkgPath, 'utf8')}`);
    if (scan.imageBuildSecretPlaintextHits > 0) {
      throw new Error(`secret hits: ${scan.hits.join(',')}`);
    }

    const objectName = `deployments/${source.deploymentId}/docker-image-step28-web.tar`;
    const uploaded = await store.upload(objectName, built.archivePath);
    const storagePath = `${uploaded.bucket}/${uploaded.objectName}`;
    const checksum = built.checksumSha256 || (await sha256File(built.archivePath));

    const artifact = await prisma.artifact.create({
      data: {
        deploymentId: source.deploymentId,
        type: ArtifactType.DOCKER_IMAGE,
        storagePath,
        size: built.size,
        checksum,
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
          sourceArtifactId: SOURCE_ARTIFACT_ID,
          checksumSha256: checksum,
          builtOn: 'launchos-builder',
          unitType: 'WEB',
        },
      },
    });

    console.log(
      JSON.stringify(
        {
          reused: false,
          unitId: UNIT_ID,
          unitType: 'WEB',
          sourceArtifactId: SOURCE_ARTIFACT_ID,
          deployableArtifactId: artifact.id,
          deployableArtifactType: 'DOCKER_IMAGE',
          size: artifact.size,
          checksum: artifact.checksum,
          architecture: built.architecture,
          containerPort: built.containerPort,
          imageTag: built.imageTag,
          imageBuildSecretPlaintextHits: scan.imageBuildSecretPlaintextHits,
          builderBaseImage: MANAGED_BASE_IMAGE,
          builderBasePresent: true,
          remoteBuildRequired: false,
          remoteRegistryPullRequired: false,
          runtimePullPolicy: 'never',
          WRITE_COMMANDS_EXECUTED_THIS_RUN: false,
          remoteEcsWrite: false,
          minioUploaded: true,
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
