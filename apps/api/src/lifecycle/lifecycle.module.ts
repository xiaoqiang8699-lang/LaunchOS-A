import { Module } from '@nestjs/common';
import { PrismaModule } from '../database/prisma.module';
import { LifecycleAutomationService } from './lifecycle-automation.service';

@Module({
  imports: [PrismaModule],
  providers: [LifecycleAutomationService],
  exports: [LifecycleAutomationService],
})
export class LifecycleModule {}
