import { PrismaClient } from '../generated/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;

  const [userCount, workspaceCount, projectCount, providerCount] = await Promise.all([
    prisma.user.count(),
    prisma.workspace.count(),
    prisma.project.count(),
    prisma.provider.count(),
  ]);

  if (userCount < 1 || workspaceCount < 1 || projectCount < 1 || providerCount < 1) {
    throw new Error(
      `Seed data missing: users=${userCount} workspaces=${workspaceCount} projects=${projectCount} providers=${providerCount}`,
    );
  }

  console.log('Database connection verified');
  console.log(
    JSON.stringify(
      {
        users: userCount,
        workspaces: workspaceCount,
        projects: projectCount,
        providers: providerCount,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
