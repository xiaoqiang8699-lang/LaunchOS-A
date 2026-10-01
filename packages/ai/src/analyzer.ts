import { MockAIProvider } from './providers/mock-ai.provider';
import type {
  AIProvider,
  AnalysisResult,
  DeploymentPlanDraft,
  ProjectAnalysisInput,
} from './types';

export class DeploymentAnalyzer {
  constructor(private readonly provider: AIProvider = new MockAIProvider()) {}

  get model(): string {
    return this.provider.model;
  }

  async analyzeProject(input: ProjectAnalysisInput): Promise<AnalysisResult> {
    const runtime = this.recommendRuntime(input);
    const result = await this.provider.analyze(input);
    return {
      ...result,
      runtime,
      recommendedConfig: {
        ...result.recommendedConfig,
        runtime,
      },
    };
  }

  async generatePlan(analysis: AnalysisResult): Promise<DeploymentPlanDraft> {
    return {
      runtime: analysis.runtime,
      buildCommand: analysis.buildCommand,
      startCommand: analysis.startCommand,
      port: analysis.port,
      config: {
        ...analysis.recommendedConfig,
        findings: analysis.findings,
      },
    };
  }

  recommendRuntime(_input: ProjectAnalysisInput): string {
    return 'node20';
  }
}
