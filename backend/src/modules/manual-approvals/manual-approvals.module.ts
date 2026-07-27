import { Module } from '@nestjs/common';
import { ManualApprovalsService } from './manual-approvals.service';
import { ManualApprovalsController } from './manual-approvals.controller';

@Module({
  providers: [ManualApprovalsService],
  controllers: [ManualApprovalsController],
})
export class ManualApprovalsModule {}
