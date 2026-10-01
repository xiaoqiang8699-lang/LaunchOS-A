import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { RedisConnectionsController } from './redis-connections.controller';
import { RedisConnectionsService } from './redis-connections.service';

@Module({
  imports: [AuthModule, WorkspacesModule],
  controllers: [RedisConnectionsController],
  providers: [RedisConnectionsService],
  exports: [RedisConnectionsService],
})
export class RedisConnectionsModule {}
