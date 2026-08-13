import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

/** Only PDFs for now — the client uploads licences and certificates. */
export const ALLOWED_DOCUMENT_TYPES = ['application/pdf'];

/** Default reminder lead time, in days before the validity date. */
export const DEFAULT_REMIND_DAYS_BEFORE = 10;

/** Longest lead time we accept — a year's notice is already generous. */
export const MAX_REMIND_DAYS_BEFORE = 365;

export class UploadCompanyDocumentDto {
  @ApiProperty({ description: 'The site this document belongs to' })
  @IsUUID(undefined, { message: 'Pick the site this document belongs to' })
  siteId!: string;

  @ApiProperty({ description: 'Base64-encoded PDF bytes (no data: prefix)' })
  @IsString()
  dataBase64!: string;

  @ApiProperty({ enum: ALLOWED_DOCUMENT_TYPES })
  @IsString()
  mimeType!: string;

  @ApiProperty({ description: 'Original file name, e.g. "PF-registration.pdf"' })
  @IsString()
  @Length(1, 260)
  fileName!: string;

  @ApiProperty({
    required: false,
    description: 'Display name. Defaults to the file name without its extension.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 160)
  name?: string;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Validity end date as YYYY-MM-DD. Null/omitted = never expires.',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsISO8601({ strict: true })
  @MaxLength(10)
  validUntil?: string | null;

  @ApiProperty({
    required: false,
    default: DEFAULT_REMIND_DAYS_BEFORE,
    description: 'Days before validUntil to email the reminder.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_REMIND_DAYS_BEFORE)
  remindDaysBefore?: number;
}

/** Everything about a stored document that can still be changed. */
export class UpdateCompanyDocumentDto {
  @ApiProperty({ required: false, description: 'Move the document to another site' })
  @IsOptional()
  @IsUUID(undefined, { message: 'Pick the site this document belongs to' })
  siteId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Length(1, 160)
  name?: string;

  @ApiProperty({ required: false, nullable: true, description: 'YYYY-MM-DD, or null to clear' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsISO8601({ strict: true })
  @MaxLength(10)
  validUntil?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_REMIND_DAYS_BEFORE)
  remindDaysBefore?: number;
}
