import type { AIProvider, AnalysisResult, ProjectAnalysisInput } from '../types';

type ProjectProfile = 'simple' | 'database' | 'complex';

export class MockAIProvider implements AIProvider {
  readonly model = 'launchos-mock-analyzer-v1';

  async analyze(input: ProjectAnalysisInput): Promise<AnalysisResult> {
    const profile = detectProfile(input);
    const database =
      profile === 'complex' ? 'PostgreSQL + Redis' : profile === 'database' ? 'PostgreSQL' : 'none';

    return {
      runtime: 'node20',
      buildCommand: 'npm run build',
      startCommand: 'npm start',
      port: 3000,
      findings: [
        `Detected source type ${input.source.type}`,
        `Repository ${input.source.url}`,
        `Branch ${input.source.branch}`,
        `Project ${input.projectName} (${input.projectType})`,
        profile === 'complex'
          ? 'Detected PostgreSQL and Redis for a complex workload'
          : profile === 'database'
            ? 'Detected PostgreSQL database requirement'
            : 'Detected simple Node.js project without a database',
      ],
      recommendedConfig: {
        runtime: 'node20',
        buildCommand: 'npm run build',
        startCommand: 'npm start',
        port: 3000,
        database,
        complexity: profile,
      },
    };
  }
}

function detectProfile(input: ProjectAnalysisInput): ProjectProfile {
  const text = `${input.projectName} ${input.source.url} ${input.source.branch}`.toLowerCase();
  if (
    text.includes('complex') ||
    text.includes('redis') ||
    text.includes('production-stack') ||
    text.includes('microservice')
  ) {
    return 'complex';
  }
  if (text.includes('database') || text.includes('postgres') || text.includes('postgresql')) {
    return 'database';
  }
  return 'simple';
}
