export type CommandResult = {
  command: string;
  cwd?: string;
  exitCode: number;
  logs: string;
  stdout: string;
  stderr: string;
  duration: number;
  artifactPath?: string;
  artifactSize?: number;
};

export type CreateContainerOptions = {
  image?: string;
  workdir?: string;
};

export type RunNodeBuildOptions = {
  outputFile?: string;
};

export type HostCommandOptions = {
  command: string;
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
};

export type PackDirectoryOptions = {
  sourcePath: string;
  outputFile: string;
  contentsOnly?: boolean;
  exclude?: string[];
};
