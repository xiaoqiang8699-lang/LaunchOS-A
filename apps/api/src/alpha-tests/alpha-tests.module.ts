import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { AlphaTestsController } from './alpha-tests.controller';
import { AlphaTestsService } from './alpha-tests.service';

@Module({
  imports: [AuthModule, WorkspacesModule],
  controllers: [AlphaTestsController],
  providers: [AlphaTestsService],
  exports: [AlphaTestsService],
})
export class AlphaTestsModule {}
