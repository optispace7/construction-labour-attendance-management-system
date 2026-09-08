import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { PhotoKind } from '../../../common/enums';

export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const PHOTO_KINDS: PhotoKind[] = ['PROFILE', 'AADHAAR_FRONT', 'AADHAAR_BACK', 'ID_PROOF'];

export class UploadFileDto {
  @ApiProperty({ description: 'Base64-encoded image bytes (no data: prefix)' })
  @IsString()
  dataBase64!: string;

  @ApiProperty({ enum: ALLOWED_IMAGE_TYPES })
  @IsIn(ALLOWED_IMAGE_TYPES)
  mimeType!: string;

  @ApiProperty({
    enum: PHOTO_KINDS,
    required: false,
    description:
      'PROFILE (default) is compressed only; AADHAAR_FRONT/AADHAAR_BACK are compressed AND encrypted at rest.',
  })
  @IsOptional()
  @IsIn(PHOTO_KINDS)
  kind?: PhotoKind;
}
