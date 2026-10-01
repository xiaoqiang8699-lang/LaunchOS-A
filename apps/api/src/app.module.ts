import { Module } from '@nestjs/common';
import { AnalysesModule } from './analyses/analyses.module';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from './database/prisma.module';
import { HealthModule } from './health/health.module';
import { CloudResourcesModule } from './cloud-resources/cloud-resources.module';
import { DeploymentsModule } from './deployments/deployments.module';
import { DomainsModule } from './domains/domains.module';
import { EnvironmentsModule } from './environments/environments.module';
import { ProjectsModule } from './projects/projects.module';
import { ProviderAccountsModule } from './provider-accounts/provider-accounts.module';
import { QueueModule } from './queue/queue.module';
import { ResourceRecommendationsModule } from './resource-recommendations/resource-recommendations.module';
import { ServersModule } from './servers/servers.module';
import { ServicesModule } from './services/services.module';
import { SourcesModule } from './sources/sources.module';
import { SystemDomainModule } from './system-domain/system-domain.module';
import { SystemModule } from './system/system.module';
import { RuntimeConfigModule } from './runtime-config/runtime-config.module';
import { DatabaseConnectionsModule } from './database-connections/database-connections.module';
import { DatabaseProvisionModule } from './database-provision/database-provision.module';
import { RedisProvisionModule } from './redis-provision/redis-provision.module';
import { RedisConnectionsModule } from './redis-connections/redis-connections.module';
import { DependenciesModule } from './dependencies/dependencies.module';
import { ServerPlanModule } from './server-plan/server-plan.module';
import { ServerProvisionModule } from './server-provision/server-provision.module';
import { ServerInitializationModule } from './server-initialization/server-initialization.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { GitHubConnectionsModule } from './github-connections/github-connections.module';
import { DeployableUnitsModule } from './deployable-units/deployable-units.module';
import { LaunchModule } from './launch/launch.module';
import { AlphaTestsModule } from './alpha-tests/alpha-tests.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { AccountModule } from './account/account.module';
import { AdminModule } from './admin/admin.module';

@Module({
  imports: [
    PrismaModule,
    HealthModule,
    AuthModule,
    WorkspacesModule,
    AnalysesModule,
    DeployableUnitsModule,
    ResourceRecommendationsModule,
    ProviderAccountsModule,
    CloudResourcesModule,
    ProjectsModule,
    EnvironmentsModule,
    SourcesModule,
    ServicesModule,
    DomainsModule,
    QueueModule,
    DeploymentsModule,
    ServersModule,
    SystemDomainModule,
    SystemModule,
    RuntimeConfigModule,
    DatabaseConnectionsModule,
    DatabaseProvisionModule,
    RedisConnectionsModule,
    RedisProvisionModule,
    DependenciesModule,
    ServerPlanModule,
    ServerProvisionModule,
    ServerInitializationModule,
    GitHubConnectionsModule,
    LaunchModule,
    AlphaTestsModule,
    OnboardingModule,
    AccountModule,
    AdminModule,
  ],
})
export class AppModule {}
