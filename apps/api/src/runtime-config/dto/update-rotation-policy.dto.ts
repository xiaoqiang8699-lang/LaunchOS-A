import { IsIn, IsOptional, ValidateIf } from 'class-validator';

const ALLOWED = [30, 60, 90, 180] as const;

export class UpdateRotationPolicyDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsIn(ALLOWED)
  rotationIntervalDays!: number | null;
}
