import { ApiProperty, PartialType } from '@nestjs/swagger';
import { CredentialKind, PersonCategory, WorkerStatus } from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
} from 'class-validator';

export class CreateWorkerDto {
  @ApiProperty({ required: false, description: 'Auto-generated when omitted (W-/S-/V- prefix)' })
  @IsOptional()
  @IsString()
  @Length(1, 40)
  workerCode?: string;

  @ApiProperty({
    required: false,
    enum: PersonCategory,
    description: 'WORKER (default) | STAFF | VISITOR',
  })
  @IsOptional()
  @IsEnum(PersonCategory)
  category?: PersonCategory;

  @ApiProperty({ required: false, description: 'Designation id (see /designations)' })
  @IsOptional()
  @IsString()
  designationId?: string;

  @ApiProperty()
  @IsString()
  @Length(2, 120)
  fullName!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  fatherName?: string;

  @ApiProperty({ required: false, description: 'M / F / OTHER' })
  @IsOptional()
  @IsString()
  gender?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  language?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  pincode?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  nomineeName?: string;

  @ApiProperty({ required: false, description: 'Relation to nominee, e.g. Wife' })
  @IsOptional()
  @IsString()
  nomineeRelation?: string;

  @ApiProperty({ required: false, description: 'Nature of contractor / work, e.g. D&B' })
  @IsOptional()
  @IsString()
  natureOfContractor?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  bankName?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  bankAccountNumber?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  ifscCode?: string;

  @ApiProperty({ required: false, description: 'Government ID type, e.g. Aadhaar' })
  @IsOptional()
  @IsString()
  govIdType?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  mobileNumber?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  bloodGroup?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  emergencyContactName?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  emergencyContactNumber?: string;

  @ApiProperty({
    required: false,
    description: 'Date screening/medical was done (printed on the ID card)',
  })
  @IsOptional()
  @IsDateString()
  screeningDoneOn?: string;

  @ApiProperty({ required: false, description: 'Who carried out the screening (free text)' })
  @IsOptional()
  @IsString()
  screeningDoneBy?: string;

  @ApiProperty({
    required: false,
    description: 'Date safety induction was done (printed on the ID card)',
  })
  @IsOptional()
  @IsDateString()
  inductionDoneOn?: string;

  @ApiProperty({ required: false, description: 'Who carried out the induction (free text)' })
  @IsOptional()
  @IsString()
  inductedBy?: string;

  @ApiProperty({ required: false, description: 'ID card validity end date' })
  @IsOptional()
  @IsDateString()
  validityTill?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  vendorId?: string;

  /**
   * The site this person works at. Required, and required here rather than only
   * in the forms: somebody registered without one belongs to no site, which
   * means they are missing from the Safety Officer's list — and from the
   * offline cache that list fills, so they cannot be scanned at all once the
   * tablet loses signal. Two people were created that way before this was
   * enforced, and neither was noticed until somebody went looking for them.
   *
   * UpdateWorkerDto makes every field optional again, so editing somebody is
   * unaffected; moving them between sites has its own endpoint.
   */
  @ApiProperty({ description: 'Site this person works at' })
  // A UUID rather than any string: it rejects blank and whitespace, and turns
  // a junk id into a clear 400 instead of a foreign-key failure at insert time.
  @IsUUID(undefined, { message: 'Pick the site this person works at' })
  siteId!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  pfNumber?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  esiNumber?: string;

  @ApiProperty({
    required: false,
    description: 'Government ID number (e.g. Aadhaar); encrypted at rest, never returned',
  })
  @IsOptional()
  @Matches(/^[0-9 ]{6,24}$/, { message: 'ID number must be 6-24 digits/spaces' })
  aadhaar?: string;

  @ApiProperty({
    required: false,
    description: 'PAN card number (ABCDE1234F); encrypted at rest, never returned',
  })
  @IsOptional()
  @Matches(/^[A-Za-z]{5}[0-9]{4}[A-Za-z]$/, { message: 'PAN must look like ABCDE1234F' })
  pan?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  joinDate?: string;

  @ApiProperty({ required: false, description: 'Visitor escort (mandatory for VISITOR)' })
  @IsOptional()
  @IsString()
  @Length(2, 120)
  escortName?: string;

  @ApiProperty({ required: false, description: "Visitor's company (free text)" })
  @IsOptional()
  @IsString()
  visitorCompany?: string;

  @ApiProperty({
    required: false,
    description: 'PhotoBlob id of the visitor ID-proof image (optional)',
  })
  @IsOptional()
  @IsString()
  idProofPhotoId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiProperty({ required: false, description: 'NFC tag UID' })
  @IsOptional()
  @IsString()
  nfcUid?: string;

  @ApiProperty({ required: false, description: 'Opaque QR identifier (not PII)' })
  @IsOptional()
  @IsString()
  qrIdentifier?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  photoUrl?: string;

  @ApiProperty({
    required: false,
    description:
      'PhotoBlob id of the Aadhaar front image (upload via POST /files kind=AADHAAR_FRONT)',
  })
  @IsOptional()
  @IsString()
  aadhaarFrontPhotoId?: string;

  @ApiProperty({
    required: false,
    description: 'PhotoBlob id of the Aadhaar back image (optional)',
  })
  @IsOptional()
  @IsString()
  aadhaarBackPhotoId?: string;
}

export class UpdateWorkerDto extends PartialType(CreateWorkerDto) {
  @ApiProperty({ required: false, enum: WorkerStatus })
  @IsOptional()
  @IsEnum(WorkerStatus)
  status?: WorkerStatus;
}

export class BindCredentialDto {
  @ApiProperty({ enum: CredentialKind })
  @IsEnum(CredentialKind)
  kind!: CredentialKind;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  value!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  reason?: string;
}

export class AssignSiteDto {
  @ApiProperty()
  @IsString()
  siteId!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  vendorId?: string;

  @ApiProperty()
  @IsDateString()
  startDate!: string;
}

export class ExitWorkerDto {
  @ApiProperty()
  @IsDateString()
  exitDate!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  reason?: string;
}

export class RehireWorkerDto {
  @ApiProperty()
  @IsDateString()
  joinDate!: string;

  @ApiProperty()
  @IsString()
  siteId!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  vendorId?: string;
}

/** Bounded so one request cannot ask us to stream the entire org's cards. */
export const MAX_EXPORT_IDS = 500;

export class ExportDocumentsDto {
  @ApiProperty({
    type: [String],
    description: `Worker ids to export (max ${MAX_EXPORT_IDS})`,
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_EXPORT_IDS)
  @IsUUID('4', { each: true })
  ids!: string[];
}
