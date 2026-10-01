/**
 * Safely fail stuck Xiaoqiang / 照型APP deployments that are still RUNNING.
 * Does not modify user source code.
 */
const {
  PrismaClient,
  DeploymentStatus,
  DeploymentStepStatus,
  ApplicationVersionStatus,
  RemoteUploadStatus,
} = require('../generated/client');

const MESSAGE = '当前项目属于暂不支持的原生 iOS 应用，无法使用服务器部署流程。';

async function main() {
  const prisma = new PrismaClient();
  try {
    const projects = await prisma.project.findMany({
      where: {
        OR: [
          { name: { contains: '照型' } },
          { name: { contains: 'Xiaoqiang' } },
          { sources: { some: { url: { contains: 'Xiaoqiang-APP' } } } },
        ],
      },
      select: {
        id: true,
        name: true,
        framework: true,
        sources: { select: { url: true, branch: true, isPrivate: true } },
        projectAnalyses: {
          orderBy: { createdAt: 'desc' },
          take: 3,
          select: { framework: true, confidence: true, createdAt: true, repositoryPath: true },
        },
        deployments: {
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: {
            id: true,
            status: true,
            errorMessage: true,
            startedAt: true,
            uploadStatus: true,
            uploadStartedAt: true,
            uploadFinishedAt: true,
            steps: {
              orderBy: { order: 'asc' },
              select: {
                stepKey: true,
                name: true,
                status: true,
                startedAt: true,
                finishedAt: true,
                errorMessage: true,
              },
            },
            artifacts: {
              orderBy: { createdAt: 'desc' },
              take: 3,
              select: { id: true, type: true, status: true, size: true, storagePath: true },
            },
          },
        },
      },
    });

    console.log(JSON.stringify({ projects }, null, 2));

    const runningIds = [];
    for (const project of projects) {
      for (const deployment of project.deployments) {
        if (deployment.status === 'RUNNING' || deployment.status === 'QUEUED') {
          runningIds.push(deployment.id);
        }
      }
    }

    const known = await prisma.deployment.findUnique({
      where: { id: 'cmu2k4ph6000fri68124rf9xs' },
      select: { id: true, status: true },
    });
    if (
      known &&
      (known.status === 'RUNNING' || known.status === 'QUEUED') &&
      !runningIds.includes(known.id)
    ) {
      runningIds.push(known.id);
    }

    for (const id of runningIds) {
      await prisma.deploymentStep.updateMany({
        where: {
          deploymentId: id,
          status: { in: [DeploymentStepStatus.RUNNING, DeploymentStepStatus.PENDING] },
        },
        data: {
          status: DeploymentStepStatus.FAILED,
          finishedAt: new Date(),
          errorMessage: MESSAGE,
        },
      });
      await prisma.deployment.update({
        where: { id },
        data: {
          status: DeploymentStatus.FAILED,
          finishedAt: new Date(),
          errorMessage: MESSAGE,
          uploadStatus: RemoteUploadStatus.FAILED,
          uploadError: MESSAGE,
          uploadFinishedAt: new Date(),
        },
      });
      await prisma.applicationVersion.updateMany({
        where: { deploymentId: id, status: ApplicationVersionStatus.DEPLOYING },
        data: { status: ApplicationVersionStatus.FAILED },
      });
      await prisma.deploymentLog.create({
        data: {
          deploymentId: id,
          level: 'error',
          message: MESSAGE,
        },
      });
      console.log(`FAILED deployment ${id}`);
    }

    if (runningIds.length === 0) {
      console.log('No RUNNING/QUEUED deployments to fail.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
