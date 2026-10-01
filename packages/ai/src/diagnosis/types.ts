export type DiagnosisCategory =
  | 'BUILD_ERROR'
  | 'DEPENDENCY_ERROR'
  | 'CONFIG_ERROR'
  | 'RUNTIME_ERROR'
  | 'PORT_ERROR'
  | 'DATABASE_ERROR'
  | 'UNKNOWN';

export type DiagnosisSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type DiagnosisIssue = {
  category: DiagnosisCategory;
  severity: DiagnosisSeverity;
  title: string;
  description: string;
  solution: string;
};

export type DiagnosisResult = DiagnosisIssue & {
  fixPrompt: string;
};
