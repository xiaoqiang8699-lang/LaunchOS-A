import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';

export class ProvisionDependencyDto {
  @IsIn(['EXISTING', 'MANAGED_CREATE'])
  mode!: 'EXISTING' | 'MANAGED_CREATE';

  @IsOptional()
  @IsString()
  provider?: string;

  @IsOptional()
  @IsString()
  connectionId?: string;

  @IsOptional()
  @IsIn(['DEV', 'SMALL', 'STANDARD'])
  tier?: 'DEV' | 'SMALL' | 'STANDARD';

  @IsOptional()
  @IsBoolean()
  confirmBilling?: boolean;

  @IsOptional()
  @IsBoolean()
  confirmedReplaceManual?: boolean;
}

export class ConnectDependencyDto {
  @IsString()
  connectionId!: string;

  @IsOptional()
  @IsBoolean()
  confirmedReplaceManual?: boolean;
}
