export type RemoteConnectOptions = {
  host: string;
  port?: number;
  username: string;
  password: string;
  readyTimeoutMs?: number;
};

export type RemoteExecuteResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type RemoteExecuteOptions = {
  timeoutMs?: number;
};

export type RemoteUploadOptions = {
  timeoutMs?: number;
  onProgress?: (phase: 'sftp' | 'shell') => void;
};
