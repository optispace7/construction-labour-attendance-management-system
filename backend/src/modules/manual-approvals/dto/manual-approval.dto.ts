import { ApiProperty } from '@nestjs/swagger';
import { ManualApprovalStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export class ReviewManualDto {
  @ApiProperty({ required: false, description: 'Why it was accepted or declined' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reviewNotes?: string;
}

export class ListManualDto {
  @ApiProperty({ required: false, enum: ManualApprovalStatus })
  @IsOptional()
  @IsEnum(ManualApprovalStatus)
  status?: ManualApprovalStatus;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  siteId?: string;
}
