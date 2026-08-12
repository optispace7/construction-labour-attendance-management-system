import { ApiProperty, OmitType, PartialType } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Length,
  IsUUID,
  Matches,
  ValidateIf,
} from 'class-validator';

export class CreateUserDto {
  @ApiProperty({ enum: UserRole })
  @IsEnum(UserRole)
  role!: UserRole;

  @ApiProperty()
  @IsString()
  @Length(2, 120)
  fullName!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({
    required: false,
    description: 'Login user ID for accounts without email (watchmen)',
  })
  @IsOptional()
  @IsString()
  @Length(3, 60)
  @Matches(/^[a-zA-Z0-9._-]+$/, {
    message: 'username may only contain letters, numbers, dots, dashes and underscores',
  })
  username?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @Length(8, 128)
  password!: string;

  @ApiProperty({
    required: false,
    default: false,
    description:
      'Their attendance corrections apply immediately instead of queueing for ' +
      'approval. Super Admin only — see UsersService.assertCanGrantDirectApply.',
  })
  @IsOptional()
  @IsBoolean()
  canApplyCorrections?: boolean;

  @ApiProperty({ type: [String], required: false, description: 'Site IDs in scope' })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  siteIds?: string[];
}

// email/username are omitted from the base and re-declared below so they can
// accept an explicit null, which means "clear this field".
export class UpdateUserDto extends OmitType(PartialType(CreateUserDto), [
  'email',
  'username',
] as const) {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  // Explicit null clears the field (and frees the handle for reuse); omitting
  // the key leaves it as it is. Both are re-declared here because
  // PartialType(CreateUserDto) would otherwise reject null outright.
  @ApiProperty({ required: false, nullable: true, description: 'null clears the email' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsEmail()
  email?: string | null;

  @ApiProperty({ required: false, nullable: true, description: 'null clears the username' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(3, 60)
  @Matches(/^[a-zA-Z0-9._-]+$/, {
    message: 'username may only contain letters, numbers, dots, dashes and underscores',
  })
  username?: string | null;
}

export class SetSiteScopesDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  siteIds!: string[];
}
