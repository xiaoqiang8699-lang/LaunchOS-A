export class DeploymentEngineError extends Error {
  readonly code?: string;

  constructor(message: string, options?: { code?: string }) {
    super(message);
    this.name = 'DeploymentEngineError';
    this.code = options?.code;
  }
}
