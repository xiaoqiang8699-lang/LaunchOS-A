import { IsString, MinLength } from 'class-validator';

export class UpsertRuntimeConfigDto {
  @IsString()
  @MinLength(1)
  value!: string;
}
