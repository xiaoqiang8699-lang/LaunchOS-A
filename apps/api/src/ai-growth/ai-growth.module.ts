import { Module } from '@nestjs/common';
import { PrismaModule } from '../database/prisma.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { RuntimeConfigModule } from '../runtime-config/runtime-config.module';
import { AuthModule } from '../auth/auth.module';
import {
  AIProviderRouter,
  HttpAIProvider,
  LocalHeuristicAIProvider,
} from './ai-provider';
import {
  AIGrowthService,
  AIUserInsightService,
  DeploymentInsightService,
  UpgradeOpportunityService,
} from './ai-growth.services';
import { AIDeploymentCopilotService } from './ai-deployment-copilot.service';
import { AIDeploymentPreflightService } from './ai-deployment-preflight.service';
import {
  DeploymentKnowledgeService,
  KnowledgeExtractionService,
} from './deployment-knowledge.service';
import { DeploymentKnowledgeController } from './deployment-knowledge.controller';
import { AIDeploymentSuccessOptimizerService } from './ai-deployment-success.service';
import { AIProductRecommendationService } from './ai-product-recommendation.service';
import { UserActivationScoreService } from './user-activation-score.service';
import { ActivationProjectionService } from './activation-projection.service';
import { ActivationBackfillService } from './activation-backfill.service';
import { AIOnboardingOptimizerService } from './ai-onboarding-optimizer.service';
import { ActivationController } from './activation.controller';

@Module({
  imports: [PrismaModule, WorkspacesModule, RuntimeConfigModule, AuthModule],
  controllers: [DeploymentKnowledgeController, ActivationController],
  providers: [
    LocalHeuristicAIProvider,
    HttpAIProvider,
    AIProviderRouter,
    AIGrowthService,
    AIUserInsightService,
    DeploymentInsightService,
    UpgradeOpportunityService,
    DeploymentKnowledgeService,
    KnowledgeExtractionService,
    AIDeploymentCopilotService,
    AIDeploymentPreflightService,
    AIProductRecommendationService,
    AIDeploymentSuccessOptimizerService,
    UserActivationScoreService,
    ActivationProjectionService,
    ActivationBackfillService,
    AIOnboardingOptimizerService,
  ],
  exports: [
    AIProviderRouter,
    AIGrowthService,
    AIUserInsightService,
    DeploymentInsightService,
    UpgradeOpportunityService,
    DeploymentKnowledgeService,
    KnowledgeExtractionService,
    AIDeploymentCopilotService,
    AIDeploymentPreflightService,
    AIProductRecommendationService,
    AIDeploymentSuccessOptimizerService,
    UserActivationScoreService,
    ActivationProjectionService,
    ActivationBackfillService,
    AIOnboardingOptimizerService,
  ],
})
export class AIGrowthModule {}
