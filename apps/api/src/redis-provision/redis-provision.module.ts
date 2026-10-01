import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisConnectionsModule } from '../redis-connections/redis-connections.module';
import { ProviderAccountsModule } from '../provider-accounts/provider-accounts.module';
import { QueueModule } from '../queue/queue.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { RedisProvisionController } from './redis-provision.controller';
import { RedisProvisionService } from './redis-provision.service';

@Module({
  imports: [
    AuthModule,
    WorkspacesModule,
    ProviderAccountsModule,
    RedisConnectionsModule,
    QueueModule,
  ],
  controllers: [RedisProvisionController],
  providers: [RedisProvisionService],
  exports: [RedisProvisionService],
})
export class RedisProvisionModule {}
