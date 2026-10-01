import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateAdminUserDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  displayName?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsIn(['USER', 'PLATFORM_ADMIN'])
  platformRole?: 'USER' | 'PLATFORM_ADMIN';

  @IsOptional()
  @IsIn(['ACTIVE', 'SUSPENDED', 'ARCHIVED'])
  accountStatus?: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  adminNote?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  suspendReason?: string;
}
