import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ProviderAccountsController } from './provider-accounts.controller';
import { ProviderAccountsService } from './provider-accounts.service';

@Module({
  imports: [AuthModule, WorkspacesModule],
  controllers: [ProviderAccountsController],
  providers: [ProviderAccountsService],
  exports: [ProviderAccountsService],
})
export class ProviderAccountsModule {}
