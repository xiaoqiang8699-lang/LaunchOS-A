import { Module } from '@nestjs/common';
import { PrismaModule } from '../database/prisma.module';
import { LifecycleModule } from '../lifecycle/lifecycle.module';
import { ProductAnalyticsService } from './product-analytics.service';
import { GrowthAnalyticsService } from './growth-analytics.service';

@Module({
  imports: [PrismaModule, LifecycleModule],
  providers: [ProductAnalyticsService, GrowthAnalyticsService],
  exports: [ProductAnalyticsService, GrowthAnalyticsService, LifecycleModule],
})
export class AnalyticsModule {}
