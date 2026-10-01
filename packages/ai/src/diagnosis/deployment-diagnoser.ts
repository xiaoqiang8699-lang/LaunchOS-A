import type { DiagnosisIssue, DiagnosisResult } from './types';

export class DeploymentDiagnoser {
  async analyzeLogs(logs: string): Promise<DiagnosisResult> {
    const issue = this.detectIssue(logs);
    return {
      ...issue,
      fixPrompt: this.generateFixPrompt(issue, logs),
    };
  }

  detectIssue(logs: string): DiagnosisIssue {
    const text = logs.toLowerCase();

    if (text.includes('module not found') || text.includes('cannot find module')) {
      return {
        category: 'DEPENDENCY_ERROR',
        severity: 'HIGH',
        title: 'Module not found',
        description: 'Build logs indicate a missing Node.js dependency.',
        solution: 'Install the missing package and commit the lockfile, then redeploy.',
      };
    }

    if (text.includes('database_url missing') || text.includes('database_url is not set')) {
      return {
        category: 'CONFIG_ERROR',
        severity: 'HIGH',
        title: 'DATABASE_URL missing',
        description: 'The application expected DATABASE_URL but it was not provided.',
        solution: 'Add DATABASE_URL to the environment variables and redeploy.',
      };
    }

    if (text.includes('port error') || text.includes('eaddrinuse') || text.includes('port already')) {
      return {
        category: 'PORT_ERROR',
        severity: 'MEDIUM',
        title: 'Port error',
        description: 'The process failed to bind the configured listen port.',
        solution: 'Choose a free port or stop the process occupying the current port.',
      };
    }

    if (text.includes('container exit') || text.includes('container exited')) {
      return {
        category: 'RUNTIME_ERROR',
        severity: 'CRITICAL',
        title: 'Container exit',
        description: 'The runtime container exited before the service became healthy.',
        solution: 'Inspect container logs, fix the crash, and start the service again.',
      };
    }

    return {
      category: 'UNKNOWN',
      severity: 'MEDIUM',
      title: 'Unclassified deployment failure',
      description: 'The logs did not match a known LaunchOS diagnosis rule.',
      solution: 'Review the deployment logs and failed step output, then retry.',
    };
  }

  generateFixPrompt(issue: DiagnosisIssue, logs = ''): string {
    const excerpt = logs.trim().slice(0, 2000);
    return [
      'LaunchOS deployment diagnosis (review before changing any files).',
      `Category: ${issue.category}`,
      `Severity: ${issue.severity}`,
      `Title: ${issue.title}`,
      `Description: ${issue.description}`,
      `Suggested solution: ${issue.solution}`,
      excerpt ? `Log excerpt:\n${excerpt}` : 'Log excerpt: (empty)',
      'Do not apply this automatically. Do not commit code.',
    ].join('\n');
  }
}
