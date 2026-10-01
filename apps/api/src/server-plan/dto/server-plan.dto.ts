import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';

export class UpdateServerPlanDto {
  @IsOptional()
  @IsIn(['DEV', 'STANDARD', 'PRODUCTION'])
  profile?: 'DEV' | 'STANDARD' | 'PRODUCTION';

  @IsOptional()
  @IsString()
  region?: string;

  @IsOptional()
  @IsString()
  zoneId?: string;

  @IsOptional()
  @IsIn(['EXISTING', 'MANAGED_CREATE'])
  source?: 'EXISTING' | 'MANAGED_CREATE';

  @IsOptional()
  @IsString()
  existingServerId?: string;

  /** Demo only: ignore existing ServerInstance without deleting. */
  @IsOptional()
  @IsBoolean()
  simulateNoServer?: boolean;
}
