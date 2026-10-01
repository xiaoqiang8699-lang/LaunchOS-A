import { ApplicationPurpose } from '@launchos/database';
import { IsEnum, IsOptional } from 'class-validator';

export class UpdateProjectDto {
  @IsOptional()
  @IsEnum(ApplicationPurpose)
  applicationPurpose?: ApplicationPurpose;
}
