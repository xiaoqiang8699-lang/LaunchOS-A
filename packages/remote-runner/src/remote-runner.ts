import { createReadStream } from 'node:fs';
import { Client } from 'ssh2';
import type { ConnectConfig } from 'ssh2';
import type {
  RemoteConnectOptions,
  RemoteExecuteOptions,
  RemoteExecuteResult,
  RemoteUploadOptions,
} from './types';

const DEFAULT_READY_TIMEOUT_MS = 20_000;
const DEFAULT_EXECUTE_TIMEOUT_MS = 120_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;

export class RemoteRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteRunnerError';
  }
}

export class RemoteRunner {
  private client: Client | null = null;

  async connect(options: RemoteConnectOptions): Promise<void> {
    await this.disconnect();

    const host = options.host.trim();
    const username = options.username.trim();
    const password = options.password;
    if (!host || !username || !password) {
      throw new RemoteRunnerError('SSH host, username and password are required');
    }

    const config: ConnectConfig = {
      host,
      port: options.port ?? 22,
      username,
      password,
      readyTimeout: options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      keepaliveInterval: 10_000,
      keepaliveCountMax: 6,
    };

    const client = new Client();
    this.client = client;

    // Attach before connect so handshake failures cannot crash the process.
    client.on('error', (error: Error) => {
      if (this.client === client) {
        this.client = null;
      }
      try {
        client.end();
      } catch {
        // ignore
      }
      console.error('SSH client error', error.message);
    });

    await new Promise<void>((resolve, reject) => {
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        this.client = null;
        try {
          client.end();
        } catch {
          // ignore
        }
        reject(new RemoteRunnerError(error.message));
      };
      const cleanup = () => {
        client.removeListener('ready', onReady);
        client.removeListener('error', onError);
      };

      client.once('ready', onReady);
      client.once('error', onError);
      client.connect(config);
    });
  }

  async execute(command: string, options: RemoteExecuteOptions = {}): Promise<RemoteExecuteResult> {
    const client = this.requireClient();
    const timeoutMs = options.timeoutMs ?? DEFAULT_EXECUTE_TIMEOUT_MS;

    return new Promise<RemoteExecuteResult>((resolve, reject) => {
      let settled = false;
      let stdout = '';
      let stderr = '';

      const timer = setTimeout(() => {
        finish(new RemoteRunnerError(`SSH command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const finish = (error?: Error, result?: RemoteExecuteResult) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (error) {
          reject(error);
          return;
        }
        if (!result) {
          reject(new RemoteRunnerError('SSH command completed without a result'));
          return;
        }
        resolve(result);
      };

      client.exec(command, (error, stream) => {
        if (error) {
          finish(new RemoteRunnerError(error.message));
          return;
        }

        stream.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
        stream.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        stream.on('close', (code: number | undefined) => {
          finish(undefined, {
            stdout,
            stderr,
            exitCode: code ?? 1,
          });
        });
        stream.on('error', (streamError: Error) => {
          finish(new RemoteRunnerError(streamError.message));
        });
      });
    });
  }

  async upload(localPath: string, remotePath: string, options: RemoteUploadOptions = {}): Promise<void> {
    const client = this.requireClient();
    const source = localPath.trim();
    const destination = remotePath.trim();
    if (!source || !destination) {
      throw new RemoteRunnerError('upload localPath and remotePath are required');
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new RemoteRunnerError(`上传超时（超过 ${Math.round(timeoutMs / 60000)} 分钟）`));
      }, timeoutMs);
    });

    try {
      await Promise.race([
        (async () => {
          try {
            options.onProgress?.('sftp');
            await this.uploadWithSftp(client, source, destination);
          } catch {
            options.onProgress?.('shell');
            await this.uploadWithShell(client, source, destination);
          }
        })(),
        timeout,
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Download a remote file via SFTP. Contents are never logged.
   */
  async download(remotePath: string, localPath: string, options: RemoteUploadOptions = {}): Promise<void> {
    const client = this.requireClient();
    const source = remotePath.trim();
    const destination = localPath.trim();
    if (!source || !destination) {
      throw new RemoteRunnerError('download remotePath and localPath are required');
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new RemoteRunnerError(`下载超时（超过 ${Math.round(timeoutMs / 60000)} 分钟）`));
      }, timeoutMs);
    });

    try {
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          client.sftp((error, sftp) => {
            if (error || !sftp) {
              reject(new RemoteRunnerError(error?.message || 'SFTP unavailable'));
              return;
            }
            options.onProgress?.('sftp');
            sftp.fastGet(source, destination, (getError) => {
              sftp.end();
              if (getError) {
                reject(new RemoteRunnerError(getError.message));
                return;
              }
              resolve();
            });
          });
        }),
        timeout,
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Write a remote text file via SFTP (chmod 600). Contents are never logged.
   */
  async writeTextFile(remotePath: string, content: string, mode = 0o600): Promise<void> {
    const destination = remotePath.trim();
    if (!destination) {
      throw new RemoteRunnerError('writeTextFile remotePath is required');
    }
    const client = this.requireClient();
    await new Promise<void>((resolve, reject) => {
      client.sftp((error, sftp) => {
        if (error || !sftp) {
          reject(new RemoteRunnerError(error?.message || 'SFTP unavailable'));
          return;
        }
        const stream = sftp.createWriteStream(destination, {
          mode,
          flags: 'w',
        });
        stream.on('error', (writeError: Error) => {
          sftp.end();
          reject(new RemoteRunnerError(writeError.message));
        });
        stream.on('close', () => {
          sftp.end();
          resolve();
        });
        stream.end(content, 'utf8');
      });
    });
  }

  private uploadWithSftp(client: Client, source: string, destination: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      client.sftp((error, sftp) => {
        if (error) {
          reject(new RemoteRunnerError(error.message));
          return;
        }

        sftp.fastPut(source, destination, (putError) => {
          sftp.end();
          if (putError) {
            reject(new RemoteRunnerError(putError.message));
            return;
          }
          resolve();
        });
      });
    });
  }

  private uploadWithShell(client: Client, source: string, destination: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const command = `sh -c ${JSON.stringify(`cat > ${destination}`)}`;
      client.exec(command, (error, stream) => {
        if (error) {
          reject(new RemoteRunnerError(error.message));
          return;
        }

        let settled = false;
        let stderr = '';
        const finish = (err?: Error) => {
          if (settled) {
            return;
          }
          settled = true;
          if (err) {
            reject(err);
            return;
          }
          resolve();
        };

        stream.on('data', () => undefined);
        stream.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        stream.on('exit', (code: number | undefined) => {
          if ((code ?? 1) === 0) {
            finish();
            return;
          }
          finish(new RemoteRunnerError(stderr.trim() || 'SSH upload failed'));
        });
        stream.on('close', () => {
          finish();
        });
        stream.on('error', (streamError: Error) => {
          finish(new RemoteRunnerError(streamError.message));
        });

        const reader = createReadStream(source);
        reader.on('error', (readError) => {
          finish(new RemoteRunnerError(readError.message));
        });
        reader.on('end', () => {
          stream.end();
        });
        reader.pipe(stream, { end: false });
      });
    });
  }

  async disconnect(): Promise<void> {
    const client = this.client;
    if (!client) {
      return;
    }
    this.client = null;
    await new Promise<void>((resolve) => {
      client.end();
      client.once('close', () => resolve());
      setTimeout(resolve, 1000);
    });
  }

  private requireClient(): Client {
    if (!this.client) {
      throw new RemoteRunnerError('RemoteRunner is not connected');
    }
    return this.client;
  }
}
