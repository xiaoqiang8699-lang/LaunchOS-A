import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';

export class CreateServerProvisionDto {
  @IsOptional()
  @IsIn(['MANAGED_CREATE'])
  source?: 'MANAGED_CREATE';

  @IsOptional()
  @IsIn(['DEV', 'STANDARD', 'PRODUCTION'])
  profile?: 'DEV' | 'STANDARD' | 'PRODUCTION';

  @IsBoolean()
  confirmBilling!: boolean;

  @IsOptional()
  @IsString()
  cloudResourceId?: string;
}

export class DestroyServerProvisionDto {
  @IsBoolean()
  confirmDestroy!: boolean;
}
