import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { DatabaseConnectionsModule } from '../database-connections/database-connections.module';
import { RedisConnectionsModule } from '../redis-connections/redis-connections.module';
import { DatabaseProvisionModule } from '../database-provision/database-provision.module';
import { RedisProvisionModule } from '../redis-provision/redis-provision.module';
import { DependenciesController } from './dependencies.controller';
import { DependenciesService } from './dependencies.service';

@Module({
  imports: [
    AuthModule,
    WorkspacesModule,
    DatabaseConnectionsModule,
    RedisConnectionsModule,
    forwardRef(() => DatabaseProvisionModule),
    forwardRef(() => RedisProvisionModule),
  ],
  controllers: [DependenciesController],
  providers: [DependenciesService],
  exports: [DependenciesService],
})
export class DependenciesModule {}
