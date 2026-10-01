import { PrismaClient, WorkspaceRole } from '../generated/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  await prisma.cloudPlan.upsert({
    where: { name: 'Starter' },
    update: {
      cpu: 1,
      memory: '1GB',
      storage: '10GB',
      database: 'none',
      description: 'Minimal Node.js runtime for simple apps without a database.',
    },
    create: {
      id: 'cloudplan_starter',
      name: 'Starter',
      cpu: 1,
      memory: '1GB',
      storage: '10GB',
      database: 'none',
      description: 'Minimal Node.js runtime for simple apps without a database.',
    },
  });
  await prisma.cloudPlan.upsert({
    where: { name: 'Standard' },
    update: {
      cpu: 2,
      memory: '4GB',
      storage: '40GB',
      database: 'PostgreSQL',
      description: 'Application runtime plus PostgreSQL for projects that persist data.',
    },
    create: {
      id: 'cloudplan_standard',
      name: 'Standard',
      cpu: 2,
      memory: '4GB',
      storage: '40GB',
      database: 'PostgreSQL',
      description: 'Application runtime plus PostgreSQL for projects that persist data.',
    },
  });
  await prisma.cloudPlan.upsert({
    where: { name: 'Production' },
    update: {
      cpu: 4,
      memory: '8GB',
      storage: '80GB',
      database: 'PostgreSQL + Redis',
      description: 'Higher capacity runtime with PostgreSQL and Redis for complex workloads.',
    },
    create: {
      id: 'cloudplan_production',
      name: 'Production',
      cpu: 4,
      memory: '8GB',
      storage: '80GB',
      database: 'PostgreSQL + Redis',
      description: 'Higher capacity runtime with PostgreSQL and Redis for complex workloads.',
    },
  });

  const provider = await prisma.provider.upsert({
    where: { type: 'MOCK' },
    update: { name: 'Mock Provider' },
    create: {
      name: 'Mock Provider',
      type: 'MOCK',
    },
  });

  await prisma.provider.upsert({
    where: { type: 'ALIYUN' },
    update: { name: 'Alibaba Cloud' },
    create: {
      name: 'Alibaba Cloud',
      type: 'ALIYUN',
    },
  });

  await prisma.provider.upsert({
    where: { type: 'ALIYUN_DNS' },
    update: { name: 'Alibaba Cloud DNS' },
    create: {
      name: 'Alibaba Cloud DNS',
      type: 'ALIYUN_DNS',
    },
  });

  const user = await prisma.user.upsert({
    where: { email: 'demo@launchos.dev' },
    update: {
      name: 'Demo User',
    },
    create: {
      email: 'demo@launchos.dev',
      name: 'Demo User',
      passwordHash: 'seed_password_hash_not_used_for_auth',
    },
  });

  const workspace =
    (await prisma.workspace.findFirst({
      where: { ownerId: user.id, name: 'Demo Workspace' },
    })) ??
    (await prisma.workspace.create({
      data: {
        name: 'Demo Workspace',
        ownerId: user.id,
      },
    }));

  await prisma.workspaceMember.upsert({
    where: {
      workspaceId_userId: {
        workspaceId: workspace.id,
        userId: user.id,
      },
    },
    update: {
      role: WorkspaceRole.OWNER,
    },
    create: {
      workspaceId: workspace.id,
      userId: user.id,
      role: WorkspaceRole.OWNER,
    },
  });

  const project = await prisma.project.upsert({
    where: {
      workspaceId_slug: {
        workspaceId: workspace.id,
        slug: 'demo-app',
      },
    },
    update: {
      name: 'Demo App',
      description: 'LaunchOS seed project',
      sourceType: 'git',
      projectType: 'WEB',
      status: 'ACTIVE',
    },
    create: {
      workspaceId: workspace.id,
      name: 'Demo App',
      slug: 'demo-app',
      description: 'LaunchOS seed project',
      sourceType: 'git',
      sourceUrl: 'https://example.com/demo-app.git',
      projectType: 'WEB',
      status: 'ACTIVE',
    },
  });

  console.log('LaunchOS database seed completed');
  console.log(
    JSON.stringify(
      {
        user: { id: user.id, email: user.email },
        workspace: { id: workspace.id, name: workspace.name },
        project: { id: project.id, slug: project.slug },
        provider: { id: provider.id, type: provider.type },
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
