import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ServicesController } from './services.controller';
import { ServicesService } from './services.service';

@Module({
  imports: [AuthModule, WorkspacesModule],
  controllers: [ServicesController],
  providers: [ServicesService],
})
export class ServicesModule {}
