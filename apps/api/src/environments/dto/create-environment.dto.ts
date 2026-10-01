import { IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export const ENVIRONMENT_TYPES = ['development', 'production'] as const;

export type EnvironmentType = (typeof ENVIRONMENT_TYPES)[number];

export class CreateEnvironmentDto {
  @IsIn(ENVIRONMENT_TYPES)
  type!: EnvironmentType;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  name?: string;

  @IsOptional()
  @IsObject()
  variables?: Record<string, string>;
}
