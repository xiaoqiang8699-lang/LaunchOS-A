import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export const HOSTING_MODES = ['launchos', 'my-server'] as const;
export type HostingMode = (typeof HOSTING_MODES)[number];

export const DEPLOYMENT_TARGET_TYPES = ['LOCAL', 'MANAGED_SERVER'] as const;
export type DeploymentTargetTypeDto = (typeof DEPLOYMENT_TARGET_TYPES)[number];

export class CreateDeploymentDto {
  @IsString()
  @IsNotEmpty()
  environmentId!: string;

  @IsOptional()
  @IsString()
  @IsIn(HOSTING_MODES)
  hostingMode?: HostingMode;

  /** Step 27.1 — explicit target; MANAGED_SERVER forbids local Docker fallback. */
  @IsOptional()
  @IsString()
  @IsIn(DEPLOYMENT_TARGET_TYPES)
  targetType?: DeploymentTargetTypeDto;

  @IsOptional()
  @IsString()
  serverInstanceId?: string;

  @IsOptional()
  @IsString()
  deployableUnitId?: string;

  /** Reuse an existing READY BUILD_OUTPUT artifact (must match dry-run selection when set). */
  @IsOptional()
  @IsString()
  selectedArtifactId?: string;

  /** Step 28 — client idempotency key; retries return the same Deployment. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  idempotencyKey?: string;
}
