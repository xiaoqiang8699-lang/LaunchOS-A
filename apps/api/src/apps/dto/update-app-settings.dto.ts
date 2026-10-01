import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class UpdateAppSettingsDto {
  @IsOptional()
  @IsBoolean()
  autoDeployEnabled?: boolean;

  @IsOptional()
  @IsString()
  branch?: string;
}
