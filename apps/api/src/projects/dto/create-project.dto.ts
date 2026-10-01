import { ApplicationPurpose, ProjectType, SourceType } from '@launchos/database';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class CreateProjectSourceDto {
  @IsEnum(SourceType)
  type!: SourceType;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  url!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  branch?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  connectionId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  providerRepositoryId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  fullName?: string;

  @IsOptional()
  @IsBoolean()
  isPrivate?: boolean;
}

export class CreateProjectDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsEnum(ProjectType)
  type?: ProjectType;

  @IsOptional()
  @IsEnum(ApplicationPurpose)
  applicationPurpose?: ApplicationPurpose;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => CreateProjectSourceDto)
  source?: CreateProjectSourceDto;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  sourceType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  sourceUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  framework?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  repositoryUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  defaultBranch?: string;
}
