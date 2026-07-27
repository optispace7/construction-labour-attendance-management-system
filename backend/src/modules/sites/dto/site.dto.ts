import { ApiProperty, PartialType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { PhotoVerifyMode, VerificationMode } from '@prisma/client';

export class CreateSiteDto {
  @ApiProperty()
  @IsString()
  @Length(2, 120)
  name!: string;

  @ApiProperty()
  @IsString()
  @Length(1, 40)
  code!: string;

  @ApiProperty({ default: 'Asia/Kolkata' })
  @IsOptional()
  @IsString()
  timezone?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  latitude?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  longitude?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(10)
  geofenceRadiusM?: number;
}

export class UpdateSiteDto extends PartialType(CreateSiteDto) {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateSiteSettingsDto {
  @ApiProperty({ enum: VerificationMode })
  @IsEnum(VerificationMode)
  verificationMode!: VerificationMode;

  @ApiProperty({ default: 10 })
  @IsInt()
  @Min(0)
  @Max(120)
  autoLoginCountdownSeconds!: number;

  @ApiProperty({ default: 30 })
  @IsInt()
  @Min(0)
  @Max(600)
  duplicateTapCooldownSeconds!: number;

  // Optional so an admin panel still serving the previous bundle during a
  // rollout can save settings without wiping the gap it doesn't know about.
  @ApiProperty({
    default: 10,
    description: 'Minutes before a worker can flip in/out again; 0 = off',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(240)
  safetyGapMinutes?: number;

  @ApiProperty({ default: false })
  @IsBoolean()
  geoEnforcement!: boolean;

  @ApiProperty({ default: 200 })
  @IsInt()
  @Min(10)
  geoRadiusMeters!: number;

  @ApiProperty({ enum: PhotoVerifyMode })
  @IsEnum(PhotoVerifyMode)
  photoVerificationMode!: PhotoVerifyMode;

  @ApiProperty({ default: 20 })
  @IsInt()
  @Min(0)
  @Max(100)
  photoVerificationRandomPct!: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  defaultShiftId?: string;
}

export class CreateShiftDto {
  @ApiProperty()
  @IsString()
  @Length(1, 60)
  name!: string;

  @ApiProperty({ example: '08:00', description: 'Site-local HH:mm' })
  @IsString()
  startTime!: string;

  @ApiProperty({ example: '17:00', description: 'Site-local HH:mm; < start ⇒ overnight' })
  @IsString()
  endTime!: string;

  @ApiProperty({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  lateGraceMinutes?: number;

  @ApiProperty({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  earlyGraceMinutes?: number;

  @ApiProperty({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  otThresholdMinutes?: number;
}

export class UpdateShiftDto extends PartialType(CreateShiftDto) {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
