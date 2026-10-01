export type AnalyzedProjectType = 'WEB' | 'IOS_NATIVE' | 'UNSUPPORTED';

export type AnalyzedFramework =
  | 'NEXTJS'
  | 'VITE'
  | 'VUE'
  | 'NODE'
  | 'NESTJS'
  | 'IOS_NATIVE'
  | 'EXPO'
  | 'REACT_NATIVE'
  | 'WECHAT_MINIPROGRAM'
  | 'ANDROID'
  | 'UNSUPPORTED';

export type AnalyzedPackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export type DeployableUnitType =
  | 'WEB'
  | 'API'
  | 'ADMIN'
  | 'IOS'
  | 'ANDROID'
  | 'MINI_PROGRAM'
  | 'MOBILE_CROSS_PLATFORM'
  | 'OTHER';

/** @deprecated Prefer AnalyzedDeployableUnit; kept for API compatibility. */
export type DeployableCandidate = {
  path: string;
  kind: 'WEB' | 'IOS_NATIVE' | 'EXPO' | 'REACT_NATIVE' | 'UNSUPPORTED';
  label: string;
  deployable: boolean;
  reason: string;
};

export type AnalyzedDeployableUnit = {
  name: string;
  type: DeployableUnitType;
  rootPath: string;
  framework: AnalyzedFramework;
  packageManager: AnalyzedPackageManager | null;
  installCommand: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  outputPath: string | null;
  port: number | null;
  deployable: boolean;
  confidence: number;
  reason: string;
};

export type ProjectAnalysisResult = {
  projectType: AnalyzedProjectType;
  framework: AnalyzedFramework;
  packageManager: AnalyzedPackageManager | null;
  installCommand: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  port: number | null;
  confidence: number;
  /** @deprecated Prefer `units`. */
  candidates?: DeployableCandidate[];
  units?: AnalyzedDeployableUnit[];
  primaryUnitPath?: string | null;
  summary?: string;
};
