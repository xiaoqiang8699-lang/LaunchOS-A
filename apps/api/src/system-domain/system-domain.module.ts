import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../database/prisma.module';
import { ProviderAccountsModule } from '../provider-accounts/provider-accounts.module';
import { QueueModule } from '../queue/queue.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { SystemDomainController } from './system-domain.controller';
import { SystemDomainApiService } from './system-domain.service';

@Module({
  imports: [AuthModule, PrismaModule, WorkspacesModule, QueueModule, ProviderAccountsModule],
  controllers: [SystemDomainController],
  providers: [SystemDomainApiService],
  exports: [SystemDomainApiService],
})
export class SystemDomainModule {}
