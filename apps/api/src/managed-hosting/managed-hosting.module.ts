import { Module } from '@nestjs/common';
import { ManagedHostingSchedulerService } from './managed-hosting-scheduler.service';

@Module({
  providers: [ManagedHostingSchedulerService],
  exports: [ManagedHostingSchedulerService],
})
export class ManagedHostingModule {}
