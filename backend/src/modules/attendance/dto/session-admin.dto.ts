import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

/**
 * Every repair carries a reason. It is what the audit log shows months later
 * when someone asks why a man's hours changed, so it is required, not optional.
 */
const REASON = {
  required: true,
  description: 'Why this record is being changed — shown in the audit log',
  example: 'W-0034 was not on site; W-0059 worked this shift',
};

export class EditSessionDto {
  @ApiProperty({ required: false, description: 'Move the session to this worker' })
  @IsOptional()
  @IsUUID()
  workerId?: string;

  @ApiProperty({ required: false, description: 'New login instant (ISO 8601)' })
  @IsOptional()
  @IsISO8601()
  loginAt?: string;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'New logout instant (ISO 8601), or null to reopen the session',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsISO8601()
  logoutAt?: string | null;

  @ApiProperty(REASON)
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class DeleteSessionDto {
  @ApiProperty(REASON)
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class BulkReopenDto {
  @ApiProperty({ description: 'The sessions to put back on site' })
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  sessionIds!: string[];

  @ApiProperty({ required: false, description: 'Preview the outcome without writing' })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @ApiProperty(REASON)
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class BulkLogoutDto {
  @ApiProperty({ required: false, description: 'Work date (YYYY-MM-DD); defaults to today' })
  @IsOptional()
  @IsString()
  date?: string;

  @ApiProperty({ description: 'Site-local clock time to stamp, HH:mm', example: '18:05' })
  @IsString()
  @IsNotEmpty()
  time!: string;

  @ApiProperty({ required: false, description: 'Limit to one site' })
  @IsOptional()
  @IsString()
  siteId?: string;

  @ApiProperty({
    required: false,
    description: 'Limit to these sessions; omit to sweep everyone still open',
  })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  sessionIds?: string[];

  @ApiProperty({
    required: false,
    description: 'Stamp the time on the morning after the work date (night shifts)',
  })
  @IsOptional()
  @IsBoolean()
  nextDay?: boolean;

  @ApiProperty({ required: false, description: 'Preview the outcome without writing' })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @ApiProperty(REASON)
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
