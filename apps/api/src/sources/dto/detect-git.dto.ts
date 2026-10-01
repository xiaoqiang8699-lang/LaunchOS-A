import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class DetectGitDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  url!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  branch?: string;
}
