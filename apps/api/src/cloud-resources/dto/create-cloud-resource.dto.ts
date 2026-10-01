import { CloudResourceType } from '@launchos/database';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateCloudResourceDto {
  @IsOptional()
  @IsEnum(CloudResourceType)
  type?: CloudResourceType;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  region?: string;
}
