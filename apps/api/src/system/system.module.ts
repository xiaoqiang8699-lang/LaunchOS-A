import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { QueueModule } from '../queue/queue.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { SystemController } from './system.controller';
import { SystemStatusService } from './system-status.service';

@Module({
  imports: [AuthModule, WorkspacesModule, QueueModule],
  controllers: [SystemController],
  providers: [SystemStatusService],
})
export class SystemModule {}
