import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { DependenciesModule } from '../dependencies/dependencies.module';
import { AlphaTestsModule } from '../alpha-tests/alpha-tests.module';
import { EnvironmentsModule } from '../environments/environments.module';
import { ManagedHostingModule } from '../managed-hosting/managed-hosting.module';
import { DeploymentsModule } from '../deployments/deployments.module';
import { LaunchController } from './launch.controller';
import { LaunchService } from './launch.service';

@Module({
  imports: [
    AuthModule,
    BillingModule,
    WorkspacesModule,
    DependenciesModule,
    AlphaTestsModule,
    EnvironmentsModule,
    ManagedHostingModule,
    DeploymentsModule,
  ],
  controllers: [LaunchController],
  providers: [LaunchService],
  exports: [LaunchService],
})
export class LaunchModule {}
