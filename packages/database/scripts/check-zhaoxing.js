const { PrismaClient } = require('../generated/client');
const p = new PrismaClient();

async function main() {
  const project = await p.project.findUnique({
    where: { id: 'cmu2k41dl0003ri68hbbyud0w' },
    select: {
      id: true,
      name: true,
      framework: true,
      applicationPurpose: true,
      sources: {
        select: {
          url: true,
          branch: true,
          isPrivate: true,
          authStatus: true,
          fullName: true,
        },
      },
      projectAnalyses: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: {
          framework: true,
          confidence: true,
          createdAt: true,
          repositoryPath: true,
        },
      },
      deployments: {
        where: { id: 'cmu2k4ph6000fri68124rf9xs' },
        select: {
          id: true,
          status: true,
          errorMessage: true,
          uploadStatus: true,
          uploadStartedAt: true,
          steps: {
            orderBy: { order: 'asc' },
            select: {
              stepKey: true,
              status: true,
              startedAt: true,
              finishedAt: true,
              errorMessage: true,
            },
          },
          artifacts: {
            orderBy: { createdAt: 'desc' },
            take: 2,
            select: { type: true, size: true, status: true },
          },
        },
      },
    },
  });
  console.log(JSON.stringify(project, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await p.$disconnect();
  });
