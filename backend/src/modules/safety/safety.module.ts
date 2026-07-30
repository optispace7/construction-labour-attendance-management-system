import { Module } from '@nestjs/common';
import { SafetyService } from './safety.service';
import { SafetyController } from './safety.controller';

@Module({
  providers: [SafetyService],
  controllers: [SafetyController],
})
export class SafetyModule {}
