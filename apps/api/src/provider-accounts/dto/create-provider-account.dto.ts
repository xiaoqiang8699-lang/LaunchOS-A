import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export const MOCK_PROVIDER_TYPE = 'MOCK' as const;
export const ALIYUN_PROVIDER_TYPE = 'ALIYUN' as const;
/** Minimal-privilege DNS credentials for system ACME (separate from ECS). */
export const ALIYUN_DNS_PROVIDER_TYPE = 'ALIYUN_DNS' as const;
export const PROVIDER_TYPES = [
  MOCK_PROVIDER_TYPE,
  ALIYUN_PROVIDER_TYPE,
  ALIYUN_DNS_PROVIDER_TYPE,
] as const;

export class CreateProviderAccountDto {
  @IsIn(PROVIDER_TYPES)
  providerType!: (typeof PROVIDER_TYPES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  region?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  credential?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  accessKey?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  secretKey?: string;
}
