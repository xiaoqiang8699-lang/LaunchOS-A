import { IsArray, IsIn, IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';

export class TestRedisConnectionDto {
  @IsString()
  @MinLength(1)
  host!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  port!: number;

  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(64)
  databaseIndex?: number;

  @IsOptional()
  @IsIn(['AUTO', 'REQUIRE', 'DISABLE'])
  tlsMode?: 'AUTO' | 'REQUIRE' | 'DISABLE';

  @IsOptional()
  @IsIn(['CONTROL_PLANE', 'TARGET_SERVER', 'AUTO'])
  testLocation?: 'CONTROL_PLANE' | 'TARGET_SERVER' | 'AUTO';

  @IsOptional()
  @IsString()
  serverInstanceId?: string;
}

export class CreateRedisConnectionDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsString()
  @MinLength(1)
  host!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  port!: number;

  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(64)
  databaseIndex?: number;

  @IsOptional()
  @IsIn(['AUTO', 'REQUIRE', 'DISABLE'])
  tlsMode?: 'AUTO' | 'REQUIRE' | 'DISABLE';

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

export class UpdateRedisConnectionDto {
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
  username?: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(64)
  databaseIndex?: number;

  @IsOptional()
  @IsIn(['AUTO', 'REQUIRE', 'DISABLE'])
  tlsMode?: 'AUTO' | 'REQUIRE' | 'DISABLE';

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
