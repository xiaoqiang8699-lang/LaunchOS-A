import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { QueueModule } from '../queue/queue.module';
import { ServerProvisionController } from './server-provision.controller';
import { ServerProvisionService } from './server-provision.service';
import { ServerInitializationService } from '../server-initialization/server-initialization.service';

@Module({
  imports: [AuthModule, WorkspacesModule, QueueModule],
  controllers: [ServerProvisionController],
  providers: [ServerProvisionService, ServerInitializationService],
  exports: [ServerProvisionService, ServerInitializationService],
})
export class ServerProvisionModule {}
