import { DomainType } from '@launchos/database';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateDomainDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(253)
  domain?: string;

  @IsOptional()
  @IsEnum(DomainType)
  type?: DomainType;

  @IsOptional()
  @IsString()
  @MinLength(1)
  serviceInstanceId?: string;
}
