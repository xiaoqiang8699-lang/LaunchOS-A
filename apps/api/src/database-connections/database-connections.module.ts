import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { DatabaseConnectionsController } from './database-connections.controller';
import { DatabaseConnectionsService } from './database-connections.service';

@Module({
  imports: [AuthModule, WorkspacesModule],
  controllers: [DatabaseConnectionsController],
  providers: [DatabaseConnectionsService],
  exports: [DatabaseConnectionsService],
})
export class DatabaseConnectionsModule {}
