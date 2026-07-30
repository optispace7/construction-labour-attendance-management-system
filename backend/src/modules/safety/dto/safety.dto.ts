import { SafetyMetric } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export type SafetyPeriod = 'daily' | 'weekly' | 'monthly';

const METRICS = Object.values(SafetyMetric);

/** YYYY-MM-DD. Date-only on purpose: a safety day is a calendar day. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class SafetyItemDto {
  @IsEnum(SafetyMetric)
  metric!: SafetyMetric;

  /**
   * Null or absent means "not filled in", which the board shows as a blank
   * rather than a zero. Counts cannot be negative.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  value?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string | null;
}

export class SaveDailyDto {
  @IsString()
  siteId!: string;

  @Matches(DATE_RE, { message: 'date must be YYYY-MM-DD' })
  date!: string;

  @IsArray()
  // One post covers one day's board; the catalogue is the natural ceiling.
  @ArrayMaxSize(METRICS.length)
  @ValidateNested({ each: true })
  @Type(() => SafetyItemDto)
  items!: SafetyItemDto[];
}

export class UpsertMetricDto {
  @IsString()
  siteId!: string;

  @Matches(DATE_RE, { message: 'date must be YYYY-MM-DD' })
  date!: string;

  @IsEnum(SafetyMetric)
  metric!: SafetyMetric;

  @IsOptional()
  @IsInt()
  @Min(0)
  value?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string | null;
}
