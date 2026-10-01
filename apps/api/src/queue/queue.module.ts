import { Module } from '@nestjs/common';
import {
  DATABASE_PROVISION_QUEUE,
  REDIS_PROVISION_QUEUE,
  SERVER_PROVISION_QUEUE,
  SERVER_INITIALIZATION_QUEUE,
  DEPLOYMENT_QUEUE,
  SYSTEM_CERT_QUEUE,
  getRedisConnection,
} from '@launchos/shared';
import { BullModule } from '@nestjs/bullmq';
import { DatabaseProvisionQueueService } from './database-provision-queue.service';
import { RedisProvisionQueueService } from './redis-provision-queue.service';
import { ServerProvisionQueueService } from './server-provision-queue.service';
import { ServerInitializationQueueService } from './server-initialization-queue.service';
import { DeploymentQueueService } from './deployment-queue.service';
import { SystemCertQueueService } from './system-cert-queue.service';
import { WorkerPresenceService } from './worker-presence.service';

@Module({
  imports: [
    BullModule.forRoot({
      connection: getRedisConnection(),
    }),
    BullModule.registerQueue({
      name: DEPLOYMENT_QUEUE,
    }),
    BullModule.registerQueue({
      name: SYSTEM_CERT_QUEUE,
    }),
    BullModule.registerQueue({
      name: DATABASE_PROVISION_QUEUE,
    }),
    BullModule.registerQueue({
      name: REDIS_PROVISION_QUEUE,
    }),
    BullModule.registerQueue({
      name: SERVER_PROVISION_QUEUE,
    }),
    BullModule.registerQueue({
      name: SERVER_INITIALIZATION_QUEUE,
    }),
  ],
  providers: [
    DeploymentQueueService,
    SystemCertQueueService,
    WorkerPresenceService,
    DatabaseProvisionQueueService,
    RedisProvisionQueueService,
    ServerProvisionQueueService,
    ServerInitializationQueueService,
  ],
  exports: [
    DeploymentQueueService,
    SystemCertQueueService,
    WorkerPresenceService,
    DatabaseProvisionQueueService,
    RedisProvisionQueueService,
    ServerProvisionQueueService,
    ServerInitializationQueueService,
  ],
})
export class QueueModule {}
