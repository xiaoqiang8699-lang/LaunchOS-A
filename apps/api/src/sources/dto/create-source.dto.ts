import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { SourceType } from '@launchos/database';

export class CreateSourceDto {
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
}
