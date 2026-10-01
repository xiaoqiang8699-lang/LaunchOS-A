import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseConnectionsModule } from '../database-connections/database-connections.module';
import { ProviderAccountsModule } from '../provider-accounts/provider-accounts.module';
import { QueueModule } from '../queue/queue.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { DatabaseProvisionController } from './database-provision.controller';
import { DatabaseProvisionService } from './database-provision.service';

@Module({
  imports: [
    AuthModule,
    WorkspacesModule,
    ProviderAccountsModule,
    DatabaseConnectionsModule,
    QueueModule,
  ],
  controllers: [DatabaseProvisionController],
  providers: [DatabaseProvisionService],
  exports: [DatabaseProvisionService],
})
export class DatabaseProvisionModule {}
