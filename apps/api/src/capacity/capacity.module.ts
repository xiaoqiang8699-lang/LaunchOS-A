import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { CapacityGovernanceService } from './capacity-governance.service';

@Module({
  imports: [QueueModule],
  providers: [CapacityGovernanceService],
  exports: [CapacityGovernanceService],
})
export class CapacityModule {}
