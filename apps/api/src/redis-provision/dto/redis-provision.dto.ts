import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

export class CreateRedisProvisionDto {
  @IsIn(['DEV', 'SMALL', 'STANDARD'])
  tier!: 'DEV' | 'SMALL' | 'STANDARD';

  @IsOptional()
  @IsString()
  region?: string;

  @IsOptional()
  @IsString()
  instanceName?: string;

  @IsArray()
  @IsString({ each: true })
  unitIds!: string[];

  @IsBoolean()
  confirmBilling!: boolean;

  @IsOptional()
  @IsBoolean()
  confirmReplaceManual?: boolean;

  @IsOptional()
  @IsString()
  serverInstanceId?: string;

  /** Prefer resume of an existing FAILED CloudResource instead of creating a new one. */
  @IsOptional()
  @IsString()
  cloudResourceId?: string;
}

export class DeleteRedisProvisionDto {
  @IsBoolean()
  confirmDestroy!: boolean;
}

export class RetryRedisProvisionDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  notes?: string;
}
