import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

export class CreateDatabaseProvisionDto {
  @IsIn(['DEV', 'SMALL', 'STANDARD'])
  tier!: 'DEV' | 'SMALL' | 'STANDARD';

  @IsOptional()
  @IsString()
  region?: string;

  @IsOptional()
  @IsString()
  databaseName?: string;

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
}

export class DeleteDatabaseProvisionDto {
  @IsBoolean()
  confirmDestroy!: boolean;
}

export class RetryDatabaseProvisionDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  notes?: string;
}
