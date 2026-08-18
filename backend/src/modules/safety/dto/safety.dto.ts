import { SafetyMetric } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * `custom` is the only one that does not derive its window from the anchor
 * date: it reads `from` and `to` off the query instead. See
 * `SafetyService.customWindow`.
 */
export type SafetyPeriod = 'daily' | 'weekly' | 'monthly' | 'custom';

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

/** One waste type's figure for the day. */
export class WasteItemDto {
  @IsUUID()
  wasteTypeId!: string;

  /**
   * Null or absent removes the row, which is how the sheet clears a line it
   * filled in by mistake. Zero is a recorded zero and stays.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  value?: number | null;
}

/** The longest waste list worth accepting in one save. */
export const MAX_WASTE_TYPES = 100;

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

  /**
   * The waste breakdown for the same day. Absent leaves it alone; present
   * replaces it wholesale, which is what lets the form delete a line.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_WASTE_TYPES)
  @ValidateNested({ each: true })
  @Type(() => WasteItemDto)
  waste?: WasteItemDto[];
}

export class WasteTypeDto {
  /** Long enough for "Construction & demolition debris", short enough to read. */
  @IsString()
  @MaxLength(80)
  name!: string;
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
