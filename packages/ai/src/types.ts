export type SourceSnapshot = {
  type: string;
  url: string;
  branch: string;
};

export type ProjectAnalysisInput = {
  projectName: string;
  projectType: string;
  source: SourceSnapshot;
};

export type AnalysisResult = {
  runtime: string;
  buildCommand: string;
  startCommand: string;
  port: number;
  findings: string[];
  recommendedConfig: {
    runtime: string;
    buildCommand: string;
    startCommand: string;
    port: number;
    database?: string;
    complexity?: 'simple' | 'database' | 'complex';
  };
};

export type DeploymentPlanDraft = {
  runtime: string;
  buildCommand: string;
  startCommand: string;
  port: number;
  config: AnalysisResult['recommendedConfig'] & {
    findings: string[];
  };
};

export interface AIProvider {
  readonly model: string;
  analyze(input: ProjectAnalysisInput): Promise<AnalysisResult>;
}
