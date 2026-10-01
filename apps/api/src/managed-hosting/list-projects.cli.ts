import { resolve } from 'node:path';
import { config } from 'dotenv';
import { PrismaClient } from '@launchos/database';

config({ path: resolve(process.cwd(), '.env') });
config({ path: resolve(process.cwd(), '../../.env') });

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const deployment = await prisma.deployment.findUnique({
    where: { id: 'cmumbgdf40011riq8m94567y6' },
    select: {
      id: true,
      status: true,
      createdAt: true,
      startedAt: true,
      finishedAt: true,
      projectId: true,
      serverInstanceId: true,
      bullmqJobId: true,
    },
  });
  const server = deployment?.serverInstanceId
    ? await prisma.serverInstance.findUnique({
        where: { id: deployment.serverInstanceId },
        select: {
          host: true,
          scope: true,
          workspaceId: true,
          status: true,
          dockerStatus: true,
        },
      })
    : null;
  const instance = await prisma.serviceInstance.findFirst({
    where: { projectId: 'cmumbbn080003riq8e9j9cogm' },
    orderBy: { createdAt: 'desc' },
    select: {
      status: true,
      healthStatus: true,
      externalPort: true,
      internalPort: true,
      containerId: true,
    },
  });
  const domain = await prisma.applicationDomain.findFirst({
    where: { projectId: 'cmumbbn080003riq8e9j9cogm' },
    select: { domain: true, status: true, dnsStatus: true, sslStatus: true, runtimeHost: true, runtimePort: true },
  });
  console.log(JSON.stringify({ deployment, server, instance, domain }));
  await prisma.$disconnect();
}

void main();
