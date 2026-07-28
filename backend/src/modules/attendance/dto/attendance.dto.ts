import { ApiProperty } from '@nestjs/swagger';
import { TapSource } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';

export class GeoDto {
  @ApiProperty()
  @IsNumber()
  lat!: number;

  @ApiProperty()
  @IsNumber()
  lng!: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  accuracyM?: number;
}

export class ManualDto {
  @ApiProperty()
  @IsBoolean()
  isBackup!: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  reason?: string;
}

/**
 * The watchman's answer to a refused scan: record it anyway.
 *
 * Lifts both the duplicate cooldown and the safety gap for that one scan. The
 * reason is optional and in practice usually absent — watchmen were being asked
 * to justify a decision they had no vocabulary for, so the prompt was dropped
 * and the confirmation itself is what gets audited.
 */
export class OverrideDto {
  @ApiProperty({ required: false, description: 'Optional note about the override' })
  @IsOptional()
  @IsString()
  reason?: string;
}

export class TapDto {
  @ApiProperty({ description: 'Client-generated UUID v4 — idempotency key' })
  @IsUUID('4')
  eventId!: string;

  @ApiProperty()
  @IsUUID()
  siteId!: string;

  @ApiProperty()
  @IsUUID()
  deviceId!: string;

  @ApiProperty({ enum: TapSource })
  @IsEnum(TapSource)
  source!: TapSource;

  @ApiProperty({ description: 'UID / NDEF workerCode / QR / workerCode' })
  @IsString()
  @IsNotEmpty()
  identifier!: string;

  @ApiProperty({ description: 'Device wall-clock time of the tap (ISO 8601)' })
  @IsISO8601()
  clientEventTime!: string;

  @ApiProperty({ required: false, description: 'Device monotonic clock (ms) for tamper detection' })
  @IsOptional()
  @IsNumber()
  monotonicMs?: number;

  @ApiProperty({ required: false, type: GeoDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => GeoDto)
  geo?: GeoDto;

  @ApiProperty({ required: false, type: ManualDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ManualDto)
  manual?: ManualDto;

  @ApiProperty({ required: false, type: OverrideDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => OverrideDto)
  override?: OverrideDto;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  photoUrl?: string;
}

export class ConfirmDto {
  @ApiProperty()
  @IsUUID('4')
  eventId!: string;
}
