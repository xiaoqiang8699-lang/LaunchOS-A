import { IsArray, IsIn, IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';

export class TestDatabaseConnectionDto {
  @IsIn(['POSTGRESQL'])
  engine!: 'POSTGRESQL';

  @IsString()
  @MinLength(1)
  host!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  port!: number;

  @IsString()
  @MinLength(1)
  databaseName!: string;

  @IsString()
  @MinLength(1)
  username!: string;

  @IsString()
  @MinLength(1)
  password!: string;

  @IsOptional()
  @IsIn(['AUTO', 'REQUIRE', 'DISABLE'])
  sslMode?: 'AUTO' | 'REQUIRE' | 'DISABLE';

  @IsOptional()
  @IsIn(['CONTROL_PLANE', 'TARGET_SERVER', 'AUTO'])
  testLocation?: 'CONTROL_PLANE' | 'TARGET_SERVER' | 'AUTO';

  @IsOptional()
  @IsString()
  serverInstanceId?: string;
}

export class CreateDatabaseConnectionDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsIn(['POSTGRESQL'])
  engine!: 'POSTGRESQL';

  @IsString()
  @MinLength(1)
  host!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  port!: number;

  @IsString()
  @MinLength(1)
  databaseName!: string;

  @IsString()
  @MinLength(1)
  username!: string;

  @IsString()
  @MinLength(1)
  password!: string;

  @IsOptional()
  @IsIn(['AUTO', 'REQUIRE', 'DISABLE'])
  sslMode?: 'AUTO' | 'REQUIRE' | 'DISABLE';

  @IsArray()
  @IsString({ each: true })
  unitIds!: string[];

  @IsOptional()
  @IsIn(['CONTROL_PLANE', 'TARGET_SERVER', 'AUTO'])
  testLocation?: 'CONTROL_PLANE' | 'TARGET_SERVER' | 'AUTO';

  @IsOptional()
  @IsString()
  serverInstanceId?: string;

  @IsOptional()
  confirmReplaceManual?: boolean;
}

export class UpdateDatabaseConnectionDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  host?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @IsOptional()
  @IsString()
  @MinLength(1)
  databaseName?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  username?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  password?: string;

  @IsOptional()
  @IsIn(['AUTO', 'REQUIRE', 'DISABLE'])
  sslMode?: 'AUTO' | 'REQUIRE' | 'DISABLE';

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  unitIds?: string[];

  @IsOptional()
  @IsIn(['CONTROL_PLANE', 'TARGET_SERVER', 'AUTO'])
  testLocation?: 'CONTROL_PLANE' | 'TARGET_SERVER' | 'AUTO';

  @IsOptional()
  @IsString()
  serverInstanceId?: string;

  @IsOptional()
  confirmReplaceManual?: boolean;
}
